/**
 * Issue #179, seam 1: the read-only MSP observer. muse exec omits pending
 * approvals from stdout, so the runner watches them through a helper
 * `muse serve` process using only the read-only approval/listPending
 * operation - no session load, no lease, no decision.
 */
import { describe, expect, test } from "vitest";
import { watchMuseApprovals } from "../../src/execution/muse-approvals.js";
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
    s.reply(2, pending);
    await flush();
    expect(s.seen).toEqual([]);
    s.clock.advance(29_000);
    s.reply(3, pending);
    await flush();
    expect(s.seen).toEqual([]);
    s.clock.advance(1_000);
    s.reply(4, pending);
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
    s.reply(2, { approvals: [], userInputs: [{ userInputId: "u" }] });
    await flush();
    expect(s.seen).toEqual([]);
    s.clock.advance(30_000);
    s.reply(3, { approvals: [], userInputs: [{ userInputId: "u" }] });
    await flush();
    expect(s.seen).toEqual([{ subject: "input", kind: "input" }]);
    await s.watch.close();
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

  test("a missing control-plane response is unknown, never an empty list", async () => {
    const s = setup();
    s.clock.advance(10_000);
    await flush();
    expect(s.unavailable()).toBe(1);
    expect(s.seen).toEqual([]);
    await s.watch.close();
    expect(s.clock.pendingTimerCount).toBe(0);
  });

  test("an RPC error or malformed reply ends observation without reporting", async () => {
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
      expect(s.unavailable()).toBe(1);
      expect(s.seen).toEqual([]);
      await s.watch.close();
      expect(s.clock.pendingTimerCount).toBe(0);
    }
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
