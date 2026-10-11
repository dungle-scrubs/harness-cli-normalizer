import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { piCli } from "../../src/knowledge/pi.js";

const readHistorical = (file: string): string =>
  readFileSync(new URL(`../fixtures/pi-1.0.0/${file}`, import.meta.url), "utf8");

const readCurrent = (file: string): string =>
  readFileSync(new URL(`../fixtures/pi-1.1.0/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null);
  return readHistorical(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(piCli, line, state, "openai-codex/gpt-6.1-sol"));
};

test("pi's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(readCurrent("seven.snapshot.json"));
  expect(Object.values(seven.results.pi)).toHaveLength(7);
  for (const cell of Object.values(seven.results.pi))
    expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(readCurrent("questions.snapshot.json"));
  expect(questions.results.pi.status).toBe("pass");
  expect(questions.observations.pi).toEqual(piCli.escalation.observedOn);
  expect(questions.observations.pi.version).toBe(piCli.verifiedAgainst);
  const source = JSON.parse(readCurrent("version-source.snapshot.json"));
  expect(source.version).toBe(piCli.verifiedAgainst);
  expect(source.versionSource).toEqual(piCli.versionSource);
  expect(source.versionSource).toEqual({
    kind: "npm",
    package: "@earendil-works/pi-coding-agent",
  });
});

// The 0.85.1 anchor needed a second question run: a locally installed pi
// extension queued a follow-up and pushed the turn past the runner's
// 90-second deadline. That was local configuration, and its first-attempt
// snapshot stays in test/fixtures/pi-0.85.1. The 0.86.1 and 0.87.0 runs
// passed on the first attempt.

test("historical pi 1.0.0 major-release evidence decodes identity, tokens and the final message", () => {
  const events = decoded("fresh.ndjson");
  expect(events.some((event) => event.kind === "identity")).toBe(true);
  expect(events.some((event) => event.kind === "token")).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ kind: "message", text: "alpha" }));
});

test("historical pi 1.0.0 major-release decision evidence contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});
