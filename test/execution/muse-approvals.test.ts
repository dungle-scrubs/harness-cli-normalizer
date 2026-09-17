/**
 * Issue #179, seam 1: the read-only MSP observer. muse exec omits pending
 * approvals from stdout, so the runner watches them through a helper
 * `muse serve` process using only the read-only approval/listPending
 * operation - no session load, no lease, no decision.
 */
import { describe, expect, test } from "vitest";
import { APPROVAL_STUCK_POLLS, watchMuseApprovals } from "../../src/execution/muse-approvals.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

const setup = (autoExit = true) => {
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
  );
  const reply = (id: number, result: unknown): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", result }));
  return { proc, clock, sig, spawner, seen, watch, reply, unavailable: () => unavailable };
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
