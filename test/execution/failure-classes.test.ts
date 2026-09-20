import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  failureFromNative,
  failureFromLimit,
  failureFromTerminalError,
  failureFromTimeout,
  failureFromTrust,
  isLimitFailure,
  retryableOf,
} from "../../src/execution/failure.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
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

describe("failureFromTerminalError limit walls (issue #198)", () => {
  const wall =
    "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 24th, 2026 7:24 AM.";

  test("codex usage wall with U+2019 returns usage-limit, retryable", () => {
    expect(wall).toContain("’ve");
    const failure = failureFromTerminalError(codexCli, wall);
    expect(failure.class).toBe("usage-limit");
    expect(failure.retryable).toBe(true);
  });

  test("an auth message still returns auth", () => {
    const failure = failureFromTerminalError(codexCli, "401 unauthorized - session expired");
    expect(failure.class).toBe("auth");
    expect(failure.retryable).toBe(true);
  });

  test("an ordinary error still returns task", () => {
    const failure = failureFromTerminalError(codexCli, "codex failed");
    expect(failure.class).toBe("task");
    expect(failure.retryable).toBe(false);
  });
});

describe("failure classes via streamTurn (continued)", () => {
  test("unavailable class and retryable", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    const msg = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    proc.emitLine(msg);
    // pi-model-unavailable style terminal error routed via failureFromTerminalError
    // For claude we trigger via error terminal, for generic unavailable we use stderr tail path
    // Use stderr unavailable phrasing on nonzero exit path
    proc.emitStderr("model_not_found: Invalid model identifier");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as {
      failure?: { class: string; retryable: boolean };
    };
    // unavailable is retryable; verify via direct retryableOf as well
    expect(retryableOf("unavailable")).toBe(true);
    // Stream path for unavailable via stderr tail after transport check
    expect(done.failure?.class).toBe("unavailable");
    expect(done.failure?.retryable).toBe(true);
  });
});

describe("failure message contracts", () => {
  test("timeout and trust failures keep their actionable remedies", () => {
    expect(failureFromTimeout()).toEqual({
      class: "timeout",
      message:
        "Timeout: run exceeded its wall-clock budget and was killed (SIGTERM, then SIGKILL after grace) - raise --timeout for this workload or split the task",
      retryable: false,
    });
    expect(failureFromTrust("untrusted workspace")).toEqual({
      class: "trust-refused",
      message:
        "Workspace trust refused (untrusted workspace) - run `agent` interactively in that directory once, or use a directory Cursor already trusts; --autonomy grants unattended edits and shell for that run without persisting trust",
      retryable: true,
    });
  });

  test("native failures retain only the last three stderr lines and the native exit code", () => {
    expect(failureFromNative(7, ["first", "second", "third", "fourth"])).toEqual({
      class: "native",
      message:
        "NATIVE ERROR from harness: second | third | fourth - the harness rejected or failed on its own arguments; this is not an hcn error",
      nativeExitCode: 7,
      retryable: false,
    });
    expect(failureFromNative(null, [])).toEqual({
      class: "native",
      message:
        "NATIVE ERROR from harness: exit null - the harness rejected or failed on its own arguments; this is not an hcn error",
      nativeExitCode: undefined,
      retryable: false,
    });
  });

  test("limit codes retain their normalized class and limit identity", () => {
    expect(failureFromLimit("rate-limit")).toMatchObject({
      class: "rate-limit",
      code: "rate-limit",
      retryable: true,
    });
    expect(failureFromLimit("credits")).toMatchObject({
      class: "quota",
      code: "credits",
      retryable: true,
    });
    expect(failureFromLimit("quota")).toMatchObject({
      class: "quota",
      code: "quota",
      retryable: true,
    });
    expect(failureFromLimit("weekly-limit")).toMatchObject({
      class: "usage-limit",
      code: "weekly-limit",
      retryable: true,
    });
  });

  test("only normalized limit failures satisfy the limit predicate", () => {
    for (const code of ["rate-limit", "credits", "weekly-limit"] as const) {
      expect(isLimitFailure(failureFromLimit(code))).toBe(true);
    }
    expect(isLimitFailure(failureFromTrust())).toBe(false);
    expect(isLimitFailure(failureFromTimeout())).toBe(false);
  });
});
