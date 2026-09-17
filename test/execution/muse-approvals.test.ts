/**
 * Issue #179, seam 1: the read-only MSP observer. muse exec omits pending
 * approvals from stdout, so the runner watches them through a helper
 * `muse serve` process using only the read-only approval/listPending
 * operation - no session load, no lease, no decision.
 */
import { describe, expect, test } from "vitest";
import {
  APPROVAL_STUCK_POLLS,
  MAX_AUTO_RESOLVE_POLLS,
  watchMuseApprovals,
} from "../../src/execution/muse-approvals.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

const setup = (
  autoExit = true,
  incompatible?: (info: { method: string; code: number | null }) => void,
) => {
  const proc = new FakeProcess({ exitOnStdinEnd: false });
  const clock = new FakeClock();
  const sig = fakeSignal({ autoExit });
  const spawner = fakeSpawner([proc]);
  const seen: Array<{ subject: "approval" | "input"; kind: string }> = [];
  let unavailable = 0;
  const watch = watchMuseApprovals(
    "/selected/muse",
    { cwd: "/work" },
    { clock, signal: sig.signal, spawn: spawner.spawn },
    "native-session",
    (subject, kind) => seen.push({ subject, kind }),
    () => {
      unavailable += 1;
    },
    incompatible,
  );
  const reply = (id: number, result: unknown): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", result }));
  const replyError = (id: number, code: number): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", error: { code, message: "probe" } }));
  return {
    proc,
    clock,
    sig,
    spawner,
    seen,
    watch,
    reply,
    replyError,
    unavailable: () => unavailable,
  };
};

describe("watchMuseApprovals", () => {
  test("a transient approval that clears is never reported", async () => {
    const s = setup();
    expect(s.spawner.calls[0]?.argv).toEqual(["/selected/muse", "serve"]);
    s.reply(1, {});
    await flush();
    // Live finding (issue #179 validation): judge-decided approvals for
    // ordinary tool calls appear briefly mid-turn, then clear. A single
    // non-empty sample must not stop the turn.
    s.reply(2, {
      approvals: [{ approvalId: "a", subject: { kind: "network" } }],
      userInputs: [],
    });
    await flush();
    expect(s.seen).toEqual([]);
    s.reply(3, { approvals: [], userInputs: [] });
    await flush();
    s.clock.advance(60_000);
    await flush();
    expect(s.seen).toEqual([]);
    const methods = s.proc.stdinLines.map(
      (line) => (JSON.parse(line) as { method?: string }).method,
    );
    expect(methods).not.toContain("approval/decide");
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("the same approval persisting across polls reports its subject kind", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [{ approvalId: "a", subject: { kind: "network" } }],
      userInputs: [],
    };
    // L2: the stuck window counts consecutive polls, not wall-clock time.
    s.reply(2, pending);
    await flush();
    expect(s.seen).toEqual([]);
    for (let id = 3; id <= APPROVAL_STUCK_POLLS; id++) {
      s.clock.advance(1_000);
      await flush();
      s.reply(id, pending);
      await flush();
      expect(s.seen).toEqual([]);
    }
    s.clock.advance(1_000);
    await flush();
    s.reply(APPROVAL_STUCK_POLLS + 1, pending);
    await flush();
    expect(s.seen).toEqual([{ subject: "approval", kind: "network" }]);
    const methods = s.proc.stdinLines.map(
      (line) => (JSON.parse(line) as { method?: string }).method,
    );
    expect(methods).not.toContain("approval/decide");
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a judge-escalated approval reports immediately - no human can answer headless", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    s.reply(2, {
      approvals: [{ approvalId: "a", judgeEscalated: true, subject: { kind: "shell" } }],
      userInputs: [],
    });
    await flush();
    expect(s.seen).toEqual([{ subject: "approval", kind: "shell" }]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("churned approval ids never stabilize into a report", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    for (let id = 2; id < 40; id++) {
      s.reply(id, {
        approvals: [{ approvalId: `a-${id}`, subject: { kind: "network" } }],
        userInputs: [],
      });
      await flush();
      s.clock.advance(1_000);
    }
    await flush();
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a pending user-input request reports input, never an approval", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = { approvals: [], userInputs: [{ userInputId: "u" }] };
    s.reply(2, pending);
    await flush();
    expect(s.seen).toEqual([]);
    for (let id = 3; id <= APPROVAL_STUCK_POLLS; id++) {
      s.clock.advance(1_000);
      await flush();
      s.reply(id, pending);
      await flush();
      expect(s.seen).toEqual([]);
    }
    s.clock.advance(1_000);
    await flush();
    s.reply(APPROVAL_STUCK_POLLS + 1, pending);
    await flush();
    expect(s.seen).toEqual([{ subject: "input", kind: "input" }]);
    await s.watch.close();
  });

  test("a clock jump without polls never stabilizes a pending request", async () => {
    // L2: wall-clock time alone must not stop the turn. A laptop sleep
    // advances the clock with no polls flowing; the count is unchanged.
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [{ approvalId: "a", subject: { kind: "network" } }],
      userInputs: [],
    };
    s.reply(2, pending);
    await flush();
    expect(s.seen).toEqual([]);
    s.clock.advance(3_600_000);
    await flush();
    // The jump fired the poll timer, but no reply arrived, so the count
    // stays at one sighting: still nothing reported, still observing.
    expect(s.seen).toEqual([]);
    expect(s.unavailable()).toBe(0);
    // L2: one more pending reply after the jump is only the second
    // sighting. Wall-clock time alone must never stabilize the window -
    // a wall-clock condition (elapsed >= 30s reports) fails this test.
    s.reply(3, pending);
    await flush();
    expect(s.seen).toEqual([]);
    expect(s.unavailable()).toBe(0);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("empty polls schedule the next read without reporting", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    s.reply(2, { approvals: [], userInputs: [] });
    await flush();
    expect(s.seen).toEqual([]);
    s.clock.advance(1_000);
    await flush();
    const methods = s.proc.stdinLines.map(
      (line) => (JSON.parse(line) as { method?: string }).method,
    );
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "approval/listPending",
      "approval/listPending",
    ]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a helper that never answers initialize is unobservable after the start budget", async () => {
    // M1: a slow helper start is allowed room (parallel fan-out); only
    // past the start budget does the pending set count as unobservable.
    const s = setup();
    s.clock.advance(29_000);
    await flush();
    expect(s.unavailable()).toBe(0);
    s.clock.advance(1_000);
    await flush();
    expect(s.unavailable()).toBe(1);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("unanswered polls fail closed only after consecutive unreadable samples", async () => {
    // M1/H1: one unanswered poll is skipped and retried, not a verdict.
    const s = setup();
    s.reply(1, {});
    await flush();
    s.reply(2, { approvals: [], userInputs: [] });
    await flush();
    expect(s.unavailable()).toBe(0);
    // Two unanswered polls: still observing.
    for (let id = 3; id <= 4; id++) {
      s.clock.advance(1_000);
      await flush();
      expect(s.unavailable()).toBe(0);
      s.clock.advance(10_000);
      await flush();
      expect(s.unavailable()).toBe(0);
    }
    // The third consecutive unanswered poll closes observation.
    s.clock.advance(1_000);
    await flush();
    s.clock.advance(10_000);
    await flush();
    expect(s.unavailable()).toBe(1);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("an RPC error or malformed reply is skipped, failing closed only in a row", async () => {
    // H1: a single unreadable sample is skipped and the next poll tried.
    for (const line of [
      JSON.stringify({ id: 2, error: { code: -32020, message: "native internal details" } }),
      JSON.stringify({ id: 2, result: { approvals: null } }),
      "not JSON",
    ]) {
      const s = setup();
      s.reply(1, {});
      await flush();
      s.proc.emitLine(line);
      await flush();
      expect(s.unavailable()).toBe(0);
      expect(s.seen).toEqual([]);
      await s.watch.close();
      expect(s.clock.pendingTimerCount).toBe(0);
    }
  });

  test("three consecutive malformed replies fail closed without reporting", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    for (let id = 2; id <= 4; id++) {
      s.proc.emitLine(JSON.stringify({ id, error: { code: -32020, message: "x" } }));
      await flush();
      if (id < 4) {
        expect(s.unavailable()).toBe(0);
        s.clock.advance(1_000);
        await flush();
      }
    }
    expect(s.unavailable()).toBe(1);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a reply over 64KB on a healthy turn is a normal sample, not a failure", async () => {
    // H1: a judge-decided approval can carry more than 64KB of rawArgs. A
    // poll that lands in that window must not end the turn - the observer
    // channel carries its own large line limit.
    const s = setup();
    s.reply(1, {});
    await flush();
    s.reply(2, {
      approvals: [{ approvalId: "a", subject: { kind: "shell" }, rawArgs: "x".repeat(70_000) }],
      userInputs: [],
    });
    await flush();
    expect(s.unavailable()).toBe(0);
    expect(s.seen).toEqual([]);
    s.reply(3, { approvals: [], userInputs: [] });
    await flush();
    expect(s.unavailable()).toBe(0);
    expect(s.seen).toEqual([]);
    s.clock.advance(60_000);
    await flush();
    expect(s.unavailable()).toBe(0);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a large pending reply on consecutive polls is readable, never unobservable", async () => {
    // L3: pins OBSERVER_LINE_MAX above real approval frames. The same
    // 70KB pending reply on 3 polls in a row is three normal samples
    // (count 3, far below the stuck window) - not three unreadable
    // samples. Lowering the limit back to 64KB fails this test.
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [{ approvalId: "a", subject: { kind: "shell" }, rawArgs: "x".repeat(70_000) }],
      userInputs: [],
    };
    for (let id = 2; id <= 4; id++) {
      if (id > 2) {
        s.clock.advance(1_000);
        await flush();
      }
      s.reply(id, pending);
      await flush();
      expect(s.unavailable()).toBe(0);
      expect(s.seen).toEqual([]);
    }
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a very large autoResolutionMs is capped at 5 minutes of polls", async () => {
    // L4: a user input carrying a very large autoResolutionMs must not
    // hold the turn past 5 minutes of polls. Past that the field reads
    // as a client-screen timer, not a self-resolution deadline - an
    // unbounded wait is the #179 hang again when exec never resolves it.
    const s = setup();
    s.reply(1, {});
    await flush();
    const pending = {
      approvals: [],
      userInputs: [{ userInputId: "u", autoResolutionMs: 3_600_000 }],
    };
    for (let id = 2; id <= MAX_AUTO_RESOLVE_POLLS; id++) {
      if (id > 2) {
        s.clock.advance(1_000);
        await flush();
      }
      s.reply(id, pending);
      await flush();
      expect(s.seen).toEqual([]);
    }
    expect(s.unavailable()).toBe(0);
    s.clock.advance(1_000);
    await flush();
    s.reply(MAX_AUTO_RESOLVE_POLLS + 1, pending);
    await flush();
    expect(s.seen).toEqual([{ subject: "input", kind: "input" }]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a method-not-found poll error reports an incompatible surface at once", async () => {
    // L5: a muse release that renames approval/listPending answers
    // -32601. Retrying the same route cannot help, so this reports at
    // once instead of failing closed as retryable transport.
    const incompatible: Array<{ method: string; code: number | null }> = [];
    const s = setup(true, (info) => incompatible.push(info));
    s.reply(1, {});
    await flush();
    s.replyError(2, -32601);
    await flush();
    expect(incompatible).toEqual([{ method: "approval/listPending", code: -32601 }]);
    expect(s.unavailable()).toBe(0);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("a handshake rejection reports an incompatible surface, a server error stays transient", async () => {
    // L5: a live helper that rejects initialize with method-not-found,
    // invalid-request, or invalid-params speaks a different MSP surface.
    // A server-error (-32020) on the handshake is still one skipped
    // sample: observation continues.
    for (const code of [-32601, -32600, -32602]) {
      const incompatible: Array<{ method: string; code: number | null }> = [];
      const s = setup(true, (info) => incompatible.push(info));
      s.replyError(1, code);
      await flush();
      expect(incompatible).toEqual([{ method: "initialize", code }]);
      expect(s.unavailable()).toBe(0);
      await s.watch.close();
      expect(s.clock.pendingTimerCount).toBe(0);
    }
    const incompatible: Array<{ method: string; code: number | null }> = [];
    const s = setup(true, (info) => incompatible.push(info));
    s.replyError(1, -32020);
    await flush();
    expect(incompatible).toEqual([]);
    expect(s.unavailable()).toBe(0);
    // Observation is still alive: the handshake is retried and a poll follows.
    s.reply(2, {});
    await flush();
    s.reply(3, { approvals: [], userInputs: [] });
    await flush();
    expect(s.unavailable()).toBe(0);
    expect(incompatible).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("closing ignores late results and terminates a wedged helper", async () => {
    const s = setup(false);
    s.reply(1, {});
    await flush();
    const closing = s.watch.close();
    s.reply(2, { approvals: [{ approvalId: "a" }], userInputs: [] });
    s.clock.advance(5_000);
    await closing;
    expect(s.seen).toEqual([]);
    expect(s.unavailable()).toBe(0);
    expect(s.sig.sent.map((signal) => signal.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(s.clock.pendingTimerCount).toBe(0);
    await s.watch.close();
    expect(s.sig.sent).toHaveLength(2);
  });
});
