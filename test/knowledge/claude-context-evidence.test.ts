import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contextInspectionOf } from "../../src/interpretation/context-inspection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/claude-2.1.263/${file}`, import.meta.url), "utf8");

test("the verified Claude anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json"));
  expect(Object.values(seven.results.claude)).toHaveLength(7);
  for (const result of Object.values(seven.results.claude))
    expect(result).toMatchObject({ status: "pass" });
  const questions = JSON.parse(read("questions.snapshot.json"));
  expect(questions.results.claude.status).toBe("pass");
  expect(questions.observations.claude).toEqual(claudeCode.escalation.observedOn);
  expect(questions.observations.claude.version).toBe(claudeCode.verifiedAgainst);
});

test("captured native accounting normalizes with a distinct used amount and input limit", () => {
  const native = JSON.parse(read("context-native.ndjson"));
  expect(native.response.subtype).toBe("success");
  expect(contextInspectionOf(native.response.response)).toMatchObject({
    status: "available",
    method: "native-context-estimate",
    model: "claude-opus-5",
    contextWindowTokens: 1000000,
    inputLimitTokens: 967000,
    totalTokens: native.response.response.totalTokens,
  });
  expect(native.response.response.totalTokens).toBeGreaterThan(0);
  expect(native.response.response.totalTokens).toBeLessThan(967000);
  const published = JSON.parse(read("context-public.ndjson"));
  expect(published.executable.version).toBe(claudeCode.verifiedAgainst);
  expect(published.accounting).toMatchObject({
    status: "available",
    method: "native-context-estimate",
  });
});
