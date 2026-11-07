/**
 * A model reply must never vanish between the harness and hcn. pi puts the
 * whole assistant message - reasoning and answer text - on ONE
 * `message_end` line, so a long reasoning trace makes that line longer
 * than 64 KiB. hcn used to discard such a line and report a clean run with
 * no assistant message. These tests drive the built CLI against a stub
 * `pi` on PATH that prints an invented pi JSON stream. No real harness, no
 * model, no network.
 *
 * The line bound is 16 MiB, so an over-long line is a real event: a
 * discarded `message_end` whose assistant text is that long. A turn that
 * recovered from it (a later assistant message) must not fail: the
 * discarded line repeated what the harness said, and the turn's own
 * verdict is the later message.
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

// The stub prints the stream shape pi 0.99.1 emits in `--mode json`
// (test/fixtures/pi-0.99.1/fresh.ndjson), with invented content. The
// assistant message rides on message_end, turn_end and agent_end alike.
const STUB_PI = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.99.1"); process.exit(0); }
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const build = (reasoningChars, text, stopReason) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "r".repeat(reasoningChars) },
    { type: "text", text },
  ],
  api: "invented-api",
  provider: "invented-provider",
  model: "invented-model",
  usage: { input: 1234, output: 5678, reasoning: 910, totalTokens: 6912 },
  stopReason,
  timestamp: 0,
});
const first = build(
  Number(process.env.STUB_REASONING_CHARS),
  process.env.STUB_TEXT,
  process.env.STUB_STOP_REASON,
);
// The recovery shape: a first turn whose assistant message is too long for
// one line, then a second turn that answers normally.
const second =
  process.env.STUB_SECOND_TEXT === undefined
    ? null
    : build(Number(process.env.STUB_SECOND_REASONING_CHARS), process.env.STUB_SECOND_TEXT, "stop");
line({ type: "session", version: 3, id: "0b6b8c1e-5a1d-4c2e-8f00-000000000001", timestamp: "2026-09-29T00:00:00.000Z", cwd: process.cwd() });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_end", message: first });
line({ type: "turn_end", message: first, toolResults: [] });
if (second !== null) {
  line({ type: "turn_start" });
  line({ type: "message_end", message: second });
  line({ type: "turn_end", message: second, toolResults: [] });
}
line({ type: "agent_end", messages: second === null ? [first] : [first, second] });
line({ type: "agent_settled" });
`;

type Event = Record<string, unknown> & { kind: string };

const runStubPi = (stub: {
  reasoningChars: number;
  text: string;
  stopReason: string;
  /** When set, the stub answers with a second, normal turn after the
   * first one - the shape of a run that recovered. */
  secondText?: string;
  secondReasoningChars?: number;
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
    ...(stub.secondText === undefined
      ? {}
      : {
          STUB_SECOND_TEXT: stub.secondText,
          STUB_SECOND_REASONING_CHARS: String(stub.secondReasoningChars ?? 1_000),
        }),
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

test("a pi run that recovered from an over-long line delivers the later message and does not fail", () => {
  // The shape of the real run (issue #461): pi's first assistant attempt
  // ended with stopReason error and a text far over the line bound, so its
  // message_end - and the turn_end that repeats it - overflowed. pi kept
  // going, the next assistant message answered normally, and the run
  // settled. The discarded lines repeated what the harness had already
  // said, so the turn's verdict is the later message, not the overflow.
  const { events, status } = runStubPi({
    reasoningChars: RUN_LINE_MAX,
    text: "INVENTED_ANSWER_LOST_TO_OVERFLOW",
    stopReason: "error",
    secondText: "INVENTED_ANSWER_AFTER_RECOVERY",
    secondReasoningChars: 1_000,
  });
  expect(events.filter((e) => e.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "INVENTED_ANSWER_AFTER_RECOVERY" },
  ]);
  expect(events.filter((e) => e.kind === "failure")).toEqual([]);
  const warnings = events.filter((e) => e.kind === "warning");
  // Three discarded lines: the turn_end and the agent_end repeat what
  // message_end carried (they warn at once), and the message_end itself
  // was superseded by the later assistant message.
  expect(warnings).toHaveLength(3);
  for (const warning of warnings) {
    expect((warning as unknown as { message: string }).message).toMatch(
      /^output line overflow: stdout line of [\d,]+ bytes exceeds the 16,777,216-character line limit and was discarded; /,
    );
  }
  expect(
    warnings.map(
      (warning) =>
        /discarded; ([^;]+)$/.exec((warning as unknown as { message: string }).message)?.[1],
    ),
  ).toEqual([
    "it repeats records already read",
    "it repeats records already read",
    "the turn completed after it",
  ]);
  expect(events.find((e) => e.kind === "done")).toMatchObject({ kind: "done", cause: "clean" });
  expect(status).toBe(0);
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
