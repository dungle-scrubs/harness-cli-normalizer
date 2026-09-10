import { expect, test } from "vitest";
import { CONTEXT_TRANSPORT_MAX, inspectContext } from "../../src/execution/context-inspection.js";
import { LineBuffer } from "../../src/execution/lines.js";
import { KILL_GRACE_MS } from "../../src/execution/supervisor.js";
import {
  type ContextInspection,
  contextInspectionOf,
} from "../../src/interpretation/context-inspection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const inputId = "de64d6cb-61ee-46ee-857f-34dbe14f1811";
const settle = async (): Promise<void> => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

test.each([
  { type: "assistant", message: { content: [] } },
  { type: "stream_event", event: {} },
  { type: "tool_result" },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ran" }] },
  },
  { type: "user", parent_tool_use_id: "tool-1" },
  { type: "result", subtype: "success", num_turns: 1 },
  { type: "result", subtype: "success", num_turns: "0" },
  { type: "result", subtype: "success", num_turns: -1 },
  { type: "result", subtype: "success" },
  { type: "rate_limit_event", rate_limit_info: {} },
  { type: "rate_limit_event", rate_limit_info: { status: "future" } },
  { type: "system", subtype: "future_event" },
  { type: "future_event" },
  {
    type: "control_response",
    response: { subtype: "success", request_id: `${inputId}:initialize`, response: null },
  },
])("query activity or unknown protocol cannot authorize accounting: %j", async (frame) => {
  const child = new FakeProcess();
  const result = inspectContext(
    { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
    { spawn: fakeSpawner([child]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
  );
  child.emitLine(JSON.stringify(frame));
  child.exit(0);
  expect(await result).toEqual({ status: "unavailable", reason: "protocol" });
});

test.each([
  {
    frame: { type: "result", subtype: "success", num_turns: 0, is_error: true },
    reason: "native-exit",
  },
  { frame: { type: "result", subtype: "error_future", is_error: true }, reason: "native-exit" },
  { frame: { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, reason: "limit" },
  {
    frame: { type: "result", subtype: "error_during_execution", num_turns: 0, is_error: true },
    reason: "native-exit",
  },
])("native failure frames retain their failure class: $reason", async ({ frame, reason }) => {
  const child = new FakeProcess();
  const result = inspectContext(
    { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
    { spawn: fakeSpawner([child]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
  );
  child.emitLine(JSON.stringify(frame));
  child.exit(0);
  expect(await result).toEqual({ status: "unavailable", reason });
});

// Composed protocol sequence, not a recording. The public SDK specifies
// shouldQuery:false and the user UUID acknowledgement used by this probe.
const availableCount: ContextInspection = {
  status: "available",
  method: "native-context-estimate",
  model: "claude-opus-5",
  totalTokens: 24171,
  inputLimitTokens: 967000,
  contextWindowTokens: 1000000,
};
const lifecycle = [
  ...["init", "hook_started", "hook_progress", "hook_response"].map((subtype) => ({
    type: "system",
    subtype,
    future_field: true,
  })),
  { type: "command_lifecycle" },
  ...["allowed", "allowed_warning"].map((status) => ({
    type: "rate_limit_event",
    rate_limit_info: { status },
  })),
  ...[0, 25000].map((tokens) => ({
    type: "result",
    subtype: "success",
    num_turns: 0,
    usage: { input_tokens: tokens },
  })),
]
  .map((frame) => JSON.stringify(frame))
  .join("\n");
const completeOutputCases: readonly {
  name: string;
  exitBeforeResponse?: boolean;
  tail?: string;
  stderr?: string;
  expected: ContextInspection;
}[] = [
  { name: "ordinary completion", expected: availableCount },
  { name: "output after exit", exitBeforeResponse: true, expected: availableCount },
  {
    name: "assistant after usage",
    tail: '{"type":"assistant","message":{"content":[]}}',
    expected: { status: "unavailable", reason: "protocol" },
  },
  {
    name: "tool result after usage",
    tail: '{"type":"user","parent_tool_use_id":"tool-1"}',
    expected: { status: "unavailable", reason: "protocol" },
  },
  {
    name: "error result after usage",
    tail: '{"type":"result","subtype":"success","is_error":true,"num_turns":0}',
    expected: { status: "unavailable", reason: "native-exit" },
  },
  {
    name: "oversized trailing output",
    tail: "a".repeat(CONTEXT_TRANSPORT_MAX + 65_537),
    expected: { status: "unavailable", reason: "transport-limit" },
  },
  {
    name: "native authentication failure",
    stderr: "Not logged in. Please run /login",
    expected: { status: "unavailable", reason: "auth" },
  },
  {
    name: "native authentication explains an invalid response",
    tail: '{"type":"future_event"}',
    stderr: "Not logged in. Please run /login",
    expected: { status: "unavailable", reason: "auth" },
  },
];
test.each(completeOutputCases)(
  "context inspection validates complete output: $name",
  async ({ exitBeforeResponse, tail, stderr, expected }) => {
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
    child.emitLine(lifecycle);
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
      `${JSON.stringify({
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
      })}\n${tail ?? ""}\n${lifecycle}`,
    );
    if (stderr) child.emitStderr(stderr);
    expect(await result).toEqual(expected);
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

test.each([false, true])(
  "usage waits for bounded cleanup, natural drain %s",
  async (naturalDrain) => {
    const child = new FakeProcess({ exitOnStdinEnd: false });
    const clock = new FakeClock();
    const result = inspectContext(
      { harness: claudeCode, argv: ["claude"], inputId, prompt: "pending" },
      {
        spawn: fakeSpawner([child]).spawn,
        clock,
        signal: () => child.exitWithoutClosing(null),
        turnTimeoutMs: 100,
      },
    );
    clock.advance(99);
    for (const frame of [
      {
        type: "control_response",
        response: { subtype: "success", request_id: `${inputId}:initialize`, response: {} },
      },
      { type: "user", uuid: inputId },
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: `${inputId}:usage`,
          response: {
            model: "opus",
            maxTokens: 1000,
            totalTokens: 20,
            isAutoCompactEnabled: false,
          },
        },
      },
    ])
      child.emitLine(JSON.stringify(frame));
    await settle();
    if (naturalDrain) {
      clock.advance(2);
      child.exit(0);
    } else clock.advance(KILL_GRACE_MS);
    expect(await result).toEqual(
      naturalDrain
        ? {
            status: "available",
            method: "native-context-estimate",
            model: "opus",
            totalTokens: 20,
            inputLimitTokens: 1000,
            contextWindowTokens: 1000,
          }
        : { status: "unavailable", reason: "cleanup" },
    );
    expect(child.outputDisposed).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
  },
);

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
