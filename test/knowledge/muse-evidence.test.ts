import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { museCode } from "../../src/knowledge/muse.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/muse-1.1.1/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(museCode, line, state, "muse-spark-1.3-contributor"));
};

test("Muse's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.keys(seven.results.muse)).toHaveLength(7);
  for (const [name, cell] of Object.entries(seven.results.muse)) {
    expect(cell).toMatchObject({ status: name === "session-cont(1proc)" ? "skip" : "pass" });
  }
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.muse.status).toBe("pass");
  expect(questions.observations.muse).toEqual(museCode.escalation.observedOn);
  expect(questions.observations.muse.version).toBe(museCode.verifiedAgainst);
  expect(museCode.contextInspection).toBeNull();
  expect(museCode.nativeContextManagement).toEqual({
    kind: "auto-compaction",
    modes: ["headless-turn"],
  });
});

test("native Muse launch, streaming, tools and both kinds of resume still decode", () => {
  const message = (file: string, text: string): void => {
    expect(decoded(file)).toContainEqual(expect.objectContaining({ kind: "message", text }));
  };
  message("01.ndjson", "alpha");
  expect(decoded("02.ndjson").some((event) => event.kind === "token")).toBe(true);
  expect(decoded("03.ndjson").some((event) => event.kind === "tool")).toBe(true);
  message("04.ndjson", "OK");
  message("05.ndjson", "marlin");
  message("06.ndjson", "OK");
  expect(decoded("07.ndjson").some((event) => event.kind === "identity")).toBe(true);
  message("08.ndjson", "otter");
  const text = decoded("question.ndjson")
    .filter((event) => event.kind === "message")
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).not.toBeNull();
});

test("Muse installed automatic compaction and a later process recalled the marker", () => {
  const records = JSON.parse(read("compaction-records.json"));
  expect(records).toContainEqual(
    expect.objectContaining({
      kind: "context_compaction_candidate",
      trigger: "soft_threshold_async",
      status: "succeeded",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      kind: "context_compaction_installed",
      trigger: "soft_threshold_async",
    }),
  );
  const events = read("post-compaction.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events).toContainEqual({ kind: "message", role: "assistant", text: "MARIGOLD-742" });
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
});

test("native compaction failure remains a failure, not successful accounting", () => {
  const records = JSON.parse(read("compaction-records.json"));
  expect(records).toContainEqual(
    expect.objectContaining({
      kind: "context_compaction_candidate",
      trigger: "hard_threshold_blocking",
      status: "rejected",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      kind: "context_compaction_fallback",
      can_continue: false,
      reason: "hard_threshold_failed",
    }),
  );
});
