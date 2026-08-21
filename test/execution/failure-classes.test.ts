import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { retryableOf } from "../../src/execution/failure.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { museCode } from "../../src/knowledge/muse.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const deps = (proc: FakeProcess, extra: Record<string, unknown> = {}) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig, ...extra };
};

describe("failure classes via streamTurn", () => {
  test("rate-limit class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitStderr("429 Too Many Requests");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("rate-limit");
    expect(done.failure?.retryable).toBe(retryableOf("rate-limit"));
    expect(done.failure?.retryable).toBe(true);
  });

  test("usage-limit class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitStderr("You've hit your usage limit");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("usage-limit");
    expect(done.failure?.retryable).toBe(retryableOf("usage-limit"));
    expect(done.failure?.retryable).toBe(true);
  });

  test("quota class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitStderr("quota exceeded - please add credits");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("quota");
    expect(done.failure?.retryable).toBe(retryableOf("quota"));
    expect(done.failure?.retryable).toBe(true);
  });

  test("auth class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitStderr("Not logged in. Please run /login");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("auth");
    expect(done.failure?.retryable).toBe(retryableOf("auth"));
    expect(done.failure?.retryable).toBe(true);
  });

  test("budget class and retryable (muse)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(museCode, { prompt: "hi" }, d);
    const budgetLine = JSON.stringify({
      payload: {
        kind: "run_terminal",
        terminal: "failed",
        reason: "did not reach a terminal state within 10 steps",
      },
    });
    proc.emitLine(budgetLine);
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("budget");
    expect(done.failure?.retryable).toBe(retryableOf("budget"));
    expect(done.failure?.retryable).toBe(false);
  });

  test("task class and retryable (claude result is_error)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
    proc.emitLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      cause: string;
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("task");
    expect(done.failure?.retryable).toBe(retryableOf("task"));
    expect(done.cause).toBe("failed");
  });

  test("transport class and retryable (spawn failure)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    // Use invalid env to trigger transport? Easier: failToStart
    proc.failToStart("ENOENT: spawn claude ENOENT");
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("transport");
    expect(done.failure?.retryable).toBe(retryableOf("transport"));
    expect(done.failure?.retryable).toBe(true);
  });

  test("rejected class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi", model: "bad-model-xxx" }, d);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("rejected");
    expect(done.failure?.retryable).toBe(retryableOf("rejected"));
    expect(done.failure?.retryable).toBe(false);
  });

  test("native class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitStderr("some native error: unknown flag --bad");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("native");
    expect(done.failure?.retryable).toBe(retryableOf("native"));
    expect(done.failure?.retryable).toBe(false);
  });

  test("timeout class and retryable", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal, turnTimeoutMs: 100 },
    );
    const collected = collect(turn);
    // Advance clock to fire turnTimeoutMs deadline
    clock.advance(101);
    proc.exit(1);
    const events = await collected;
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    expect(done.failure?.class).toBe("timeout");
    expect(done.failure?.retryable).toBe(retryableOf("timeout"));
    expect(done.failure?.retryable).toBe(false);
  });
});
