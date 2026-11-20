import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const fixture = (path: string): string =>
  readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");

test("Haiku 5.5 native output attests the selected model and decodes the reply", () => {
  const lines = fixture("claude-2.1.296/haiku-5-5.ndjson").trim().split("\n");
  const native = lines.map((line) => JSON.parse(line));
  const assistants = native.filter((record) => record.type === "assistant");
  expect(assistants.length).toBeGreaterThan(0);
  for (const record of assistants) {
    expect(record.message.model).toBe("claude-haiku-5-5");
  }
  expect(native.at(-1)).toMatchObject({
    type: "result",
    is_error: false,
    result: "alpha",
    modelUsage: { "claude-haiku-5-5": { canonicalModel: "claude-haiku-5-5" } },
  });
  expect(claudeCode.vocabulary.models).toContain("claude-haiku-5-5");
  expect(claudeCode.vocabulary.aliases.haiku).toBe("claude-haiku-5-5");
  const seven = JSON.parse(fixture("claude-2.1.296/haiku-seven.snapshot.json"));
  const cells = Object.values(seven.results.claude);
  expect(cells).toHaveLength(7);
  for (const cell of cells) expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(fixture("claude-2.1.296/haiku-questions.snapshot.json"));
  expect(questions.results.claude).toMatchObject({
    status: "pass",
    observedOn: { model: "claude-haiku-5-5", version: "2.1.296", date: "2026-10-11" },
  });
  const state = freshDecodeState(null, "claude");
  const events = lines.flatMap((line) => decodeLine(claudeCode, line, state, "claude-haiku-5-5"));
  expect(events).toContainEqual({ kind: "message", role: "assistant", text: "alpha" });
  expect(events.some((event) => event.kind === "failure" || event.kind === "error")).toBe(false);
});
