import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const depsFor = (proc: FakeProcess) => {
  const clock = new FakeClock();
  const sig = fakeSignal();
  const spawner = fakeSpawner([proc]);
  return { spawn: spawner.spawn, clock, signal: sig.signal };
};

describe("F-07 terminal error record ends clean", () => {
  test("claude result is_error true yields task failure and cause failed", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    proc.emitLine(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
    proc.emitLine(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" }));
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("replay pi-autherror.ndjson through streamTurn ends with task failure and cause failed", async () => {
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-autherror.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(piCli, { prompt: "Reply with only: alpha" }, d);
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") proc.emitLine(line);
    }
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("replay pi-usage-limit.ndjson: a provider 429 usage wall classifies usage-limit so fallback walks advance (issue #322)", async () => {
    // Reconstructed from the failure recorded in issue #322 (hcn 0.9.0,
    // pi on minimax/MiniMax-M3, provider request id preserved): the turn
    // ended with stopReason error and the provider's 429 body riding in
    // errorMessage; the stream skeleton mirrors the real pi captures in
    // fixtures/harnesses (pi-model-unavailable.ndjson), the middle of the
    // provider message stayed as the issue elided it. Before the fix this
    // classified task (retryable false) and the delegate fallback walk
    // stopped; usage-limit is provider-unavailable, so routing the same
    // work elsewhere is safe.
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-usage-limit.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(piCli, { prompt: "Reply with only: alpha" }, d);
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") proc.emitLine(line);
    }
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string; retryable: boolean } }
      | undefined;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    // limitSeen promotes the turn's cause: a wall ended it, not the work.
    expect(done?.cause).toBe("limit");
    expect(done?.failure?.class).toBe("usage-limit");
    expect(done?.failure?.retryable).toBe(true);
  });

  test("replay pi-terminated-recovered.ndjson: a superseded stopReason error does not poison the verdict", async () => {
    // Live capture (pi 0.85.1, lmstudio qwen3.6-35b-a3b-ud-mlx, session
    // first created under zai/glm-5.3): resuming aborted the first
    // continuation once - assistant message_end stopReason "error",
    // errorMessage "terminated" (pi's own fetch-abort wording), zero
    // usage, empty content - then pi retried in-process and the next
    // assistant message_end completed the turn ("pi-alive-6", stop,
    // exit 0, empty stderr). The failed attempt is evidence; the answer
    // is the verdict.
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-terminated-recovered.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(piCli, { prompt: "Reply with only: pi-alive-6" }, d);
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") proc.emitLine(line);
    }
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    // The answer arrived and is the verdict: clean turn, no failure.
    expect(events.some((e) => e.kind === "message" && e.text.includes("pi-alive-6"))).toBe(true);
    expect(events.some((e) => e.kind === "failure")).toBe(false);
    expect(done?.cause).toBe("clean");
    expect(done?.failure).toBeUndefined();
    // The aborted attempt still surfaces - as non-terminal evidence only.
    const errors = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "error" }> => e.kind === "error",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("terminated"))).toBe(true);
    expect(errors.every((e) => e.terminal !== true)).toBe(true);
  });

  test("codex turn.failed yields task failure", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      // Synthetic terminal event, per Codex's public exec event contract.
      JSON.stringify({ type: "turn.failed", error: { message: "codex failed" } }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("codex turn.failed carrying a WebSocket close classifies transport", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "stream disconnected before completion: websocket closed by server before response.completed",
        },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string; retryable: boolean } }
      | undefined;
    expect(done?.failure?.class).toBe("transport");
    expect(done?.failure?.retryable).toBe(true);
  });

  test("issue #346: codex 'stream disconnected before completion' with a network cause classifies transport, retryable", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string; retryable: boolean } }
      | undefined;
    expect(done?.failure?.class).toBe("transport");
    expect(done?.failure?.retryable).toBe(true);
    expect(done?.cause).toBe("failed");
  });

  test("issue #346: codex 'stream disconnected before completion: 401 Unauthorized' stays auth (precedence beats transport)", async () => {
    // failureFromTerminalError checks auth before transport, so a codex
    // stream disconnect whose inner cause is a 401 classifies auth. The
    // brief requirement: "a codex `stream disconnected before completion:
    // ... 401 Unauthorized` still yields `auth`".
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      JSON.stringify({
        type: "turn.failed",
        error: {
          message: "stream disconnected before completion: unexpected status 401 Unauthorized",
        },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string; retryable: boolean; authKind?: string } }
      | undefined;
    expect(done?.failure?.class).toBe("auth");
    expect(done?.failure?.retryable).toBe(true);
  });

  test("codex fatal stream error stays failed after a nonfatal warning", async () => {
    const proc = new FakeProcess();
    const turn = streamTurn(codexCli, { prompt: "hi", questions: "none" }, depsFor(proc));
    // Synthetic sequence from the public Codex event shapes.
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "error", message: "A nonfatal notice" },
      }),
    );
    proc.emitLine(JSON.stringify({ type: "error", message: "Native stream failed" }));
    proc.exit(0);
    const events = await collect(turn);
    expect(events).toContainEqual({ kind: "error", message: "A nonfatal notice" });
    expect(events).toContainEqual({
      kind: "error",
      message: "Native stream failed",
      terminal: true,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "task" },
    });
  });

  test("issue #198: codex usage wall on a JSON error event classifies usage-limit with cause limit", async () => {
    const wall =
      "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 24th, 2026 7:24 AM.";
    expect(wall).toContain("’ve");
    const proc = new FakeProcess();
    const turn = streamTurn(codexCli, { prompt: "hi", questions: "none" }, depsFor(proc));
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(JSON.stringify({ type: "error", message: wall }));
    proc.exit(1);
    const events = await collect(turn);
    expect(events).toContainEqual({ kind: "error", message: wall, terminal: true });
    const failures = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "failure" }> => e.kind === "failure",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ class: "usage-limit", retryable: true });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "limit",
      failure: { class: "usage-limit" },
    });
  });

  test("issue #325: a codex usage wall stating a reset time carries resetsAt end to end", async () => {
    // Live capture (codex 0.158.0 exec --json on an exhausted quota):
    // thread.started / turn.started / error / turn.failed, both error
    // records carrying the same prose wall. The reset prints in the
    // child's local zone (+07:00 here) at minute precision, so resetsAt
    // is the end of that minute - the truncated minute's upper bound.
    const wall =
      "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 11:58 PM.";
    const proc = new FakeProcess();
    const clock = new FakeClock();
    clock.utcOffsetMinutes = () => 420;
    const sig = fakeSignal();
    const spawner = fakeSpawner([proc]);
    const turn = streamTurn(
      codexCli,
      { prompt: "hi", questions: "none" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(JSON.stringify({ type: "turn.started" }));
    proc.emitLine(JSON.stringify({ type: "error", message: wall }));
    proc.emitLine(JSON.stringify({ type: "turn.failed", error: { message: wall } }));
    proc.exit(1);
    const events = await collect(turn);
    // The duplicate turn.failed wall dedupes into the one failure record.
    const failures = events.filter(
      (e): e is Extract<HarnessEvent, { kind: "failure" }> => e.kind === "failure",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.resetsAt).toBe(Date.parse("2026-10-03T16:59:00Z"));
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "limit",
      failure: { class: "usage-limit", resetsAt: Date.parse("2026-10-03T16:59:00Z") },
    });
  });

  test("muse run_terminal failed yields task failure", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(museCode, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ stream: { id: "s-1" } }));
    proc.emitLine(
      JSON.stringify({
        payload: { kind: "run_terminal", terminal: "failed", reason: "model error" },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("reduceFailures precedence unavailable beats task", async () => {
    const { reduceFailures, failureFromTask, failureFromTransport, failureFromUnavailable } =
      await import("../../src/execution/failure.js");
    const unavailable = failureFromUnavailable("model_not_found");
    const task = failureFromTask("some task error");
    const transport = failureFromTransport("connection reset");
    expect(reduceFailures([task, unavailable])?.class).toBe("unavailable");
    expect(reduceFailures([unavailable, task])?.class).toBe("unavailable");
    expect(reduceFailures([])).toBeUndefined();
    expect(reduceFailures([task])).toBe(task);
    expect(reduceFailures([task, transport])).toBe(task);
    expect(reduceFailures([task, failureFromTask("later")])).toBe(task);
  });
});
