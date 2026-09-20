import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contextInspectionOf } from "../../src/interpretation/context-inspection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/claude-2.1.278/${file}`, import.meta.url), "utf8");

const events = (file: string): Record<string, unknown>[] =>
  read(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

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
  expect(native.response.response.autocompactSource).toBe("model-default");
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
  expect(published.verifiedAgainst).toBe(claudeCode.verifiedAgainst);
  expect(published.accounting).toMatchObject({
    status: "available",
    method: "native-context-estimate",
  });
});

test("forked resume accounting counts recalled history and leaves the source session unchanged", () => {
  const fresh = JSON.parse(read("context-native.ndjson")).response.response;
  const resumed = JSON.parse(read("context-resume-native.ndjson")).response.response;
  expect(contextInspectionOf(resumed)).toMatchObject({ status: "available" });
  expect(resumed.totalTokens).toBeGreaterThan(fresh.totalTokens);
  const digest = (file: string): string => read(file).split(" ")[0] ?? "";
  expect(digest("context-session-before.sha256")).toMatch(/^[0-9a-f]{64}$/);
  expect(digest("context-session-after.sha256")).toBe(digest("context-session-before.sha256"));
});

test("native compaction surfaces its boundary and a later process recalls the marker", () => {
  const compaction = events("compaction.ndjson");
  expect(compaction).toContainEqual({ kind: "progress", label: "compact_boundary" });
  expect(compaction).toContainEqual({ kind: "message", role: "assistant", text: "HERON-517" });
  expect(compaction.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
  const later = events("post-compaction.ndjson");
  expect(later).toContainEqual({ kind: "message", role: "assistant", text: "HERON-517" });
  expect(later.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
});
