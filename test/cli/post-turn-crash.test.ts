/** Issue #376: invented pi process, real CLI, no model or network. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanupSandbox } from "./reap.js";
import { ensureDist } from "./stub-dist.js";

const PREFIX = join(tmpdir(), "hcn-post-turn-crash-");
const dirs: string[] = [];

afterEach(async () => {
  await cleanupSandbox({
    pids: [],
    dirs: dirs.splice(0),
    prefix: PREFIX,
    label: "post-turn-crash",
  });
});

// The stub prints the stream shape pi 0.99.1 emits in `--mode json`
// (test/fixtures/pi-0.99.1/fresh.ndjson), with invented content. The
// assistant message rides on message_end, turn_end and agent_end alike.
const STUB_PI = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.99.1"); process.exit(0); }
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const message = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "invented reasoning" },
    { type: "text", text: process.env.STUB_TEXT },
  ],
  api: "invented-api",
  provider: "invented-provider",
  model: "invented-model",
  usage: { input: 1234, output: 5678, reasoning: 910, totalTokens: 6912 },
  stopReason: process.env.STUB_STOP_REASON,
  timestamp: 0,
};
line({ type: "session", version: 3, id: "0b6b8c1e-5a1d-4c2e-8f00-000000000001", timestamp: "2026-09-29T00:00:00.000Z", cwd: process.cwd() });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_end", message });
line({ type: "turn_end", message, toolResults: [] });
line({ type: "agent_end", messages: [message] });
if (process.env.STUB_TERMINAL === "1") line({ type: "agent_settled" });
process.stderr.write(process.env.STUB_STDERR_LINE + "\\n");
for (let i = 0; i < 30; i++) process.stderr.write("    at inventedFrame (invented.js:1:1)\\n");
if (process.env.STUB_STDERR_FOOTER) process.stderr.write(process.env.STUB_STDERR_FOOTER + "\\n");
process.stderr.write("Node.js v24.15.0\\n");
process.exitCode = 1;
`;

type Event = Record<string, unknown> & { kind: string };

const runStubPi = (stub: {
  terminal: boolean;
  stderrLine?: string;
  stderrFooter?: string;
}): { events: Event[]; status: number | null } => {
  const cli = ensureDist();
  const dir = mkdtempSync(PREFIX);
  dirs.push(dir);
  const bin = join(dir, "bin");
  const cwd = join(dir, "cwd");
  mkdirSync(bin);
  mkdirSync(cwd);
  writeFileSync(join(bin, "pi"), STUB_PI);
  chmodSync(join(bin, "pi"), 0o755);
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Keep the operator's own hcn and pi configuration out of the run.
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    HCN_CONFIG_DIR: join(dir, "hcn-config"),
    PI_CODING_AGENT_DIR: join(dir, "pi-agent"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    STUB_TERMINAL: stub.terminal ? "1" : "0",
    STUB_TEXT: "INVENTED_FINAL_ANSWER",
    STUB_STOP_REASON: "stop",
    STUB_STDERR_LINE:
      stub.stderrLine ?? "Error: This extension ctx is stale after session replacement or reload.",
    STUB_STDERR_FOOTER: stub.stderrFooter ?? "",
  };
  delete env.HCN_OBSERVER;
  delete env.HCN_INVOCATION_ID;
  const result = spawnSync("node", [cli, "run", "pi", "--json", "--prompt", "invented prompt"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const events = result.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Event);
  return { events, status: result.status };
};

test("a successful native terminal followed by a process crash preserves completion and the error headline", () => {
  const { events, status } = runStubPi({ terminal: true });
  expect(status).toBe(1);
  expect(events).toContainEqual({
    kind: "message",
    role: "assistant",
    text: "INVENTED_FINAL_ANSWER",
  });
  const done = events.find((e) => e.kind === "done");
  expect(done).toMatchObject({
    cause: "crash",
    exitCode: 1,
    completion: "native-terminal",
    failure: { class: "native", nativeExitCode: 1, retryable: false },
  });
  const failure = events.find((e) => e.kind === "failure");
  expect(failure?.message).toContain("Error: This extension ctx is stale");
  expect(failure?.message).not.toContain("arguments");
  expect(failure?.message).not.toContain("inventedFrame");
});

test("a final message alone remains delivered without inventing native turn completion", () => {
  const { events, status } = runStubPi({ terminal: false });
  expect(status).toBe(1);
  expect(events.find((e) => e.kind === "done")).toMatchObject({
    cause: "crash",
    exitCode: 1,
    completion: "message-delivered",
  });
});

test("a late auth failure revokes native completion without losing delivered output", () => {
  const { events, status } = runStubPi({ terminal: true, stderrLine: "401 Unauthorized" });
  expect(status).toBe(1);
  expect(events).toContainEqual({
    kind: "message",
    role: "assistant",
    text: "INVENTED_FINAL_ANSWER",
  });
  expect(events.find((e) => e.kind === "done")).toMatchObject({
    cause: "failed",
    exitCode: 1,
    completion: "message-delivered",
    failure: { class: "auth" },
  });
});

test("a late usage wall also preserves delivered output without native completion", () => {
  const { events, status } = runStubPi({ terminal: true, stderrLine: "Usage limit reached" });
  expect(status).toBe(1);
  expect(events.find((e) => e.kind === "done")).toMatchObject({
    cause: "limit",
    exitCode: 1,
    completion: "message-delivered",
    failure: { class: "usage-limit" },
  });
});

test("the harness Error headline survives a long stderr stack", () => {
  const { events } = runStubPi({ terminal: true });
  expect(events.find((e) => e.kind === "failure")?.message).toContain(
    "Error: This extension ctx is stale",
  );
});

test("a coded Node Error headline survives its long stack and code footer", () => {
  const { events, status } = runStubPi({
    terminal: true,
    stderrLine: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'invented-extension'",
    stderrFooter: "{\n  code: 'ERR_MODULE_NOT_FOUND'\n}",
  });
  expect(status).toBe(1);
  expect(events.find((e) => e.kind === "done")).toMatchObject({
    cause: "crash",
    exitCode: 1,
    completion: "native-terminal",
    failure: { class: "native", nativeExitCode: 1 },
  });
  const message = events.find((e) => e.kind === "failure")?.message;
  expect(message).toContain(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'invented-extension'",
  );
  expect(message).not.toContain("inventedFrame");
});

test("a post-output native failure never invents argument rejection", () => {
  const { events } = runStubPi({ terminal: true });
  expect(events.find((e) => e.kind === "failure")?.message).not.toContain("arguments");
});
