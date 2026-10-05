import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  failureFromLimit,
  failureFromNative,
  failureFromNativeRejection,
  failureFromStderrTail,
  failureFromTerminalError,
  failureFromTimeout,
  failureFromTrust,
  isLimitFailure,
  retryableOf,
} from "../../src/execution/failure.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
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

describe("failureFromTerminalError reset hints (issue #325)", () => {
  const liveWall =
    "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 11:58 PM.";
  // The +07:00 zone the live capture rendered in; the printed minute is
  // truncated, so the resolved bound is its end (2026-10-03T16:59:00Z).
  const zoneClock = {
    now: () => Date.parse("2026-09-30T01:00:00Z"),
    utcOffsetMinutes: () => 420,
  };

  test("a codex wall stating a reset time carries resetsAt when a clock is given", () => {
    const failure = failureFromTerminalError(codexCli, liveWall, zoneClock);
    expect(failure.class).toBe("usage-limit");
    expect(failure.resetsAt).toBe(Date.parse("2026-10-03T16:59:00Z"));
  });

  test("without a clock the same wall carries no resetsAt (existing behaviour)", () => {
    const failure = failureFromTerminalError(codexCli, liveWall);
    expect(failure.class).toBe("usage-limit");
    expect(failure.resetsAt).toBeUndefined();
  });

  test("pi's openai-codex 429 wording classifies usage-limit and carries resetsAt", () => {
    // pi renders the backend resets_at as rounded minutes remaining; the
    // resolved bound is the top of that rounding (+30 s).
    const failure = failureFromTerminalError(
      piCli,
      "pi turn ended with stopReason error: You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min.",
      zoneClock,
    );
    expect(failure.class).toBe("usage-limit");
    expect(failure.resetsAt).toBe(Date.parse("2026-09-30T01:00:00Z") + 42 * 60_000 + 30_000);
  });

  test("a wall with no reset phrasing never guesses one", () => {
    const failure = failureFromTerminalError(
      piCli,
      "pi turn ended with stopReason error: Codex error: The usage limit has been reached",
      zoneClock,
    );
    expect(failure.class).toBe("usage-limit");
    expect(failure.resetsAt).toBeUndefined();
  });
});

describe("failureFromTerminalError limit walls (issue #322: pi provider 429 bodies)", () => {
  // The failure recorded in the issue: pi on minimax/MiniMax-M3 ended the
  // turn with stopReason error and the provider's 429 body embedded in
  // errorMessage; hcn 0.9.0 classified it task, so the delegate fallback
  // walk stopped instead of advancing. Provider request id preserved from
  // the issue. Neither phrasing matched before the fix: "has been" sat
  // between the noun and the verb, and rate_limit_error is underscored.
  const errorMessage =
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"The Token Plan usage limit has been reached. ... (2067)"},"request_id":"070a71d3f21c250183375fccf3a9f01c"}';

  test("a provider usage-limit body classifies usage-limit, retryable", () => {
    const failure = failureFromTerminalError(
      piCli,
      `pi turn ended with stopReason error: ${errorMessage}`,
    );
    expect(failure.class).toBe("usage-limit");
    expect(failure.retryable).toBe(true);
    // Usage matchers precede rate-limit ones (first-match-wins): the body
    // carries both the usage wall and the 429, and the wall it names wins.
  });

  test("a 429 body without usage phrasing still classifies rate-limit", () => {
    const failure = failureFromTerminalError(
      piCli,
      'pi turn ended with stopReason error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests, slow down"}}',
    );
    expect(failure.class).toBe("rate-limit");
    expect(failure.retryable).toBe(true);
  });

  test("a bare 429 inside an identifier is still not a wall", () => {
    const failure = failureFromTerminalError(
      piCli,
      'pi turn ended with stopReason error: bad request for request_id "req_0429f00d-429a"',
    );
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

  test("native failure message masks secret-shaped tokens; a plain line is unchanged", () => {
    const redacted = failureFromNative(1, ["auth failed for sk-abcdefghijk123 token=xyz"]);
    expect(redacted.message).toContain("auth failed for [redacted] [redacted]");
    expect(redacted.message).not.toContain("sk-abcdefghijk123");
    expect(redacted.message).not.toContain("token=xyz");
    const nearMiss = failureFromNative(1, ["risk-free sk-short"]);
    expect(nearMiss.message).toContain("risk-free sk-short");
    expect(nearMiss.message).not.toContain("[redacted]");
    const plain = failureFromNative(1, ["error: unknown flag --bad"]);
    expect(plain.message).toContain("error: unknown flag --bad");
    expect(plain.message).not.toContain("[redacted]");
  });

  test("native failure masks a secret split by the 512-character bound", () => {
    // 501 + 14 = 515 chars; the bound slices at 512, leaving a token
    // prefix too short for SECRETISH to match. Redact before the bound
    // so the cut end is masked.
    const redacted = failureFromNative(1, [
      `${"x".repeat(501)} sk-abcdefghijk123${"y".repeat(50)}`,
    ]);
    expect(redacted.message).toContain(
      `${"x".repeat(501)} [redacted] - the harness rejected or failed on its own arguments; this is not an hcn error`,
    );
    expect(redacted.message).not.toContain("sk-abcdefg");
    expect(redacted.message).not.toContain("sk-abcdefghijk123");
  });

  test("stderr-tail transport line is redacted and bounded to 512 chars", () => {
    const transport = failureFromStderrTail(piCli, 1, ["WebSocket closed 1006 token=abc123"]);
    expect(transport.class).toBe("transport");
    expect(transport.message).toContain("[redacted]");
    expect(transport.message).not.toContain("abc123");
    const huge = "a".repeat(100_000);
    const longTransport = failureFromStderrTail(piCli, 1, [`stream disconnected: ${huge}`]);
    expect(longTransport.message.length).toBeLessThanOrEqual(512 + 200);
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

// Issues #344 / #345: the harness refused a command hcn wrote. Work did not
// run, so a work verdict (task) is wrong; specific walls (auth, limits,
// transport, unavailable) keep their class.
describe("failureFromNativeRejection", () => {
  test("a trust refusal remains trust-refused", () => {
    const failure = failureFromNativeRejection(cursorCli, "Workspace Trust Required");
    expect(failure).toMatchObject({ class: "trust-refused", retryable: true });
    expect(failure.message).toContain("Workspace Trust Required");
  });

  test("codex config error returns native", () => {
    const failure = failureFromNativeRejection(
      codexCli,
      "jsonrpc request failed: hcn-identity - failed to load configuration: <path>/config.toml:1:9: string values must be quoted, expected literal string",
    );
    expect(failure.class).toBe("native");
    expect(failure.retryable).toBe(false);
  });

  test("pi No API key returns auth", () => {
    const failure = failureFromNativeRejection(
      piCli,
      "rpc command failed: prompt - No API key found for the selected model. Set one in your environment or auth.json.",
    );
    expect(failure.class).toBe("auth");
    expect(failure.retryable).toBe(true);
  });

  test("a transport-class message remains transport", () => {
    const failure = failureFromNativeRejection(piCli, "WebSocket closed 1006");
    expect(failure.class).toBe("transport");
    expect(failure.retryable).toBe(true);
  });
});
