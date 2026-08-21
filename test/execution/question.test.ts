/**
 * Issue #41 question escalation - execution unit tests on fakes: the
 * question event fires from the final message's hcn-question block, done
 * flips to awaiting-input with exit 0, false mode never detects, malformed
 * blocks surface as errors, and the preamble rides the spawned prompt.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import {
  composeEscalatedPrompt,
  ESCALATION_PREAMBLE,
  NO_ESCALATION_PREAMBLE,
} from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const result = JSON.stringify({ type: "result", subtype: "success" });

const assistantWith = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const deps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

const ASK_TEXT = `I need a decision.

\`\`\`hcn-question
{"question": "Which environment?", "options": ["staging", "production"], "recommended": "staging"}
\`\`\``;

describe("streamTurn question escalation (true mode, default)", () => {
  test("final-message block becomes a question event; done is awaiting-input, exit 0", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task" }, d);

    proc.emitLine(init);
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);

    const events = await collect(turn);
    const question = events.find(
      (e): e is Extract<HarnessEvent, { kind: "question" }> => e.kind === "question",
    );
    expect(question).toEqual({
      kind: "question",
      question: "Which environment?",
      options: ["staging", "production"],
      recommended: "staging",
    });
    // the question event precedes done
    expect(events.map((e) => e.kind).indexOf("question")).toBeLessThan(
      events.map((e) => e.kind).lastIndexOf("done"),
    );
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: 0, cause: "awaiting-input" });
  });

  test("question event fires even when a later non-assistant message exists", async () => {
    // the protocol says the block is the LAST assistant message content;
    // harness bookkeeping lines (result) after it must not hide it.
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("first answer without block"));
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.filter((e) => e.kind === "question")).toHaveLength(1);
    const done = events.find(
      (e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done",
    );
    expect(done?.cause).toBe("awaiting-input");
  });

  test("the escalation preamble is prepended to the spawned prompt", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("ok"));
    proc.emitLine(result);
    proc.exit(0);
    await collect(turn);
    const argv = d.spawner.calls[0]?.argv ?? [];
    const spawnedPrompt = argv.find((a) => a.startsWith("[hcn question protocol]"));
    expect(spawnedPrompt).toBeDefined();
    expect(spawnedPrompt).toContain(ESCALATION_PREAMBLE.slice(0, 40));
    expect(spawnedPrompt?.endsWith("task")).toBe(true);
  });

  test("a malformed block surfaces an error event and a task failure with failed cause (F-32)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith('```hcn-question\n{"question": "q", "options": []}\n```'));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "question")).toBeUndefined();
    expect(events.find((e) => e.kind === "error")?.message).toMatch(/"options" must be an array/);
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "task", retryable: false });
    expect((failure as unknown as { message: string }).message).toMatch(
      /malformed hcn-question block/,
    );
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done).toMatchObject({ kind: "done", cause: "failed" });
    expect(done.failure).toMatchObject({ class: "task" });
  });
});

describe("streamTurn question escalation (false mode)", () => {
  test("no preamble block instruction, no detection, no question event", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", escalateQuestions: false }, d);
    proc.emitLine(init);
    // A worker that asks anyway (mode was false) must NOT produce a
    // question event - detection is disarmed; the turn is judged on its
    // own content.
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "question")).toBeUndefined();
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: 0, cause: "clean" });
    const argv = d.spawner.calls[0]?.argv ?? [];
    const spawnedPrompt = argv.find((a) => a.startsWith("[hcn question protocol]"));
    expect(spawnedPrompt).toBeDefined();
    expect(spawnedPrompt).toContain("state the assumption");
    expect(spawnedPrompt).toContain(NO_ESCALATION_PREAMBLE.slice(0, 40));
  });
});

describe("streamTurn question escalation on resume", () => {
  test("resume turns compose the preamble too - answers ride the same protocol", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "production", resume: sid }, d);
    proc.emitLine(init); // claude re-announces the same id (duplicate, not news)
    proc.emitLine(assistantWith("done: deploy-target.txt names production"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.find((e) => e.kind === "question")).toBeUndefined();
    expect(events.at(-1)).toEqual({ kind: "done", exitCode: 0, cause: "clean" });
    const argv = d.spawner.calls[0]?.argv ?? [];
    expect(argv).toContain("--resume");
    const spawnedPrompt = argv.find((a) => a.startsWith("[hcn question protocol]"));
    expect(spawnedPrompt).toBeDefined();
    expect(spawnedPrompt?.endsWith("production")).toBe(true);
  });

  test("double composition never happens (CLI composes, streamTurn sees composed)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: composeEscalatedPrompt("task", true) }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("ok"));
    proc.emitLine(result);
    proc.exit(0);
    await collect(turn);
    const argv = d.spawner.calls[0]?.argv ?? [];
    const spawnedPrompt = argv.find((a) => a.startsWith("[hcn question protocol]")) ?? "";
    expect(spawnedPrompt.match(/\[hcn question protocol\]/g)).toHaveLength(1);
  });
});
