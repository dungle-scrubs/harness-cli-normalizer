import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
  antigravityConversationId,
  normalizeAntigravity,
  parseAntigravityHistory,
} from "../../src/interpretation/transcript/antigravity.js";
import { encodeJson } from "../../src/interpretation/transcript/json.js";

const id = "11111111-1111-4111-8111-111111111111";
const step = (index: number, fields: Record<string, unknown>) => ({
  step_index: index,
  source: "MODEL",
  status: "DONE",
  created_at: "2026-09-19T14:01:34Z",
  ...fields,
});
const steps = [
  step(0, { source: "USER_EXPLICIT", type: "USER_INPUT", content: "synthetic question" }),
  step(1, {
    type: "PLANNER_RESPONSE",
    thinking: "plan",
    tool_calls: [{ name: "view_file", args: { AbsolutePath: "/a" } }],
  }),
  step(2, { type: "GENERIC", status: "ERROR", error: "denied", content: "Encountered error" }),
  step(3, { source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "synthetic notice" }),
  step(4, { type: "PLANNER_RESPONSE", content: "answer" }),
  step(5, { type: "FUTURE_STEP", payload: "EXACT_NUMBER" }),
];
const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

test("Antigravity normalizes step types and keeps exact originals", () => {
  const source = jsonl(steps).replace('"EXACT_NUMBER"', "1.234567890123456789");
  const history = parseAntigravityHistory(source);
  expect(`${history.entries.map((entry) => encodeJson(entry.original)).join("\n")}\n`).toBe(source);
  const records = history.entries.map((entry) => normalizeAntigravity(entry, id));
  expect(records.map((record) => [record.normalized.kind, record.normalized.role])).toEqual([
    ["message", "user"],
    ["message", "assistant"],
    ["tool-result", "tool"],
    ["message", "system"],
    ["message", "assistant"],
    ["unknown", null],
  ]);
  expect(records[1]?.normalized.parts.map((part) => [part.kind, part.toolName])).toEqual([
    ["thinking", null],
    ["tool-call", "view_file"],
  ]);
  expect(records[1]?.normalized.relationships["tool-call"].state).toBe("unknown");
  expect(records[2]?.normalized.parts[0]?.text).toBe("Encountered error");
  expect(records[0]?.nativeId).toBeNull();
});

test("Antigravity compares step_index by value, not spelling", () => {
  const source = jsonl(steps.slice(0, 2)).replace('"step_index":0', '"step_index":0e0');
  expect(parseAntigravityHistory(source).entries).toHaveLength(2);
});

test("Antigravity refuses gaps, repeats, a nonzero start and truncated steps", () => {
  const [first, second] = steps;
  expect(() => parseAntigravityHistory(jsonl([second]))).toThrow("contiguous");
  expect(() => parseAntigravityHistory(jsonl([first, first]))).toThrow("contiguous");
  expect(() => parseAntigravityHistory(jsonl([first, steps[2]]))).toThrow("contiguous");
  expect(() =>
    parseAntigravityHistory(jsonl([{ ...first, truncated_fields: ["content"] }])),
  ).toThrow("truncates");
  expect(() => parseAntigravityHistory(jsonl([{ ...first, step_index: "0" }]))).toThrow(
    "step metadata",
  );
});

test("Antigravity identity comes only from the brain directory layout", () => {
  expect(
    antigravityConversationId(
      `/h/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`,
    ),
  ).toBe(id);
  for (const path of [
    `/brain/${id}/.system_generated/logs/transcript.jsonl`,
    "/brain/not-a-uuid/.system_generated/logs/transcript_full.jsonl",
    "/synthetic/transcript_full.jsonl",
    `/unrelated/${id}/.system_generated/logs/transcript_full.jsonl`,
    `/brain/prefix\\${id}/.system_generated/logs/transcript_full.jsonl`,
  ])
    expect(() => antigravityConversationId(path)).toThrow("identity");
});

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});
beforeAll(() => {
  const built = spawnSync("node", [resolve("scripts/build-native.ts"), "--stage"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(built.status, built.stderr).toBe(0);
});

function command(args: string[], home: string) {
  const run = spawnSync("bun", [resolve("src/cli/index.ts"), ...args], {
    encoding: "utf8",
    env: { HOME: home, TMPDIR: home, PATH: process.env.PATH },
  });
  if (run.error) throw run.error;
  const lines = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { code: run.status, err: run.stderr, lines, result: lines.at(-1) };
}

test("Antigravity transcript inspection reports the step-log method", () => {
  const home = mkdtempSync(join(tmpdir(), "hcn-antigravity-home-"));
  directories.push(home);
  const { code, result } = command(["inspect", "antigravity", "--transcript"], home);
  expect(code).toBe(0);
  expect(result.methods.map((method: { id: string }) => method.id)).toEqual([
    "antigravity-file-v1",
  ]);
  expect(result.capabilities["record-identity"].status).toBe("limited");
});

test("Antigravity ID lookup reads the step log and continues after appended steps", () => {
  const home = mkdtempSync(join(tmpdir(), "hcn-antigravity-home-"));
  directories.push(home);
  const logs = join(home, ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const path = join(logs, "transcript_full.jsonl");
  writeFileSync(path, jsonl(steps.slice(0, 2)));
  const first = command(["transcript", "read", "antigravity", "--id", id], home);
  expect(first.code, first.err).toBe(0);
  expect(first.lines[0].methodId).toBe("antigravity-file-v1");
  expect(first.lines[0].conversation.nativeId).toBe(id);
  expect(first.result.recordsReturned).toBe(2);
  appendFileSync(path, jsonl(steps.slice(2, 5)));
  const next = command(
    ["transcript", "read", "antigravity", "--id", id, "--since", first.result.bookmark],
    home,
  );
  expect(next.code, next.err).toBe(0);
  expect(next.result.continuation).toEqual({ input: "verified", output: "advanced" });
  expect(next.result.recordsReturned).toBe(3);
  const missing = command(["transcript", "read", "antigravity", "--id", "../../etc"], home);
  expect(missing.result.failure.issue).toBe("source-not-found");
});
