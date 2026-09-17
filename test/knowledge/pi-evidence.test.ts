import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { piCli } from "../../src/knowledge/pi.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/pi-0.85.1/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(piCli, line, state, "zai/glm-5.2"));
};

test("pi's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.values(seven.results.pi)).toHaveLength(7);
  for (const cell of Object.values(seven.results.pi))
    expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.pi.status).toBe("pass");
  expect(questions.observations.pi).toEqual(piCli.escalation.observedOn);
  expect(questions.observations.pi.version).toBe(piCli.verifiedAgainst);
});

test("the first question attempt failed on the runner deadline, not on a missing question", () => {
  const first = JSON.parse(read("questions-first-attempt.snapshot.json"));
  expect(first.results.pi).toEqual({
    status: "fail",
    detail: "question present but done.cause=killed",
  });
});

test("a native pi turn still decodes identity, tokens and the final message", () => {
  const events = decoded("fresh.ndjson");
  expect(events.some((event) => event.kind === "identity")).toBe(true);
  expect(events.some((event) => event.kind === "token")).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ kind: "message", text: "alpha" }));
});

test("the native pi decision response contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});
