/**
 * Issue #179: a headless muse turn blocked on a pending native approval
 * hangs silently - muse exec omits approvals from stdout and hcn run arms
 * no stall clock. The turn must end promptly with a typed failure naming
 * the blocked subject kind and the remedies.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  failureFromApprovalUnobserved,
  failureFromBlockedApproval,
  retryableOf,
} from "../../src/execution/failure.js";
import { APPROVAL_STUCK_POLLS } from "../../src/execution/muse-approvals.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { museCode } from "../../src/knowledge/muse.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

describe("failureFromBlockedApproval", () => {
  test("a blocked network approval is a non-retryable task naming the kind and --autonomy", () => {
    const f = failureFromBlockedApproval("muse", "approval", "network");
    expect(f.class).toBe("task");
    expect(f.retryable).toBe(false);
    expect(f.retryable).toBe(retryableOf("task"));
    expect(f.message).toMatch(/muse/);
    expect(f.message).toMatch(/network/);
    expect(f.message).toMatch(/--autonomy/);
  });

  test("user input and an unsafe kind render without payload leakage or --native-approvals", () => {
    const f = failureFromBlockedApproval("muse", "input", "../../x");
    expect(f.class).toBe("task");
    expect(f.message).toMatch(/user input/);
    expect(f.message).toMatch(/--autonomy/);
    expect(f.message).not.toMatch(/\.\.\//);
    // --native-approvals is a Codex-only lane; naming it on muse would
    // point at a remedy that refuses.
    expect(f.message).not.toMatch(/--native-approvals/);
  });

  test("an unobservable pending set is a retryable transport, never an empty approval list", () => {
    // M1: hcn's own supervision broke, not the model's work - retryable
    // transport naming hcn's inability to observe, never "update muse".
    const f = failureFromApprovalUnobserved("muse");
    expect(f.class).toBe("transport");
    expect(f.retryable).toBe(true);
    expect(f.retryable).toBe(retryableOf("transport"));
    expect(f.message).toMatch(/could not be observed/);
    expect(f.message).not.toMatch(/update muse/);
  });
});

describe("a pending native approval during a muse turn", () => {
  test("ends the turn promptly with a typed failure naming the subject", async () => {
    const execProc = new FakeProcess();
    const serveProc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([execProc, serveProc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const events: HarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of streamTurn(
        museCode,
        { prompt: "hi", cwd: "/work" },
        {
          spawn: spawner.spawn,
          clock,
          signal: sig.signal,
        },
      )) {
        events.push(event);
      }
    })();
    // Synthetic identity only: the regression is that no approval signal
    // arrives on stdout - the observer sees the pending approval instead.
    execProc.emitLine(JSON.stringify({ stream: { id: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" } }));
    await flush();
    expect(spawner.calls[1]?.argv).toEqual(["muse", "serve"]);
    expect(spawner.calls[1]?.opts).toMatchObject({ cwd: "/work", stdin: "pipe" });
    serveProc.emitLine(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }));
    await flush();
    const stuck = {
      approvals: [{ approvalId: "a", subject: { kind: "network" } }],
      userInputs: [],
    };
    // A single sample is transient (judge-decided approvals clear fast);
    // the same identity persisting across consecutive polls ends the turn.
    for (let id = 2; id <= APPROVAL_STUCK_POLLS + 1; id++) {
      if (id > 2) {
        clock.advance(1_000);
        await flush();
      }
      serveProc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", result: stuck }));
      await flush();
    }
    // Release the fake on the red path, so a regression cannot hang the runner.
    if (!execProc.hasExited) execProc.exit(0);
    if (!serveProc.hasExited) serveProc.exit(0);
    await pending;
    const error = events.find((e) => e.kind === "error");
    expect(error).toMatchObject({ kind: "error" });
    expect(JSON.stringify(error)).toMatch(/network/);
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", class: "task", retryable: false });
    expect(JSON.stringify(failure)).toMatch(/network/);
    expect(JSON.stringify(failure)).toMatch(/--autonomy/);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed", exitCode: null });
    expect((events.at(-1) as { failure?: { class: string } }).failure?.class).toBe("task");
    expect(sig.sent.some((s) => s.proc === execProc && s.sig === "SIGTERM")).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
  });

  test("an unobservable pending set fails closed after identity", async () => {
    const execProc = new FakeProcess();
    const serveProc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([execProc, serveProc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const events: HarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of streamTurn(
        museCode,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock,
          signal: sig.signal,
        },
      )) {
        events.push(event);
      }
    })();
    execProc.emitLine(JSON.stringify({ stream: { id: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" } }));
    await flush();
    // The helper dies before answering: the pending set is unknown, never empty.
    serveProc.exit(1);
    await flush();
    if (!execProc.hasExited) execProc.exit(0);
    await pending;
    expect(events[0]?.kind).toBe("identity");
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", class: "transport", retryable: true });
    expect(JSON.stringify(failure)).toMatch(/could not be observed/);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
    expect(clock.pendingTimerCount).toBe(0);
  });

  test("a clean turn with empty polls stays clean and reaps the helper", async () => {
    const execProc = new FakeProcess();
    const serveProc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([execProc, serveProc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const events: HarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of streamTurn(
        museCode,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock,
          signal: sig.signal,
        },
      )) {
        events.push(event);
      }
    })();
    execProc.emitLine(JSON.stringify({ stream: { id: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" } }));
    await flush();
    serveProc.emitLine(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }));
    await flush();
    serveProc.emitLine(
      JSON.stringify({ id: 2, jsonrpc: "2.0", result: { approvals: [], userInputs: [] } }),
    );
    await flush();
    execProc.emitLine(
      JSON.stringify({ payload: { kind: "run_terminal", terminal: "completed", text: "done" } }),
    );
    execProc.exit(0);
    await pending;
    expect(events.some((e) => e.kind === "failure")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: 0 });
    expect(serveProc.hasExited).toBe(true);
    expect(serveProc.outputDisposed).toBe(true);
    expect(clock.pendingTimerCount).toBe(0);
  });

  test("an approval arriving after the timeout stays a timeout", async () => {
    // L3: --timeout fires and SIGTERM is sent; a judge-escalated approval
    // landing before the child exits must not overwrite the timeout.
    const execProc = new FakeProcess();
    const serveProc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([execProc, serveProc]);
    // The child ignores SIGTERM, so it is still alive when the approval
    // lands - the exited guard cannot mask the missing watchdog guard.
    const sig = fakeSignal({ autoExit: false });
    const clock = new FakeClock();
    const events: HarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of streamTurn(
        museCode,
        { prompt: "hi" },
        { spawn: spawner.spawn, clock, signal: sig.signal, turnTimeoutMs: 5_000 },
      )) {
        events.push(event);
      }
    })();
    execProc.emitLine(JSON.stringify({ stream: { id: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" } }));
    await flush();
    serveProc.emitLine(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }));
    await flush();
    clock.advance(5_000);
    await flush();
    expect(execProc.hasExited).toBe(false);
    // The escalated approval lands after the watchdog killed the turn
    // (id 2 is the poll still outstanding - the reply must match it).
    serveProc.emitLine(
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        result: {
          approvals: [{ approvalId: "a", judgeEscalated: true, subject: { kind: "shell" } }],
          userInputs: [],
        },
      }),
    );
    await flush();
    execProc.exit(null);
    if (!serveProc.hasExited) serveProc.exit(0);
    await pending;
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", class: "timeout" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "killed" });
    expect(clock.pendingTimerCount).toBe(0);
  });

  test("a harness without the observer field spawns no helper", async () => {
    const { claudeCode } = await import("../../src/knowledge/claude-code.js");
    const execProc = new FakeProcess();
    const spawner = fakeSpawner([execProc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const events: HarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of streamTurn(
        claudeCode,
        { prompt: "hi" },
        {
          spawn: spawner.spawn,
          clock,
          signal: sig.signal,
        },
      )) {
        events.push(event);
      }
    })();
    execProc.emitLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "m" }),
    );
    await flush();
    execProc.exit(0);
    await pending;
    expect(spawner.calls).toHaveLength(1);
    expect(events.some((e) => e.kind === "failure")).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
