import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createStageTrace, type StageRecord } from "./cursor-stage-trace.js";

const directories: string[] = [];
const children = new Set<ChildProcess>();
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "hcn-stage-trace-"));
  directories.push(path);
  return path;
}
// Runs after a failed or abandoned test too, so no owned child outlives it.
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited(child);
  }
  children.clear();
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

const fields = [
  "cpuSystemMicros",
  "cpuUserMicros",
  "monoMs",
  "phase",
  "pid",
  "stage",
  "v",
  "wallMs",
];

function records(path: string): StageRecord[] {
  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as StageRecord);
}

test("a missing or empty root disables the trace and ignores the ambient flag", () => {
  const root = directory();
  const before = process.env.HCN_CURSOR_STAGE_TRACE_DIR;
  process.env.HCN_CURSOR_STAGE_TRACE_DIR = root;
  try {
    expect(createStageTrace(undefined)).toBeUndefined();
    expect(createStageTrace("")).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.HCN_CURSOR_STAGE_TRACE_DIR;
    else process.env.HCN_CURSOR_STAGE_TRACE_DIR = before;
  }
  expect(readdirSync(root)).toEqual([]);
});

test("each mark appends one complete, ordered metadata-only record", () => {
  const root = join(directory(), "nested", "traces");
  const trace = createStageTrace(root);
  if (!trace) throw new Error("trace expected");
  expect(basename(trace.path)).toMatch(
    new RegExp(`^cursor-stage-${process.pid}-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.jsonl$`),
  );
  expect(statSync(trace.path).mode & 0o777).toBe(0o600);
  expect(readFileSync(trace.path, "utf8")).toBe("");
  trace.mark("first", "start");
  expect(records(trace.path)).toHaveLength(1);
  trace.mark("first", "end");
  trace.mark("second", "start");
  trace.mark("second", "end");
  const written = records(trace.path);
  expect(written.map((record) => [record.stage, record.phase])).toEqual([
    ["first", "start"],
    ["first", "end"],
    ["second", "start"],
    ["second", "end"],
  ]);
  for (const [index, record] of written.entries()) {
    expect(Object.keys(record).sort()).toEqual(fields);
    expect(record.v).toBe(1);
    expect(record.pid).toBe(process.pid);
    for (const value of [record.wallMs, record.monoMs]) expect(Number.isFinite(value)).toBe(true);
    for (const value of [record.cpuUserMicros, record.cpuSystemMicros]) {
      expect(Number.isInteger(value) && value >= 0).toBe(true);
    }
    const previous = written[index - 1];
    if (!previous) continue;
    expect(record.monoMs).toBeGreaterThanOrEqual(previous.monoMs);
    expect(record.cpuUserMicros).toBeGreaterThanOrEqual(previous.cpuUserMicros);
    expect(record.cpuSystemMicros).toBeGreaterThanOrEqual(previous.cpuSystemMicros);
  }
  const other = createStageTrace(root);
  expect(other?.path).not.toBe(trace.path);
  expect(readdirSync(root)).toHaveLength(2);
});

test("an enabled trace propagates a filesystem failure", () => {
  const blocked = join(directory(), "file");
  writeFileSync(blocked, "");
  expect(() => createStageTrace(blocked)).toThrow();
});

/** Resolves with the child's stdout once it contains `marker`. */
function waitFor(child: ChildProcess, marker: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(marker)) resolveOutput(output);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`child exited before ${marker}: ${code ?? signal}`)),
    );
  });
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode);
  }
  return new Promise((resolveSignal) => child.once("exit", (_, signal) => resolveSignal(signal)));
}

test("a start record survives SIGKILL of the process that wrote it", async () => {
  const work = directory();
  const root = join(work, "traces");
  const script = join(work, "child.mjs");
  writeFileSync(
    script,
    [
      "const { createStageTrace } = await import(process.env.HCN_TRACE_HELPER);",
      "const trace = createStageTrace(process.env.HCN_TRACE_ROOT);",
      'trace.mark("held", "start");',
      'process.stdout.write("READY " + trace.path + "\\n");',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  const helper = pathToFileURL(resolve("test/transcript/cursor-stage-trace.ts")).href;
  const child = spawn(process.execPath, [script], {
    cwd: work,
    env: { HOME: work, TMPDIR: work, HCN_TRACE_HELPER: helper, HCN_TRACE_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = await waitFor(child, "\n").catch((error: Error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  const path = /^READY (.+)\n/.exec(ready)?.[1];
  if (!path) throw new Error(`no READY marker: ${ready}`);
  expect(child.kill("SIGKILL")).toBe(true);
  expect(await exited(child)).toBe("SIGKILL");
  const [held, ...rest] = records(path);
  expect(rest).toEqual([]);
  expect(held?.pid).toBe(child.pid);
  expect([held?.stage, held?.phase]).toEqual(["held", "start"]);
  expect(readdirSync(root)).toEqual([basename(path)]);
});
