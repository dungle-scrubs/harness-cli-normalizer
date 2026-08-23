/**
 * Issue #44 unit tests: session-mode live question channel on openSession.
 * Covers both transports - claude (result delimiter, stream-json user
 * records) and pi rpc (agent_settled delimiter, prompt commands,
 * get_state identity probe) - plus the question event, the
 * awaiting-input turn cause, off-mode disarm, and the malformed-block
 * error path.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession } from "../../src/execution/open-session.js";
import {
  composeEscalatedPrompt,
  SESSION_ESCALATION_PREAMBLE,
} from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const makeDeps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const ASK_TEXT = `Need a decision.

\`\`\`hcn-question
{"question": "Which environment?", "options": ["staging", "production"], "recommended": "staging"}
\`\`\``;

// ---- claude session-mode shapes ----
const claudeInit = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const claudeAssistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const claudeResult = JSON.stringify({ type: "result", subtype: "success" });

// ---- pi rpc session-mode shapes ----
const piStateResp = (id: string) =>
  JSON.stringify({
    id,
    type: "response",
    command: "get_state",
    success: true,
    data: { sessionId: sid, sessionFile: "/tmp/does-not-matter.jsonl", messageCount: 0 },
  });
const piUserEcho = JSON.stringify({
  type: "message_end",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});
const piAssistant = (text: string) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const piSettled = JSON.stringify({ type: "agent_settled" });

describe("openSession question escalation - claude transport", () => {
  test("final-message block becomes a question event; turn done is awaiting-input, session stays live", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant(ASK_TEXT));
    proc.emitLine(claudeResult);
    const events1 = await drainTurn(turn1);

    const question = events1.find(
      (e): e is Extract<HarnessEvent, { kind: "question" }> => e.kind === "question",
    );
    expect(question).toEqual({
      kind: "question",
      question: "Which environment?",
      options: ["staging", "production"],
      recommended: "staging",
    });
    expect(events1.at(-1)).toMatchObject({ kind: "done", exitCode: null, cause: "awaiting-input" });

    // The answer is the next send on the SAME process - no respawn.
    session.send({ id: "s", text: "The user answered: production." });
    expect(d.spawner.calls).toHaveLength(1);
    const turn2 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant("done: deploy-target names production"));
    proc.emitLine(claudeResult);
    const events2 = await drainTurn(turn2);
    expect(events2.find((e) => e.kind === "question")).toBeUndefined();
    expect(events2.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await session.close();
  });

  test("questions assume: no-ask preamble, detection disarmed", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid, questions: "assume" }, d);
    session.send({ id: "s", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;

    // The send carried the no-ask preamble, not the session ask contract.
    const write = proc.stdinWrites[0] ?? "";
    expect(write).toContain("state the assumption");
    expect(write).not.toContain(SESSION_ESCALATION_PREAMBLE.slice(0, 60));

    proc.emitLine(claudeInit);
    // A worker that asks anyway produces NO question event.
    proc.emitLine(claudeAssistant(ASK_TEXT));
    proc.emitLine(claudeResult);
    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "question")).toBeUndefined();
    expect(events1.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await session.close();
  });

  test("malformed block surfaces an error event and task failure with failed cause (F-32)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "task" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(claudeInit);
    proc.emitLine(claudeAssistant('```hcn-question\n{"question":"q"}\n```'));
    proc.emitLine(claudeResult);
    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "question")).toBeUndefined();
    expect(events1.find((e) => e.kind === "error")?.message).toMatch(/"options"/);
    const failure = events1.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "task", retryable: false });
    expect((failure as unknown as { message: string }).message).toMatch(
      /malformed hcn-question block/,
    );
    const done = events1.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done).toMatchObject({ kind: "done", cause: "failed" });
    expect(done.failure).toMatchObject({ class: "task" });
    await session.close();
  });

  test("sends compose the session preamble exactly once (idempotent)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: composeEscalatedPrompt("task", "ask", "session") });
    const write = proc.stdinWrites[0] ?? "";
    expect(write.match(/\[hcn question protocol\]/g)).toHaveLength(1);
    // The fake never ends the turn on its own; a real harness does. close()
    // now waits for an open turn to finish (issue #99), so finish it.
    proc.exit(0);
    await session.close();
  });
});

describe("openSession question escalation - pi rpc transport", () => {
  test("spawns --mode rpc with --session <id>, probes identity, decodes turns, detects asks", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(piCli, { sessionId: sid }, d);

    // argv: rpc mode, NO id flag (pi refuses unknown ids and mints its own)
    const argv = d.spawner.calls[0]?.argv ?? [];
    expect(argv).toContain("--mode");
    expect(argv).toContain("rpc");
    expect(argv).not.toContain("--session");
    // stdin got the get_state identity probe before anything else
    expect(proc.stdinWrites[0]).toContain('"hcn-identity"');

    // probe response announces the requested id -> identity event
    const turns = session.turns[Symbol.asyncIterator]();
    session.send({ id: "s", text: "task" });
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(piStateResp("hcn-identity"));
    proc.emitLine(piUserEcho);
    proc.emitLine(piAssistant(ASK_TEXT));
    proc.emitLine(piSettled);
    const events1 = await drainTurn(turn1);

    expect(events1.find((e) => e.kind === "identity")?.sessionId).toBe(sid);
    expect(events1.find((e) => e.kind === "question")).toMatchObject({
      question: "Which environment?",
      options: ["staging", "production"],
      recommended: "staging",
    });
    expect(events1.at(-1)).toMatchObject({ kind: "done", exitCode: null, cause: "awaiting-input" });

    // answer: next send is a prompt command on the same process
    session.send({ id: "s", text: "The user answered: production." });
    const lastWrite = proc.stdinWrites.at(-1) ?? "";
    expect(JSON.parse(lastWrite)).toMatchObject({
      type: "prompt",
      message: expect.stringContaining("production"),
    });
    const turn2 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(piAssistant("done: names production"));
    proc.emitLine(piSettled);
    const events2 = await drainTurn(turn2);
    expect(events2.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    expect(d.spawner.calls).toHaveLength(1);
    await session.close();
  });

  test("harness-minted identity: probe announces the real id, caller handle stays internal", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(piCli, { sessionId: sid }, d);
    const turns = session.turns[Symbol.asyncIterator]();
    session.send({ id: "s", text: "task" });
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    // pi session mode now carries --session-id (caller-assigned, verified
    // phase10 test/fixtures/phase10-pi-rpc-resume); the probe returning the
    // same id the caller assigned announces that id, not a minted one. A
    // different id would be an identity-rotation error.
    proc.emitLine(
      JSON.stringify({
        id: "hcn-identity",
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: sid },
      }),
    );
    proc.emitLine(piSettled);
    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "identity")?.sessionId).toBe(sid);
    expect(events1.filter((e) => e.kind === "identity")).toHaveLength(1);
    expect(events1.find((e) => e.kind === "error")).toBeUndefined();
    await session.close();
  });

  test("a failed rpc command response surfaces as an error event", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(piCli, { sessionId: sid }, d);
    const turns = session.turns[Symbol.asyncIterator]();
    session.send({ id: "s", text: "task" });
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(piStateResp("hcn-identity"));
    proc.emitLine(
      JSON.stringify({
        id: "other",
        type: "response",
        command: "prompt",
        success: false,
        error: "agent is streaming; specify streamingBehavior",
      }),
    );
    proc.emitLine(piSettled);
    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "error")?.message).toMatch(/rpc command failed/);
    await session.close();
  });

  test("questions assume: no-ask preamble rides the prompt command", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(piCli, { sessionId: sid, questions: "assume" }, d);
    session.send({ id: "s", text: "task" });
    const write = proc.stdinWrites.at(-1) ?? "";
    expect(JSON.parse(write).message).toContain("state the assumption");
    // The fake never ends the turn on its own; a real harness does. close()
    // now waits for an open turn to finish (issue #99), so finish it.
    proc.exit(0);
    await session.close();
  });
});
