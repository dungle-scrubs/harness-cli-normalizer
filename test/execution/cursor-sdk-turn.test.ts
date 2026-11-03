/**
 * One-shot runner tests for the cursor-sdk backend (issue #440):
 * streamTurn dispatches to the worker runner for the cursor descriptor,
 * which spawns the marker, writes the open and prompt lines on stdin,
 * decodes the worker wire with the shared supervisor policies, settles
 * from the worker's terminal record, and bounds an abort with a native
 * cancellation attempt before signal escalation.
 */
import { describe, expect, test } from "vitest";
import { ABORT_CANCEL_GRACE_MS } from "../../src/execution/cursor-sdk-turn.js";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { encodeCursorSdkOpened } from "../../src/interpretation/cursor-sdk.js";
import { composeEscalatedPrompt } from "../../src/interpretation/question.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";

const makeDeps = (proc: FakeProcess, opts?: { stallMs?: number; turnTimeoutMs?: number }) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return {
    ...(opts?.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
    ...(opts?.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    spawn: spawner.spawn,
    clock,
    signal: sig.signal,
    spawner,
    sig,
  };
};

const drain = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const opened = () => encodeCursorSdkOpened("hcn-identity", agentId).trim();
const event = (observation: Record<string, unknown>) =>
  JSON.stringify({ hcn: "event", event: observation });
const delta = (text: string) =>
  JSON.stringify({ hcn: "event", delta: { type: "text-delta", text } });
const turnEnd = (status: string) => JSON.stringify({ hcn: "turn-end", status });

describe("streamTurn cursor-sdk dispatch (fake worker process)", () => {
  test("a pre-aborted request ends killed without spawning or sending work", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const controller = new AbortController();
    controller.abort();
    const events = await drain(
      streamTurn(cursorCli, { prompt: "fixture", signal: controller.signal }, deps),
    );
    expect(deps.spawner.calls).toHaveLength(0);
    expect(events).toEqual([
      {
        kind: "done",
        exitCode: null,
        cause: "killed",
        escalation: { mode: "ask", detection: "none" },
      },
    ]);
  });

  test("a deferred-prompt cancellation ends killed without a native turn verdict", async () => {
    const proc = new FakeProcess();
    const controller = new AbortController();
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "fixture", signal: controller.signal }, makeDeps(proc)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    proc.emitLine(JSON.stringify({ hcn: "send-cancelled", id: "hcn-send:1" }));
    const events = await collecting;
    expect(events.filter((event) => event.kind === "failure" || event.kind === "error")).toEqual(
      [],
    );
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
    expect(proc.stdinEnded).toBe(true);
  });

  test("spawns the marker, writes open and prompt lines; a nonzero worker death without a terminal record is not clean", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "fixture prompt", questions: "none" }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.spawner.calls[0]?.argv).toEqual(["hcn-cursor-sdk-worker"]);
    expect(deps.spawner.calls[0]?.opts.stdin).toBe("pipe");
    const open = JSON.parse(proc.stdinLines[0] as string) as Record<string, unknown>;
    expect(open).toEqual({ hcn: "open", id: "hcn-identity" });
    expect(proc.stdinLines[1]).toBe(
      JSON.stringify({ hcn: "prompt", id: "hcn-send:1", message: "fixture prompt" }),
    );
    proc.exit(1);
    const events = await collecting;
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: "done", cause: "failed" });
  });

  test("a scripted run streams identity, tokens, the complete message and a clean done", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    // Let the runner spawn and write; then script the worker wire.
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(delta("H"));
    proc.emitLine(delta("CN"));
    proc.emitLine(
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "HCN_CURSOR_SDK_OK" }] },
      }),
    );
    proc.emitLine(
      event({
        type: "usage",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      }),
    );
    proc.emitLine(turnEnd("finished"));
    proc.exit(0);
    const events = await collecting;
    expect(events.map((e) => e.kind)).toEqual([
      "identity",
      "token",
      "token",
      "message",
      "usage",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      kind: "identity",
      sessionId: agentId,
      authority: "harness-minted",
    });
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 0, cause: "clean" });
  });

  test("an error terminal record fails the turn with the classified failure", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(
      JSON.stringify({
        hcn: "turn-end",
        status: "error",
        message: "The provided API key is invalid",
        errorKind: "auth",
      }),
    );
    proc.exit(1);
    const events = await collecting;
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "auth" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  });

  test("an open failure surfaces its message and fails the turn; the worker death is bounded", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(
      JSON.stringify({
        hcn: "open-failed",
        id: "hcn-identity",
        message: "Invalid API key",
        errorKind: "auth",
      }),
    );
    proc.exit(1);
    const events = await collecting;
    expect(events.some((e) => e.kind === "error" && e.message === "Invalid API key")).toBe(true);
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "auth" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  });

  test("a stall with no worker output at all ends the turn through the inactivity budget", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const deps = { stallMs: 50, spawn: spawner.spawn, clock, signal: sig.signal };
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // No worker output: the fake clock owns the stall budget, so advancing
    // past it fires the watchdog exactly once.
    clock.advance(50);
    expect(collecting).toBeDefined();
    const settled = await Promise.race([
      collecting.then((events) => events.at(-1)),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    expect(settled).toMatchObject({ kind: "done", cause: "stall" });
    proc.exit(null);
    await collecting;
  });

  test("abort asks the worker to cancel natively before escalating signals", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const controller = new AbortController();
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", signal: controller.signal }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(delta("w"));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The abort line was written before any signal.
    expect(proc.stdinWrites.some((line) => line.includes('"hcn":"abort"'))).toBe(true);
    expect(deps.sig.sent).toEqual([]);
    proc.emitLine(turnEnd("cancelled"));
    proc.exit(null);
    const events = await collecting;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
    // No failure for the caller-requested stop itself.
    expect(events.some((e) => e.kind === "failure")).toBe(false);
  });

  test("a worker that ignores the cancel grace is escalated after ABORT_CANCEL_GRACE_MS", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false });
    const controller = new AbortController();
    const deps = {
      spawn: spawner.spawn,
      clock,
      signal: sig.signal,
    };
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", signal: controller.signal }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(proc.stdinWrites.some((line) => line.includes('"hcn":"abort"'))).toBe(true);
    expect(sig.sent).toEqual([]);
    clock.advance(ABORT_CANCEL_GRACE_MS);
    expect(sig.sent.map((sent) => sent.sig)).toEqual(["SIGTERM"]);
    clock.advance(5_000);
    expect(sig.sent.map((sent) => sent.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    proc.exit(null);
    const events = await collecting;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
  });

  test("the escalation preamble composes onto the prompt the worker receives", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "do it" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const promptLine = JSON.parse(proc.stdinLines[1] as string) as { message?: string };
    expect(promptLine.message).toBe(composeEscalatedPrompt("do it", "ask"));
    proc.exit(0);
    await collecting;
  });

  test("the access write preset reaches the open line unconfined", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", access: "write" }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const open = JSON.parse(proc.stdinLines[0] as string) as Record<string, unknown>;
    expect(open.tools).toBeUndefined();
    expect(open.disallowedTools).toBeUndefined();
    expect(open.sandbox).toBe(false);
    proc.exit(0);
    await collecting;
  });

  test("a limit-classified terminal error ends the turn with cause limit", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(
      JSON.stringify({
        hcn: "turn-end",
        status: "error",
        message: "You've hit your usage limit",
        errorKind: "rate-limit",
      }),
    );
    proc.exit(0);
    const events = await collecting;
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "usage-limit" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "limit", exitCode: 0 });
  });

  test("a plain stdout limit wall emits the limit event and its failure once", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine("You've hit your usage limit");
    proc.emitLine(turnEnd("finished"));
    proc.exit(0);
    const events = await collecting;
    expect(events.filter((e) => e.kind === "limit")).toHaveLength(1);
    const failures = events.filter((e) => e.kind === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ class: "usage-limit" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "limit" });
  });

  test("a late worker error after the turn deadline cannot replace the timeout verdict", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false });
    const deps = { turnTimeoutMs: 50, spawn: spawner.spawn, clock, signal: sig.signal };
    const collecting = drain(streamTurn(cursorCli, { prompt: "p", questions: "none" }, deps));
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(delta("w"));
    // The deadline fires; the fake ignores the escalation signals, so the
    // worker can still emit its own shutdown error afterwards.
    clock.advance(50);
    proc.emitLine(
      JSON.stringify({ hcn: "turn-end", status: "error", message: "the model exploded" }),
    );
    proc.exit(null);
    const events = await collecting;
    const failures = events.filter((e) => e.kind === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ class: "timeout" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
  });

  test("a late worker error after a caller abort cannot emit a spurious failure", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false });
    const controller = new AbortController();
    const deps = { spawn: spawner.spawn, clock, signal: sig.signal };
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", signal: controller.signal }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(opened());
    proc.emitLine(delta("w"));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    proc.emitLine(
      JSON.stringify({ hcn: "turn-end", status: "error", message: "the model exploded" }),
    );
    clock.advance(ABORT_CANCEL_GRACE_MS);
    clock.advance(5_000);
    proc.exit(null);
    const events = await collecting;
    expect(events.filter((e) => e.kind === "failure")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
  });

  test("an invalid env entry refusal keeps the shared runner's supported field", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const events = await drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", env: { "9bad": "v" } }, deps),
    );
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({
      class: "rejected",
      issue: "invalid-env",
      supported: ["env keys must match /^[A-Za-z_][A-Za-z0-9_]*$/ and no NUL"],
    });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
  });

  test("resume rides the open line", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const collecting = drain(
      streamTurn(cursorCli, { prompt: "p", questions: "none", resume: agentId }, deps),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const open = JSON.parse(proc.stdinLines[0] as string) as Record<string, unknown>;
    expect(open.resume).toBe(agentId);
    proc.exit(0);
    await collecting;
  });
});
