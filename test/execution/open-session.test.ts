import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, SessionClosedError } from "../../src/execution/open-session.js";
import { composeEscalatedPrompt } from "../../src/interpretation/question.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const result = JSON.stringify({ type: "result", subtype: "success" });

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const makeDeps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

const expectClaudeUserWrite = (proc: FakeProcess, index: number, text: string): void => {
  const expectedInput = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          // issue #44: escalation composes the SESSION preamble onto every
          // send by default; the raw text rides as the prompt's tail.
          text: composeEscalatedPrompt(text, "ask", "session"),
        },
      ],
    },
  };
  expect(proc.stdinWrites[index]).toBe(`${JSON.stringify(expectedInput)}\n`);
  expect(JSON.parse(proc.stdinLines[index] ?? "null")).toEqual(expectedInput);
};

describe("openSession (claude, fake process)", () => {
  test("one process serves many turns; send during idle starts a turn; result delimits it (A-001)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    // The session opens ONE process with the stream-json session argv.
    expect(d.spawner.calls).toHaveLength(1);
    expect(d.spawner.calls[0]?.argv).toContain("--input-format");
    expect(d.spawner.calls[0]?.argv).toContain(sid);

    const first = session.send({ id: "s", text: "turn one prompt" });
    expect(first.disposition).toBe("started");
    expectClaudeUserWrite(proc, 0, "turn one prompt");

    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(init);
    proc.emitLine(assistant("first answer"));
    proc.emitLine(result);

    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "message")).toMatchObject({ text: "first answer" });
    expect(events1.at(-1)).toMatchObject({ kind: "done", cause: "clean" });

    // Second turn on the SAME process.
    const second = session.send({ id: "s", text: "turn two prompt" });
    expect(second.disposition).toBe("started");
    const turn2 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init); // A-001: init re-emitted per turn, same id - no new identity event
    proc.emitLine(assistant("second answer"));
    proc.emitLine(result);
    const events2 = await drainTurn(turn2);
    expect(events2.some((e) => e.kind === "identity")).toBe(false);
    expect(events2.find((e) => e.kind === "message")).toMatchObject({ text: "second answer" });
    expect(d.spawner.calls).toHaveLength(1); // still one process

    await session.close();
  });

  test("send during a live turn is passed to the harness immediately; the harness queues it (ADR 0007)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "first" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(init);
    const second = session.send({ id: "s", text: "second while busy" });
    expect(second.disposition).toBe("started");
    // Passed through immediately - the harness decides what to do with it.
    expect(proc.stdinLines).toHaveLength(2);
    expectClaudeUserWrite(proc, 1, "second while busy");

    proc.emitLine(result);
    await drainTurn(turn1);
    const turn2 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(result);
    await drainTurn(turn2);
    await session.close();
  });

  test("close drains cleanly: stdin ends, process exits, turns iterable completes", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    const closed = session.close();
    proc.exit(0);
    await closed;
    expect(proc.stdinEnded).toBe(true);
    const turns: unknown[] = [];
    for await (const t of session.turns) turns.push(t);
    expect(turns).toEqual([]);
  });

  test("send after close keeps the typed SessionClosedError contract", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    await session.close();

    expect(() => session.send({ id: "s", text: "too late" })).toThrowError(SessionClosedError);
  });

  test("send after process death keeps the typed SessionClosedError contract", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    proc.exit(0);
    await proc.exited;

    expect(() => session.send({ id: "s", text: "too late" })).toThrowError(SessionClosedError);
  });

  // Contract change (RFC-01 execution-layer item 4): a broken stdin pipe is
  // no longer folded into SessionClosedError. A caller must tell "the pipe
  // broke" apart from "you closed this session"; the remedies differ.
  test("an idle stdin write failure rejects write-failed, not SessionClosedError", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    proc.stdin?.end();

    const sent = session.send({ id: "s", text: "unwritable" });
    expect(sent).toEqual({ disposition: "rejected", reason: "write-failed" });
    proc.exit(0);
    await session.close();
  });

  test("a process that dies mid-turn ends the live turn with a crash done and completes the session", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "doomed turn" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.exit(3); // dies mid-turn
    const events = await drainTurn(turn1);
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 3, cause: "crash" });
    expect((await turnsIter.next()).done).toBe(true);
  });
});

describe("slow consumer", () => {
  test("a consumer that stops pulling loses nothing - events buffer until drained", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "burst turn" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(init);
    for (let i = 0; i < 500; i++) proc.emitLine(assistant(`chunk ${i}`));
    proc.emitLine(result);
    await new Promise((r) => setTimeout(r, 10)); // consumer not pulling the whole time

    const events = await drainTurn(turn1);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(500);
    expect(messages[0]).toMatchObject({ text: "chunk 0" });
    expect(messages[499]).toMatchObject({ text: "chunk 499" });
    await session.close();
  });
});

describe("session lifecycle events (observability)", () => {
  test("open/turn/send/close events carry sessionId and turnId correlation", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      {
        spawn: d.spawn,
        clock: d.clock,
        signal: d.signal,
        log: (e) => logged.push(e),
      },
    );
    session.send({ id: "s", text: "hello" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitLine(result);
    await drainTurn(turn1);
    await session.close();
    const kinds = logged.map((e) => e.event);
    for (const expected of ["session_open", "send", "turn_start", "turn_end", "session_close"]) {
      expect(kinds).toContain(expected);
    }
    const turnStart = logged.find((e) => e.event === "turn_start");
    const turnEnd = logged.find((e) => e.event === "turn_end");
    expect(turnStart?.turnId).toBe(turnEnd?.turnId);
    expect(turnStart?.sessionId).toBe(sid);
  });
});

describe("F-24 session turn failures", () => {
  test("a turn whose stderr carries a usage-limit line ends with failure then done with failure", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitStderr("You've hit your weekly limit · resets 2am");
    await new Promise<void>((r) => setTimeout(r, 0));
    proc.emitLine(result);
    const events = await drainTurn(turn1);
    const failure = events.find((e) => e.kind === "failure");
    expect(failure).toMatchObject({ class: "usage-limit" });
    // failure must appear before done
    const failureIdx = events.findIndex((e) => e.kind === "failure");
    const doneIdx = events.findIndex((e) => e.kind === "done");
    expect(failureIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(failureIdx);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "limit",
      failure: expect.objectContaining({ class: "usage-limit" }),
    });
    await session.close();
  });

  test("a clean turn has no failure event and done.failure undefined", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitLine(result);
    const events = await drainTurn(turn1);
    expect(events.find((e) => e.kind === "failure")).toBeUndefined();
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.kind).toBe("done");
    expect(done.cause).toBe("clean");
    expect(done.failure).toBeUndefined();
    await session.close();
  });
});

describe("result is_error is not double-emitted", () => {
  test("a claude result is_error yields exactly one error event through openSession", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "doomed" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
    const events = await drainTurn(turn1);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      message: expect.stringContaining("error_max_turns"),
    });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "crash" });
    await session.close();
  });
});

describe("pi session unreachable", () => {
  test("a pi session turn whose stdout carries the unreachable message_end ends with transport failure", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { piCli } = await import("../../src/knowledge/pi.js");
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-unreachable.ndjson"),
      "utf8",
    );
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // pick one message_end with stopReason error
    const found = lines.find(
      (l) => l.includes('"type":"message_end"') && l.includes('"stopReason":"error"'),
    );
    if (found === undefined) throw new Error("no unreachable line");
    const unreachableLine = found;
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    // pi session uses rpc; need to handle identity probe - just emit unreachable line as turn content
    const session = openSession(piCli, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    // feed session + agent start already handled by openSession's pump, but we emit the unreachable record
    proc.emitLine(unreachableLine);
    // end turn via agent_settled
    proc.emitLine(JSON.stringify({ type: "agent_settled" }));
    const events = await drainTurn(turn1);
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.failure).toMatchObject({ class: "transport" });
    await session.close();
  });
});

describe("T01: a send's id travels to the turn it opens and to the loss report", () => {
  test("the turn a started send opens reports that send's id", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    session.send({ id: "in-1", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as { inputId?: string };
    expect(turn1.inputId).toBe("in-1");

    proc.emitLine(init);
    proc.emitLine(result);
    await drainTurn(turn1 as AsyncIterable<HarnessEvent>);
    await session.close();
  });

  test("a send while busy hands the text to the harness; its id rides to the turn that consumes it at the boundary", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    session.send({ id: "in-1", text: "first" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as { inputId?: string };
    expect(turn1.inputId).toBe("in-1");

    proc.emitLine(init);
    const second = session.send({ id: "in-2", text: "second while busy" });
    expect(second.disposition).toBe("started");
    // handed to harness immediately
    expect(proc.stdinLines).toHaveLength(2);
    proc.emitLine(result);
    await drainTurn(turn1 as AsyncIterable<HarnessEvent>);

    const turn2 = (await turnsIter.next()).value as { inputId?: string };
    expect(turn2.inputId).toBe("in-2");
    proc.emitLine(result);
    await drainTurn(turn2 as AsyncIterable<HarnessEvent>);
    await session.close();
  });

  test("a session that dies with pending sends names the lost ids in the log", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const logged: Record<string, unknown>[] = [];
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      { spawn: spawner.spawn, clock, signal: sig.signal, log: (e) => logged.push(e) },
    );

    session.send({ id: "in-1", text: "first" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    session.send({ id: "in-2", text: "pending and doomed" });
    proc.exit(1);
    await drainTurn(turn1);

    const dropped = logged.find((e) => e.event === "sends_dropped");
    expect(dropped).toMatchObject({ count: 1, ids: ["in-2"] });
  });
});

describe("openSession memory dimension (ratified 2026-08-26)", () => {
  test("memory:false spawns the claude session with the disable env var", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    openSession(claudeCode, { sessionId: sid, memory: false }, d);
    expect(d.spawner.calls[0]?.opts.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    await new Promise((r) => setTimeout(r, 0));
  });

  test("memory:true (opt back in) and undefined spawn with no env overlay", async () => {
    for (const memory of [true, undefined] as const) {
      const proc = new FakeProcess();
      const d = makeDeps(proc);
      openSession(claudeCode, { sessionId: sid, ...(memory !== undefined ? { memory } : {}) }, d);
      expect(d.spawner.calls[0]?.opts.env).toBeUndefined();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
});
