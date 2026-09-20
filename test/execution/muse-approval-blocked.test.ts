/**
 * Issue #179: a headless muse turn blocked on a pending native approval
 * hangs silently - muse exec omits approvals from stdout and hcn run arms
 * no stall clock. The turn must end promptly with a typed failure naming
 * the blocked subject kind and the remedies. Issue #189: a sandbox
 * escalation (the command asked to run outside the muse sandbox) reports
 * at once and names -- --sandbox-network enabled ahead of --autonomy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  failureFromApprovalUnobserved,
  failureFromBlockedApproval,
  failureFromMuseIncompatibleSurface,
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
    const f = failureFromBlockedApproval("muse", "approval", "network", false);
    expect(f.class).toBe("task");
    expect(f.retryable).toBe(false);
    expect(f.retryable).toBe(retryableOf("task"));
    expect(f.message).toMatch(/muse/);
    expect(f.message).toMatch(/network/);
    expect(f.message).toMatch(/--autonomy/);
    // Byte-identical to the pre-#189 text: the ordinary class keeps it.
    expect(f.message).toBe(
      "Task failed (muse is waiting on a network approval this headless run cannot answer - the run was stopped; answer it in muse, or rerun with --autonomy only if unattended approvals are acceptable) - surface to caller, do not auto-route",
    );
  });

  test("a sandbox escalation names the command, then --sandbox-network enabled before --autonomy", () => {
    // Issue #189: the caller misread "rerun with --autonomy" as the
    // remedy for a command that only needed the network sandbox opened.
    // The message now says what the command asked for and names the
    // narrow passthrough first - it keeps approvals and the filesystem
    // sandbox - with --autonomy demoted to the unattended-approvals case.
    const f = failureFromBlockedApproval("muse", "approval", "shell", true);
    expect(f.class).toBe("task");
    expect(f.retryable).toBe(false);
    expect(f.message).toMatch(/asked to run outside the muse sandbox/);
    expect(f.message).toContain("-- --sandbox-network enabled");
    expect(f.message).toMatch(/keeps approvals and the filesystem sandbox/);
    expect(f.message).toMatch(/answer it in muse/);
    expect(f.message).toMatch(/--autonomy only if unattended approvals are acceptable/);
    expect(f.message.indexOf("--sandbox-network enabled")).toBeLessThan(
      f.message.indexOf("--autonomy"),
    );
  });

  test("user input and an unsafe kind render without payload leakage or --native-approvals", () => {
    const f = failureFromBlockedApproval("muse", "input", "../../x", false);
    expect(f.class).toBe("task");
    expect(f.message).toMatch(/user input/);
    expect(f.message).toMatch(/--autonomy/);
    expect(f.message).not.toMatch(/\.\.\//);
    // --native-approvals is a Codex-only lane; naming it on muse would
    // point at a remedy that refuses.
    expect(f.message).not.toMatch(/--native-approvals/);
  });

  test("an incompatible muse surface is a non-retryable native naming version and remedies", () => {
    // L5: classed native per ADR 0001 - the harness failed on hcn's own
    // protocol call, so retrying the same muse route cannot help.
    const f = failureFromMuseIncompatibleSurface("muse", "1.1.1", "approval/listPending", -32601);
    expect(f.class).toBe("native");
    expect(f.retryable).toBe(false);
    expect(f.retryable).toBe(retryableOf("native"));
    expect(f.message).toMatch(/muse/);
    expect(f.message).toMatch(/1\.1\.1/);
    expect(f.message).toMatch(/approval\/listPending/);
    expect(f.message).toMatch(/-32601/);
    expect(f.message).toMatch(/update hcn/i);
    expect(f.message).toMatch(/--autonomy/);
  });

  test.each([
    [-32600, "invalid-request -32600"],
    [-32602, "invalid-params -32602"],
    [null, "rejected handshake"],
    [42, "error 42"],
  ] as const)("an incompatible muse surface explains native code %s", (code, reason) => {
    const failure = failureFromMuseIncompatibleSurface(
      "muse",
      "1.1.1",
      "approval/listPending",
      code,
    );

    expect(failure).toMatchObject({ class: "native", retryable: false });
    expect(failure.message).toContain(reason);
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

  test("a sandbox escalation from the captured frame ends the turn at once", async () => {
    // Issue #189: the fixture frame (Muse Code 1.3.0) carries
    // sandbox_permissions require_escalated in rawArgs. The turn ends on
    // the first sample - no 30-poll window - with the failure naming
    // -- --sandbox-network enabled ahead of --autonomy. This exercises
    // the third blocked-argument threading through streamTurn.
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
    const frame = JSON.parse(
      readFileSync(
        new URL("../fixtures/msp-1.3.0/listPending.sandbox-escalation.json", import.meta.url),
        "utf8",
      ),
    );
    // First sample, no clock advance: the turn ends at once.
    serveProc.emitLine(JSON.stringify({ id: 2, jsonrpc: "2.0", result: frame }));
    await flush();
    if (!execProc.hasExited) execProc.exit(0);
    if (!serveProc.hasExited) serveProc.exit(0);
    await pending;
    const error = events.find((e) => e.kind === "error");
    expect(JSON.stringify(error)).toMatch(/outside the muse sandbox/);
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", class: "task", retryable: false });
    expect(JSON.stringify(failure)).toMatch(/outside the muse sandbox/);
    expect(JSON.stringify(failure)).toMatch(/--sandbox-network enabled/);
    expect(
      JSON.stringify(failure).indexOf("--sandbox-network enabled") <
        JSON.stringify(failure).indexOf("--autonomy"),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed", exitCode: null });
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

  test("a renamed listPending ends the turn as non-retryable native", async () => {
    // L5: the helper answers method-not-found - the turn ends at once
    // with the incompatible-surface failure, not retryable transport.
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
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await flush();
    if (!execProc.hasExited) execProc.exit(0);
    if (!serveProc.hasExited) serveProc.exit(0);
    await pending;
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ kind: "failure", class: "native", retryable: false });
    expect(JSON.stringify(failure)).toMatch(/MSP surface incompatible/);
    expect(JSON.stringify(failure)).toMatch(/update hcn/i);
    expect(JSON.stringify(failure)).toMatch(/--autonomy/);
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
