/**
 * RFC-05 Phase 3: the trust-refused failure class. Cursor refuses an
 * untrusted workspace before any inference runs, so the same work routed
 * elsewhere (or to cursor in a trusted cwd) is safe: retryable derives
 * true from the provider-unavailable family. The message names the
 * trusted-directory remedy first, then what --autonomy grants; it never
 * names --trust, which hcn has no working channel for (probes 40/41).
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  type FailureSummary,
  failureFromTerminalError,
  failureFromTrust,
  retryableOf,
} from "../../src/execution/failure.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { StderrTail, superviseTurn } from "../../src/execution/supervisor.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

describe("failureFromTrust", () => {
  test("names the trusted-directory remedy first, then the autonomy grant, never --trust", () => {
    const f = failureFromTrust("Workspace Trust Required");
    expect(f.class).toBe("trust-refused");
    expect(f.retryable).toBe(true);
    expect(f.retryable).toBe(retryableOf("trust-refused"));
    const remedyAt = f.message.search(/interactively|already trusts/);
    const autonomyAt = f.message.search(/--autonomy/);
    expect(remedyAt).toBeGreaterThanOrEqual(0);
    expect(autonomyAt).toBeGreaterThan(remedyAt);
    expect(f.message).toMatch(/unattended edits and shell/);
    expect(f.message).not.toMatch(/--trust/);
  });

  test("failureFromTerminalError routes cursor trust stderr to trust-refused", () => {
    const f = failureFromTerminalError(cursorCli, "Workspace Trust Required: run agent first");
    expect(f.class).toBe("trust-refused");
    expect(f.retryable).toBe(true);
  });

  test("a nonzero exit with a trust tail classifies trust-refused, not native", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const turn = streamTurn(
      cursorCli,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    proc.emitStderr("Workspace Trust Required: this folder is not trusted");
    proc.exit(1);
    const events: HarnessEvent[] = [];
    for await (const e of turn) events.push(e);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean; message: string };
    };
    expect(done.failure?.class).toBe("trust-refused");
    expect(done.failure?.retryable).toBe(true);
    expect(done.failure?.message).not.toMatch(/--trust/);
  });

  test("a trust line on stderr fails the turn as trust-refused, not tail", async () => {
    const emitted: HarnessEvent[] = [];
    const failed: FailureSummary[] = [];
    const tail = new StderrTail();
    const sup = superviseTurn(cursorCli, "ask", {
      clock: new FakeClock(),
      stallMs: 1000,
      signal: () => {},
      emit: async (e) => {
        emitted.push(e);
      },
      fail: async (f) => {
        failed.push(f);
      },
      tail,
      onStall: () => {},
      onQuestion: () => {},
    });
    await sup.stderrLine("Workspace Trust Required: this folder is not trusted");
    expect(failed.map((f) => f.class)).toEqual(["trust-refused"]);
    expect(emitted.map((e) => e.kind)).toEqual(["error"]);
    expect(tail.snapshot()).toEqual([]);
  });
});
