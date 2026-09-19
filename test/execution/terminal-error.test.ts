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
    const { reduceFailures, failureFromTask, failureFromUnavailable } = await import(
      "../../src/execution/failure.js"
    );
    const unavailable = failureFromUnavailable("model_not_found");
    const task = failureFromTask("some task error");
    expect(reduceFailures([task, unavailable])?.class).toBe("unavailable");
    expect(reduceFailures([unavailable, task])?.class).toBe("unavailable");
  });
});
