/**
 * RFC-01 Design section 2 - escalation record on done.
 * Every turn end carries mode+ detection, including failed turns,
 * distinguish block/malformed/none, from BOTH runners.
 * Covers every row of the State Machine table.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

/** The turn's `done` event, or a clear failure. A missing `done` is a real
 * test failure and should read as one rather than as a null dereference. */
const doneOf = (events: readonly HarnessEvent[]): Extract<HarnessEvent, { kind: "done" }> => {
  const d = events.find((e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done");
  if (d === undefined) throw new Error("no done event in stream");
  return d;
};

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const result = JSON.stringify({ type: "result", subtype: "success" });
const assistantWith = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const ASK_TEXT = `ask\n\n\`\`\`hcn-question\n{"question": "Q?", "options": ["a", "b"]}\n\`\`\``;
const MALFORMED_TEXT = `\`\`\`hcn-question\n{"question": "Q", "options": []}\n\`\`\``;

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const deps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal };
};

describe("streamTurn escalation record - State Machine", () => {
  test("ask + block => question event, awaiting-input, escalation {ask, block}", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "ask" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "block" });
    expect(done.cause).toBe("awaiting-input");
    expect(events.some((e) => e.kind === "question")).toBe(true);
  });

  test("ask + malformed => no question, failed, escalation {ask, malformed}", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "ask" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith(MALFORMED_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "malformed" });
    expect(done.cause).toBe("failed");
    expect(done.failure?.class).toBe("task");
    expect(events.some((e) => e.kind === "question")).toBe(false);
  });

  test("ask + none => clean, escalation {ask, none} (instructed-and-silent)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "ask" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("plain answer"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "none" });
    expect(done.cause).toBe("clean");
    expect(events.some((e) => e.kind === "question")).toBe(false);
  });

  test("ask + none with failed exit still carries escalation", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "ask" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("answer"));
    proc.emitLine(result);
    proc.exit(1);
    proc.emitStderr("some native error");
    // Need to ensure failure is recorded; but even if crash, escalation present
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "none" });
  });

  test("assume + none => clean, escalation {assume, none}", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "assume" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("plain"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "assume", detection: "none" });
  });

  test("assume + block is ignored (detection stays none) - mode assume", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "assume" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "assume", detection: "none" });
    expect(events.some((e) => e.kind === "question")).toBe(false);
  });

  test("none + none => clean, escalation {none, none}", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "none" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("plain"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "none", detection: "none" });
  });

  test("none + block is ignored (detection stays none)", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task", questions: "none" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith(ASK_TEXT));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "none", detection: "none" });
    expect(events.some((e) => e.kind === "question")).toBe(false);
  });

  test("default mode is ask when omitted", async () => {
    const proc = new FakeProcess();
    const d = deps(proc);
    const turn = streamTurn(claudeCode, { prompt: "task" }, d);
    proc.emitLine(init);
    proc.emitLine(assistantWith("plain"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const done = doneOf(events);
    expect(done.escalation.mode).toBe("ask");
  });
});

describe("openSession escalation record - same State Machine, second runner", () => {
  const makeDeps = (proc: FakeProcess) => {
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    return { spawn: spawner.spawn, clock, signal: sig.signal };
  };
  const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
    const out: HarnessEvent[] = [];
    for await (const e of turn) out.push(e);
    return out;
  };
  const claudeInit = init;
  const claudeAssistant = assistantWith;
  const claudeResult = result;

  test("ask + block => awaiting-input, escalation {ask, block}", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "ask" }, d);
    session.send({ id: "s1", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant(ASK_TEXT));
    proc.emitLine(claudeResult);
    const events = await drainTurn(turn1);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "block" });
    expect(done.cause).toBe("awaiting-input");
    await session.close();
  });

  test("ask + malformed => failed, escalation {ask, malformed}", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "ask" }, d);
    session.send({ id: "s1", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant(MALFORMED_TEXT));
    proc.emitLine(claudeResult);
    const events = await drainTurn(turn1);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "malformed" });
    expect(done.cause).toBe("failed");
    await session.close();
  });

  test("ask + none => clean, escalation {ask, none}", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "ask" }, d);
    session.send({ id: "s1", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant("plain"));
    proc.emitLine(claudeResult);
    const events = await drainTurn(turn1);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "ask", detection: "none" });
    expect(done.cause).toBe("clean");
    await session.close();
  });

  test("assume => escalation {assume, none} even with block", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "assume" }, d);
    session.send({ id: "s1", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant(ASK_TEXT));
    proc.emitLine(claudeResult);
    const events = await drainTurn(turn1);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "assume", detection: "none" });
    await session.close();
  });

  test("none => escalation {none, none}", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "none" }, d);
    session.send({ id: "s1", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant("plain"));
    proc.emitLine(claudeResult);
    const events = await drainTurn(turn1);
    const done = doneOf(events);
    expect(done.escalation).toEqual({ mode: "none", detection: "none" });
    await session.close();
  });
});
