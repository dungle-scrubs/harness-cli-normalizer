import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  type ContentEvent,
  contentEventsWithState,
  freshCursorReaderState,
} from "../../src/interpretation/content.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const evidence = JSON.parse(
  readFileSync(
    new URL("../../.evidence/address-open-tickets/cursor-access.json", import.meta.url),
    "utf8",
  ),
);

for (const [file, name] of [
  ["cursor-2026.10.01-e373342/access-read.ndjson", "read"],
  ["cursor-2026.10.01-e373342/access-write.ndjson", "write"],
  ["cursor-2026.10.12-d47ca18/access-write.ndjson", "write-current"],
]) {
  test(`native Cursor ${name} capture preserves complete results and usage`, () => {
    const rows = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let state = freshCursorReaderState();
    const events: ContentEvent[] = [];
    for (const row of rows) {
      const next = contentEventsWithState("cursor", row, state);
      events.push(...next.events);
      if (next.state) state = next.state;
    }
    const results = events.filter((e) => e.kind === "tool-result");
    for (const native of rows.filter((r) => r.type === "tool_call" && r.subtype === "completed")) {
      const callName = Object.keys(native.tool_call).find((key) => key.endsWith("ToolCall"));
      if (!callName) throw new Error("missing native call");
      expect(results).toContainEqual({
        kind: "tool-result",
        name: callName,
        callId: native.call_id,
        result: native.tool_call[callName].result,
        isError: false,
      });
    }
    expect(results).toHaveLength(
      rows.filter((r) => r.type === "tool_call" && r.subtype === "completed").length,
    );
    const usage = rows.find((r) => r.type === "result").usage;
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        inputIncludesCache: false,
      },
    ]);
    const observation = evidence.find((row: { name: string }) => row.name === name);
    expect(observation).toMatchObject({ status: 0, timedOut: false });
    if (name === "read") {
      expect(observation).toMatchObject({
        seed: "CURSOR-ACCESS-MARKER\n",
        insideFile: false,
        shellFile: false,
        outsideFile: false,
      });
      expect(results.every((result) => result.name === "readToolCall")).toBe(true);
    } else {
      expect(observation).toMatchObject({
        shellFile: true,
        outsideFile: true,
        flags: ["--force", "--sandbox", "enabled"],
      });
      expect(results.some((result) => result.name === "shellToolCall")).toBe(true);
    }
  });
}

test("supplemental access probes do not silently advance the descriptor anchor", () => {
  expect(cursorCli.verifiedAgainst).toBe("2026.10.01-e373342");
  expect(evidence.find((row: { name: string }) => row.name === "read").version).toBe(
    cursorCli.verifiedAgainst,
  );
});
