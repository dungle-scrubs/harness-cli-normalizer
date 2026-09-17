import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const read = (file: string, dir = "muse-1.3.0"): string =>
  readFileSync(new URL(`../fixtures/${dir}/${file}`, import.meta.url), "utf8");

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
      trigger: "hard_threshold_blocking",
      status: "succeeded",
    }),
  );
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

test("the approval observer's MSP helper answers on the verified Muse", () => {
  const [initialize] = read("list-pending.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(initialize.result.serverInfo).toEqual({ name: "muse", version: museCode.verifiedAgainst });
});

test("only muse declares a pending-approval observer (issue #179)", () => {
  // muse exec omits pending approvals from stdout, so the runner observes
  // them through the read-only MSP listPending operation. No other
  // harness needs (or has) that channel.
  expect(museCode.approvalObserver).toBe("msp-list-pending");
  expect(claudeCode.approvalObserver).toBeUndefined();
  expect(codexCli.approvalObserver).toBeUndefined();
  expect(piCli.approvalObserver).toBeUndefined();
  expect(cursorCli.approvalObserver).toBeUndefined();
});

test("native compaction failure remains a failure, not successful accounting", () => {
  // 1.1.1 recorded a rejected hard-threshold replacement; 1.3.0 installs one
  // at the same thresholds, so that record stays the fallback evidence.
  const records = JSON.parse(read("compaction-records.json", "muse-1.1.1"));
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

test("a threshold the startup prompt already exceeds stays a native failure", () => {
  const events = read("threshold-failure.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events).toContainEqual(
    expect.objectContaining({ kind: "failure", class: "native", nativeExitCode: 1 }),
  );
  expect(events.some((event) => event.kind === "message")).toBe(false);
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "crash" });
  expect(events.at(-1).failure.message).toContain("reaches hard threshold");
});
