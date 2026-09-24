import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { codexCli } from "../../src/knowledge/codex.js";

const read = (file: string, dir = "codex-0.156.1"): string =>
  readFileSync(new URL(`../fixtures/${dir}/${file}`, import.meta.url), "utf8");

const decoded = (
  file: string,
  requestedId: string | null = null,
  dir = "codex-0.156.1",
): HarnessEvent[] => {
  const state = freshDecodeState(requestedId);
  return read(file, dir)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(codexCli, line, state, "gpt-6-astra"));
};

test("the Codex verified version has passing capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  const cells = Object.values(seven.results.codex);
  expect(cells).toHaveLength(7);
  for (const name of [
    "single-turn",
    "tool-use",
    "resume-continuity",
    "kill-and-resume",
    "error-prop",
  ])
    expect(seven.results.codex[name]).toMatchObject({ status: "pass" });
  for (const name of ["streaming", "session-cont(1proc)"])
    expect(seven.results.codex[name]).toMatchObject({ status: "skip" });
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.codex.status).toBe("pass");
  expect(questions.observations.codex).toEqual(codexCli.escalation.observedOn);
  expect(questions.observations.codex.version).toBe(codexCli.verifiedAgainst);
});

test("native fresh and tool events still decode on the verified Codex CLI", () => {
  expect(decoded("fresh.ndjson")).toContainEqual(
    expect.objectContaining({ kind: "message", text: "alpha" }),
  );
  expect(decoded("tool.ndjson").some((event) => event.kind === "tool")).toBe(true);
});

test("native resume retains the announced session and recalls its earlier prompt", () => {
  const identity = decoded("establish.ndjson").find((event) => event.kind === "identity");
  if (identity?.kind !== "identity") throw new Error("Missing captured identity");
  const resumed = decoded("resume.ndjson", identity.sessionId);
  expect(resumed).toContainEqual(
    expect.objectContaining({ kind: "identity", sessionId: identity.sessionId }),
  );
  expect(resumed).toContainEqual(expect.objectContaining({ kind: "message", text: "marlin" }));
  expect(resumed.some((event) => event.kind === "error")).toBe(false);
});

test("native automatic compaction installs replacement history and a later process recalls", () => {
  const records = JSON.parse(read("compaction-rollout-records.json"));
  // 0.156.1 carries each compaction as an `item_completed` record whose
  // item is a bare ContextCompaction reference: id and type, no encrypted
  // summary and no token counts, unlike 0.155.1's `compacted` payloads.
  expect(records).toHaveLength(4);
  for (const record of records)
    expect(record).toMatchObject({
      payload_type: "item_completed",
      item_type: "ContextCompaction",
    });
  const events = (file: string): Record<string, unknown>[] =>
    read(file)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  for (const file of ["compaction-recall.ndjson", "post-compaction.ndjson"]) {
    expect(events(file)).toContainEqual({ kind: "message", role: "assistant", text: "HERON-519" });
    expect(events(file).at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
  }
});

// The 0.155.1 question run answered without reading any local file, so its
// own raw stream is the decoding evidence. The 0.154.0 run could not be kept
// for this: the model read a local skill file into its native output.
test("the native decision response contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});
