/**
 * A model reply must never vanish between the harness and hcn. pi puts the
 * whole assistant message - reasoning and answer text - on ONE
 * `message_end` line, so a long reasoning trace makes that line longer
 * than 64 KiB. hcn used to discard such a line and report a clean run with
 * no assistant message. These tests drive the built CLI against a stub
 * `pi` on PATH that prints an invented pi JSON stream. No real harness, no
 * model, no network.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RUN_LINE_MAX } from "../../src/execution/lines.js";
import { cleanupSandbox } from "./reap.js";
import { ensureDist } from "./stub-dist.js";

const PREFIX = join(tmpdir(), "hcn-run-line-limit-");
const dirs: string[] = [];

afterEach(async () => {
  await cleanupSandbox({ pids: [], dirs: dirs.splice(0), prefix: PREFIX, label: "run-line-limit" });
});

// The stub prints the stream shape pi 0.87.1 emits in `--mode json`
// (test/fixtures/pi-0.87.1/fresh.ndjson), with invented content. The
// assistant message rides on message_end, turn_end and agent_end alike.
const STUB_PI = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.87.1"); process.exit(0); }
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const message = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "r".repeat(Number(process.env.STUB_REASONING_CHARS)) },
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
line({ type: "agent_settled" });
`;

type Event = Record<string, unknown> & { kind: string };

const runStubPi = (stub: {
  reasoningChars: number;
  text: string;
  stopReason: string;
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
    STUB_REASONING_CHARS: String(stub.reasoningChars),
    STUB_TEXT: stub.text,
    STUB_STOP_REASON: stub.stopReason,
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

test("a pi reply whose message_end line exceeds 65,536 characters delivers its message", () => {
  const { events } = runStubPi({
    reasoningChars: 200_000,
    text: "INVENTED_ANSWER_AFTER_LONG_REASONING",
    stopReason: "stop",
  });
  const messages = events.filter((e) => e.kind === "message");
  expect(messages).toEqual([
    { kind: "message", role: "assistant", text: "INVENTED_ANSWER_AFTER_LONG_REASONING" },
  ]);
  const done = events.find((e) => e.kind === "done");
  expect(done?.cause).toBe("clean");
  expect(events.some((e) => e.kind === "failure")).toBe(false);
});

test("a pi line over hcn's line bound fails the run and names the overflow and its size", () => {
  const { events, status } = runStubPi({
    reasoningChars: RUN_LINE_MAX,
    text: "INVENTED_ANSWER_LOST_TO_OVERFLOW",
    stopReason: "stop",
  });
  expect(events.some((e) => e.kind === "message")).toBe(false);
  const failures = events.filter((e) => e.kind === "failure");
  // message_end, turn_end and agent_end each carry the message, so each
  // overflows on its own; the first one reported is message_end.
  expect(failures.length).toBeGreaterThanOrEqual(1);
  const first = failures[0] as unknown as { class: string; message: string; retryable: boolean };
  expect(first.class).toBe("transport");
  expect(first.message).toMatch(
    /^Transport failure \(output line overflow: stdout line of [\d,]+ bytes exceeds the 16,777,216-character line limit and was discarded\)/,
  );
  const bytes = Number(/line of ([\d,]+) bytes/.exec(first.message)?.[1]?.replaceAll(",", ""));
  expect(bytes).toBeGreaterThan(RUN_LINE_MAX);
  const done = events.find((e) => e.kind === "done") as
    | { cause: string; failure?: { class: string; message: string } }
    | undefined;
  expect(done?.cause).toBe("failed");
  expect(done?.failure).toEqual(
    expect.objectContaining({ class: "transport", message: first.message }),
  );
  expect(status).not.toBe(0);
}, 60_000);

test("a pi reply that stops with no text fails the run and states the stop reason and usage", () => {
  const { events, status } = runStubPi({ reasoningChars: 1_000, text: "", stopReason: "length" });
  expect(events.some((e) => e.kind === "message")).toBe(false);
  const detail =
    "pi turn ended with stopReason length and no text (usage: input 1234, output 5678, reasoning 910)";
  const failures = events.filter((e) => e.kind === "failure");
  expect(failures).toEqual([
    {
      kind: "failure",
      class: "task",
      retryable: false,
      message: `Task failed (${detail}) - surface to caller, do not auto-route`,
    },
  ]);
  expect(events.find((e) => e.kind === "done")).toMatchObject({
    cause: "failed",
    failure: { class: "task" },
  });
  expect(status).not.toBe(0);
});
