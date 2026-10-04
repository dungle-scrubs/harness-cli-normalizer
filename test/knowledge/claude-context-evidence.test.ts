import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeLine, freshDecodeState } from "../../src/execution/decode.js";
import {
  buildContextInspectionArgv,
  contextInspectionOf,
} from "../../src/interpretation/context-inspection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const read = (file: string, version = "2.1.288"): string =>
  readFileSync(new URL(`../fixtures/claude-${version}/${file}`, import.meta.url), "utf8");

const events = (file: string): Record<string, unknown>[] =>
  read(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("the verified Claude anchor has passing native capability and question captures", () => {
  const seven = JSON.parse(read("seven.snapshot.json", claudeCode.verifiedAgainst));
  expect(Object.values(seven.results.claude)).toHaveLength(7);
  for (const result of Object.values(seven.results.claude))
    expect(result).toMatchObject({ status: "pass" });
  const questions = JSON.parse(read("questions.snapshot.json", claudeCode.verifiedAgainst));
  expect(questions.results.claude.status).toBe("pass");
  expect(questions.observations.claude).toEqual(claudeCode.escalation.observedOn);
  expect(questions.observations.claude.version).toBe(claudeCode.verifiedAgainst);
  const source = JSON.parse(read("version-source.snapshot.json", claudeCode.verifiedAgainst));
  expect(source.latest).toBe(claudeCode.verifiedAgainst);
  expect(source.versionSource).toEqual(claudeCode.versionSource);
});

test("historical 2.1.288 accounting normalizes with a distinct used amount and input limit", () => {
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
  expect(published.executable.version).toBe("2.1.288");
  expect(published.verifiedAgainst).toBe("2.1.288");
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
  const digest = (file: string): string => read(file).trim().split(" ")[0] ?? "";
  expect(digest("context-session-before.sha256")).toMatch(/^[0-9a-f]{64}$/);
  expect(digest("context-session-after.sha256")).toBe(digest("context-session-before.sha256"));
});

test("native compaction surfaces its boundary and a later process recalls the marker", () => {
  const compaction = events("compaction.ndjson");
  // ADR 0009 replaced the `progress` `compact_boundary` label with the
  // lossless compaction event. The numbers are claude's own; hcn derives
  // none of them.
  expect(compaction).toContainEqual({
    kind: "compaction",
    state: "compacted",
    trigger: "auto",
    tokensBefore: 24097,
    tokensAfter: 6703,
    durationMs: 64634,
  });
  expect(compaction).toContainEqual({ kind: "compaction", state: "started" });
  expect(compaction).not.toContainEqual({ kind: "progress", label: "compact_boundary" });
  // Exactly one end for one compaction: the success status record is
  // deliberately silent, so only the boundary reports it. Starts are not
  // deduplicated (this capture holds three; 2.1.285's held two), which is
  // why the end is the one a counting consumer counts.
  const compactionStates = compaction
    .filter((e) => e.kind === "compaction")
    .map((e) => e.state as string);
  expect(compactionStates.filter((state) => state === "compacted")).toHaveLength(1);
  const state = freshDecodeState(null);
  const native = read("compaction.native.ndjson")
    .trim()
    .split("\n")
    .flatMap((line) => decodeLine(claudeCode, line, state, "claude-opus-5"));
  expect(native.filter((event) => event.kind === "compaction")).toEqual(
    compaction.filter((event) => event.kind === "compaction"),
  );
  expect(native).toContainEqual({ kind: "message", role: "assistant", text: "HERON-1029" });
  expect(compaction).toContainEqual({ kind: "message", role: "assistant", text: "HERON-1029" });
  expect(compaction.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
  const later = events("post-compaction.ndjson");
  expect(later).toContainEqual({ kind: "message", role: "assistant", text: "HERON-1029" });
  expect(later.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
});

test("accounting stages exactly one complete prompt with no assistant execution", () => {
  for (const file of [
    "context-native.proof.snapshot.json",
    "context-resume-native.proof.snapshot.json",
  ]) {
    const proof = JSON.parse(read(file));
    expect(proof.result).toMatchObject({ status: "available", model: "claude-opus-5" });
    const resumeIndex = proof.argv.indexOf("--resume");
    const argv = buildContextInspectionArgv(claudeCode, {
      model: "claude-opus-5",
      prompt: { explicit: true, text: "Synthetic accounting probe" },
      discovery: { extensions: false, skills: false },
      ...(resumeIndex < 0 ? {} : { resume: proof.argv[resumeIndex + 1] }),
    });
    // The native probe appended tool isolation; it is not an adapter default.
    const probeToolIsolation = [
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    expect([...argv, ...probeToolIsolation]).toEqual(proof.argv);
    expect(argv).toContain("--no-session-persistence");
    expect(argv.includes("--fork-session")).toBe(resumeIndex >= 0);
    const staged = proof.frames.filter((frame: { type: string }) => frame.type === "user");
    expect(staged).toHaveLength(1);
    expect(staged[0].stagedPromptExact).toBe(true);
    expect(proof.frames.some((frame: { type: string }) => frame.type === "assistant")).toBe(false);
    expect(proof.frames).toContainEqual(expect.objectContaining({ type: "result", turns: 0 }));
  }
});
