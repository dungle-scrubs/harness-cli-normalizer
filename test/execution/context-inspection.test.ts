import { expect, test } from "vitest";
import { CONTEXT_TRANSPORT_MAX, inspectContext } from "../../src/execution/context-inspection.js";
import { LineBuffer } from "../../src/execution/lines.js";
import { KILL_GRACE_MS } from "../../src/execution/supervisor.js";
import { contextInspectionOf } from "../../src/interpretation/context-inspection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const inputId = "de64d6cb-61ee-46ee-857f-34dbe14f1811";
const settle = async (): Promise<void> => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

// Composed protocol sequence, not a recording. The public SDK specifies
// shouldQuery:false and the user UUID acknowledgement used by this probe.
test.each([false, true])(
  "context inspection counts after acknowledgement, including output arriving after exit: %s",
  async (exitBeforeResponse) => {
    const child = new FakeProcess();
    const spawn = fakeSpawner([child]);
    const signals = fakeSignal();
    const clock = new FakeClock();
    const result = inspectContext(
      {
        harness: claudeCode,
        argv: ["claude", "-p", "", "--input-format", "stream-json", "--no-session-persistence"],
        cwd: "/fixture",
        inputId,
        prompt: "Do not execute this task",
      },
      { spawn: spawn.spawn, signal: signals.signal, clock },
    );
    await settle();
    const initialize = JSON.parse(child.stdinLines[0] ?? "{}");
    child.emitLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: initialize.request_id, response: {} },
      }),
    );
    await settle();
    const staged = JSON.parse(child.stdinLines[1] ?? "{}");
    expect(staged).toMatchObject({
      type: "user",
      uuid: inputId,
      shouldQuery: false,
      message: { role: "user", content: "Do not execute this task" },
    });
    expect(child.stdinLines).toHaveLength(2);
    child.emitLine(JSON.stringify({ ...staged, uuid: "unrelated" }));
    await settle();
    expect(child.stdinLines).toHaveLength(2);
    child.emitLine(JSON.stringify(staged));
    await settle();
    const query = JSON.parse(child.stdinLines[2] ?? "{}");
    expect(query.request).toEqual({ subtype: "get_context_usage" });
    if (exitBeforeResponse) {
      child.exitWithoutClosing(0);
      await settle();
    }
    child.emitLine(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: query.request_id,
          response: {
            model: "claude-opus-5",
            totalTokens: 24171,
            maxTokens: 1000000,
            rawMaxTokens: 1000000,
            autoCompactThreshold: 967000,
            isAutoCompactEnabled: true,
          },
        },
      }),
    );
    expect(await result).toEqual({
      status: "available",
      method: "native-context-estimate",
      model: "claude-opus-5",
      totalTokens: 24171,
      inputLimitTokens: 967000,
      contextWindowTokens: 1000000,
    });
    expect(child.stdinEnded).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
    expect(spawn.calls).toHaveLength(1);
  },
);

test("asynchronous stdin failure settles as unavailable and closes the probe", async () => {
  const child = new FakeProcess();
  let fail!: () => void;
  Object.assign(child, {
    inputError: new Promise<void>((resolve) => {
      fail = resolve;
    }),
  });
  const clock = new FakeClock();
  const result = inspectContext(
    { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
    { spawn: fakeSpawner([child]).spawn, clock, signal: fakeSignal().signal },
  );
  fail();
  expect(await result).toEqual({ status: "unavailable", reason: "transport" });
  expect(child.stdinEnded).toBe(true);
  expect(clock.pendingTimerCount).toBe(0);
});

test("a context window alone and malformed native usage cannot authorize a count", () => {
  for (const value of [
    null,
    { model: "opus", maxTokens: 1000000 },
    { model: "opus", maxTokens: 1000000, totalTokens: -1, isAutoCompactEnabled: false },
    { model: "opus", maxTokens: 1000000, totalTokens: 10, isAutoCompactEnabled: true },
    { model: "opus", maxTokens: 1000000, totalTokens: 10.5, isAutoCompactEnabled: false },
  ]) {
    expect(contextInspectionOf(value)).toEqual({ status: "unavailable", reason: "protocol" });
  }
  expect(
    contextInspectionOf({
      model: "opus",
      maxTokens: 1000,
      totalTokens: 1100,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 2000,
    }),
  ).toMatchObject({ status: "available", inputLimitTokens: 1000, totalTokens: 1100 });
});

test("oversized serialized context is refused before spawning", async () => {
  const spawn = fakeSpawner([]);
  expect(
    await inspectContext(
      { harness: claudeCode, argv: ["claude"], inputId, prompt: "a".repeat(CONTEXT_TRANSPORT_MAX) },
      { spawn: spawn.spawn, signal: fakeSignal().signal, clock: new FakeClock() },
    ),
  ).toEqual({ status: "unavailable", reason: "transport-limit" });
  expect(spawn.calls).toHaveLength(0);
});

test("cancellation does not stage a prompt and reaps an uncooperative child", async () => {
  const child = new FakeProcess({ exitOnStdinEnd: false });
  const spawn = fakeSpawner([child]);
  const signals = fakeSignal({ autoExit: false });
  const clock = new FakeClock();
  const controller = new AbortController();
  const result = inspectContext(
    {
      harness: claudeCode,
      argv: ["claude"],
      inputId,
      prompt: "pending",
      signal: controller.signal,
    },
    { spawn: spawn.spawn, signal: signals.signal, clock },
  );
  controller.abort();
  await settle();
  expect(signals.sent.map((item) => item.sig)).toEqual(["SIGTERM"]);
  clock.advance(KILL_GRACE_MS);
  expect(await result).toEqual({ status: "unavailable", reason: "cancelled" });
  expect(signals.sent.map((item) => item.sig)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(child.stdinLines).toHaveLength(1);
  expect(child.outputDisposed).toBe(true);
  expect(clock.pendingTimerCount).toBe(0);
});

test("inspection deadline and exit with inherited pipes both settle without leaked readers", async () => {
  for (const kind of ["deadline", "exit"] as const) {
    const child = new FakeProcess();
    const clock = new FakeClock();
    const result = inspectContext(
      { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
      { spawn: fakeSpawner([child]).spawn, signal: fakeSignal().signal, clock, turnTimeoutMs: 100 },
    );
    if (kind === "deadline") clock.advance(100);
    else {
      child.exitWithoutClosing(1);
      await settle();
      clock.advance(KILL_GRACE_MS);
    }
    expect(await result).toEqual({
      status: "unavailable",
      reason: kind === "deadline" ? "timeout" : "native-exit",
    });
    expect(child.stdout.activeReaderCount).toBe(0);
    expect(child.stderr.activeReaderCount).toBe(0);
    expect(clock.pendingTimerCount).toBe(0);
  }
});

test("replay line bounds retain large acknowledgements while keeping partial and complete limits identical", () => {
  const large = JSON.stringify({ type: "user", uuid: inputId, message: "é".repeat(80_000) });
  const lines = new LineBuffer(CONTEXT_TRANSPORT_MAX);
  const bytes = new TextEncoder().encode(`${large}\n`);
  expect(lines.push(bytes.slice(0, 81))).toEqual([]);
  expect(lines.push(bytes.slice(81))).toEqual([large]);
  const small = new LineBuffer(4);
  expect(small.push("12345\n")).toEqual([]);
  expect(small.push("12345")).toEqual([]);
  expect(small.flush()).toBe(null);
  expect(small.push("1234")).toEqual([]);
  expect(small.flush()).toBe("1234");
});

test("failed process termination reports cleanup instead of waiting without a deadline", async () => {
  const child = new FakeProcess({ exitOnStdinEnd: false });
  const clock = new FakeClock();
  const controller = new AbortController();
  const result = inspectContext(
    {
      harness: claudeCode,
      argv: ["claude"],
      inputId,
      prompt: "pending",
      signal: controller.signal,
    },
    {
      spawn: fakeSpawner([child]).spawn,
      clock,
      signal: () => {
        /* Model failed signal delivery. */
      },
    },
  );
  controller.abort();
  await settle();
  clock.advance(2 * KILL_GRACE_MS);
  expect(await result).toEqual({ status: "unavailable", reason: "cleanup" });
  expect(clock.pendingTimerCount).toBe(0);
  child.exit(null);
});

test.each([
  { diagnostic: "Not logged in. Please run /login", reason: "auth" },
  { diagnostic: "You've hit your session limit", reason: "limit" },
  { diagnostic: "No conversation found", reason: "native-exit" },
])(
  "native accounting preserves $reason without exposing diagnostics",
  async ({ diagnostic, reason }) => {
    const child = new FakeProcess();
    const result = inspectContext(
      { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
      { spawn: fakeSpawner([child]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    child.emitStderr(diagnostic);
    child.exit(1);
    expect(await result).toEqual({ status: "unavailable", reason });
  },
);
