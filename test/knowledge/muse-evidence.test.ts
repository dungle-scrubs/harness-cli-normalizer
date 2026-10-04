import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { type MuseCompaction, museViewPageOf } from "../../src/interpretation/muse-compaction.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const read = (file: string, dir = "muse-1.4.1"): string =>
  readFileSync(new URL(`../fixtures/${dir}/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(museCode, line, state, "muse-spark-1.3-contributor"));
};

test("current Muse native compaction installs replacements and preserves later recall and failures", () => {
  const current = "muse-1.4.2-R4684.1";
  const records = JSON.parse(read("tool-history-compaction-records.snapshot.json", current));
  for (const trigger of ["hard_threshold_blocking", "soft_threshold_async"]) {
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "context_compaction_candidate",
        trigger,
        status: "succeeded",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "context_compaction_installed", trigger }),
    );
  }
  expect(records).toContainEqual(
    expect.objectContaining({
      kind: "context_compaction_candidate",
      trigger: "soft_threshold_async",
      timing: "mid_turn",
      status: "succeeded",
    }),
  );
  const events = (file: string) =>
    read(file, current)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  expect(events("tool-history-recall.ndjson")).toContainEqual({
    kind: "message",
    role: "assistant",
    text: "MARIGOLD-903",
  });
  expect(events("tool-history-recall.ndjson").at(-1)).toMatchObject({
    kind: "done",
    cause: "clean",
  });
  expect(events("tool-history-soft.ndjson").at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { class: "task", retryable: false },
  });
  expect(events("tool-history-soft.ndjson").at(-1).failure.message).toContain("not converging");
  expect(events("tool-history-threshold.ndjson").at(-1)).toMatchObject({
    kind: "done",
    cause: "crash",
    failure: { class: "native", nativeExitCode: 1 },
  });
  expect(read("build.txt", current).trim()).toBe("1.4.2-R4684.1");
});

test("current MSP attachment initializes and preserves the original missing-limit refusal", () => {
  const lines = read("msp-missing-limit.ndjson", "muse-1.4.2-R4684.1")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines[0].result.serverInfo).toEqual({ name: "muse", version: "1.4.2" });
  expect(lines.find((line) => line.id === "pending").result).toEqual({
    approvals: [],
    userInputs: [],
  });
  expect(lines.find((line) => line.id === "view-0").error).toMatchObject({
    code: -32602,
    message: "invalid view/page params: missing field `limit`",
  });
});

test("Muse's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json", "muse-1.4.2-R4684.1"));
  expect(Object.keys(seven.results.muse)).toHaveLength(7);
  for (const [name, cell] of Object.entries(seven.results.muse)) {
    expect(cell).toMatchObject({ status: name === "session-cont(1proc)" ? "skip" : "pass" });
  }
  const questions = JSON.parse(read("questions.snapshot.json", "muse-1.4.2-R4684.1"));
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
  const [initialize] = read("msp-missing-limit.ndjson", "muse-1.4.2-R4684.1")
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
  // 1.1.1 recorded a rejected hard-threshold replacement; 1.3.0 installed one
  // at the same thresholds, and 1.4.1 re-observes the rejection live (its
  // compaction-records.json carries candidate rejected + fallback), so the
  // 1.1.1 record stays the oldest fallback evidence.
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

// Latest-harness compatibility validation, run on 2026-10-03 against
// build 1.4.2-R4684.1. Historical Muse tests above stay on 1.4.1 by
// default; this block adds current coverage on the named 1.4.2 captures
// without disturbing the 1.4.1 contract. The seven files are the
// 1.4.2 fixtures `bun run smoke:seven` produced; their snapshot says
// every cell is pass (session-cont(1proc) is the intentional skip for
// `sessionMode: null`).

const CURRENT = "muse-1.4.2-R4684.1";
const decodedCurrent = (file: string, dir = CURRENT): HarnessEvent[] => {
  const state = freshDecodeState(null, "muse");
  return read(file, dir)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(museCode, line, state, "muse-spark-1.3-contributor"));
};
const identityOf = (file: string, dir = CURRENT): Extract<HarnessEvent, { kind: "identity" }> => {
  const identity = decodedCurrent(file, dir).find(
    (event): event is Extract<HarnessEvent, { kind: "identity" }> => event.kind === "identity",
  );
  if (identity === undefined) throw new Error(`no identity in ${file}`);
  return identity;
};
const messageText = (file: string, dir = CURRENT): string | null => {
  const message = decodedCurrent(file, dir).find(
    (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
  );
  return message?.text ?? null;
};

test("current 1.4.2 seven captures decode to the named turn outcomes", () => {
  // single-turn: the run produces a token "alpha" and a final assistant
  // message of "alpha". The decoder emits identity once (no requestedId,
  // first session record), then the run_output_delta text and the
  // run_terminal message.
  const single = decodedCurrent("seven-01.ndjson");
  expect(identityOf("seven-01.ndjson").sessionId).toBe("01a10134-76a3-79f0-a7ed-bdad567bda19");
  expect(single).toContainEqual(expect.objectContaining({ kind: "token", text: "alpha" }));
  expect(single).toContainEqual(
    expect.objectContaining({ kind: "message", role: "assistant", text: "alpha" }),
  );

  // streaming: the model counts from one to three and the run emits two
  // run_output_delta tokens that join to "Count is 3." plus the terminal
  // message with the same text.
  const streaming = decodedCurrent("seven-03.ndjson");
  expect(
    streaming
      .filter((event): event is Extract<HarnessEvent, { kind: "token" }> => event.kind === "token")
      .map((event) => event.text)
      .join(""),
  ).toBe("Count is 3.");
  expect(streaming).toContainEqual(
    expect.objectContaining({ kind: "message", role: "assistant", text: "Count is 3." }),
  );

  // tool-use: one bash tool event plus the assistant message reporting
  // its output.
  const toolUse = decodedCurrent("seven-05.ndjson");
  expect(toolUse).toContainEqual(expect.objectContaining({ kind: "tool", name: "bash" }));
  expect(messageText("seven-05.ndjson")).toBe("Output: `seventest`");

  // resume-continuity: seven-09's session id is the one seven-07
  // announced. The current fixture encodes the resumption via
  // `run.model.configured.source: "replay"`, which the decoder drops as
  // a non-identity record - the resumption surfaces only as the
  // repeated session id and the resumed message.
  expect(identityOf("seven-09.ndjson").sessionId).toBe(identityOf("seven-07.ndjson").sessionId);
  expect(messageText("seven-09.ndjson")).toBe("marlin");

  // kill-and-resume: seven-11, seven-13 and seven-15 share the killed
  // session id. seven-13 is the captured kill at 2 events: the decoder
  // sees only the session start, so a non-converging turn is non-
  // converging in the decoded events - no token, no message, no done.
  const killedSession = identityOf("seven-11.ndjson").sessionId;
  expect(identityOf("seven-13.ndjson").sessionId).toBe(killedSession);
  expect(identityOf("seven-15.ndjson").sessionId).toBe(killedSession);
  const killed = decodedCurrent("seven-13.ndjson");
  expect(killed.some((event) => event.kind === "token")).toBe(false);
  expect(killed.some((event) => event.kind === "message")).toBe(false);
  expect(killed.some((event) => event.kind === "error")).toBe(false);
  expect(messageText("seven-15.ndjson")).toBe("otter");
});

test("the current 1.4.2 native question is detected from the assistant turn", () => {
  // The 1.4.2 question stream still ends in a terminal record with the
  // hcn-question block as the run's full text, so detectQuestionBlock
  // must pick it out. The tool use is `bash` and the model self-
  // attests to muse-spark-1.3-contributor (the descriptor's
  // vocabulary.models[0]).
  const question = decodedCurrent("question.ndjson");
  expect(question).toContainEqual(expect.objectContaining({ kind: "tool", name: "bash" }));
  const text = question
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  const block = detectQuestionBlock(text);
  expect(block).not.toBeNull();
  if (block === null || !("block" in block)) throw new Error("Missing current native question");
  expect(typeof block.block.question).toBe("string");
  // Independent check: the question's text starts with the staging vs
  // production conflict the prompt staged, and the options list is
  // exactly the two environments.
  expect(block.block.question).toContain("environment");
  expect(block.block.options).toEqual(["staging", "production"]);
  // Escalation provenance pins the model the harness announced.
  expect(identityOf("question.ndjson").capabilities.escalation.observedOn).toEqual(
    museCode.escalation.observedOn,
  );
});

test("the current HCN helper replays the 13 ordered outcomes through the current MSP adapter", () => {
  const summary = JSON.parse(read("hcn-observer-summary.snapshot.json", CURRENT));
  const seen = new Set<string>();
  const observed: MuseCompaction[] = [];
  for (const line of read("hcn-helper.ndjson", CURRENT).trim().split("\n")) {
    const response = JSON.parse(line);
    const page = museViewPageOf(response.result);
    for (const compaction of page?.compactions ?? []) {
      if (seen.has(compaction.itemId)) continue;
      seen.add(compaction.itemId);
      observed.push(compaction);
    }
  }
  expect(summary).toMatchObject({
    sessionId: "b5f7fa80-a473-48fa-ad5a-8fc7a782cb6e",
    blocked: 0,
    unavailable: 0,
    incompatible: [],
  });
  expect(observed).toHaveLength(13);
  expect(observed).toEqual(summary.compactions);
  expect(
    observed.reduce((counts: Record<string, number>, event) => {
      counts[event.state] = (counts[event.state] ?? 0) + 1;
      return counts;
    }, {}),
  ).toEqual({ compacted: 7, noop: 3, failed: 2, aborted: 1 });
});
