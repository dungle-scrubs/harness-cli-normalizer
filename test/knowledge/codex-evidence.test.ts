import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { codexCli } from "../../src/knowledge/codex.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/codex-0.153.4/${file}`, import.meta.url), "utf8");

const decoded = (file: string, requestedId: string | null = null): HarnessEvent[] => {
  const state = freshDecodeState(requestedId);
  return read(file)
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

test("the native decision response contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});
