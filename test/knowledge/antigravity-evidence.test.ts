import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { detectQuestionBlock } from "../../src/interpretation/question.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/antigravity-1.2.10/${file}`, import.meta.url), "utf8");

const decoded = (file: string): HarnessEvent[] => {
  const state = freshDecodeState(null, antigravityCli.name);
  return read(file)
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(antigravityCli, line, state, "gemini-3.8-flash-medium"));
};

test("antigravity's verification anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.values(seven.results.antigravity)).toHaveLength(7);
  for (const cell of Object.values(seven.results.antigravity))
    expect(cell).toMatchObject({ status: "pass" });
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.antigravity.status).toBe("pass");
  expect(questions.observations.antigravity).toEqual(antigravityCli.escalation.observedOn);
  expect(questions.observations.antigravity.version).toBe(antigravityCli.verifiedAgainst);
});

test("a native antigravity turn still decodes identity, tokens and the final message", () => {
  const events = decoded("fresh.ndjson");
  expect(events.some((event) => event.kind === "identity")).toBe(true);
  expect(events.some((event) => event.kind === "token")).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ kind: "message", text: "alpha\n" }));
});

test("the native antigravity decision response contains a valid escalation block", () => {
  const text = decoded("question.ndjson")
    .filter(
      (event): event is Extract<HarnessEvent, { kind: "message" }> => event.kind === "message",
    )
    .map((event) => event.text)
    .join("\n");
  expect(detectQuestionBlock(text)).toMatchObject({ block: { question: expect.any(String) } });
});
