import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, SessionClosedError } from "../../src/execution/open-session.js";
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

describe("openSession (claude, fake process)", () => {
  test("execution owns no Claude-specific session input fields", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/execution/open-session.ts"),
      "utf8",
    );

    expect(source).not.toContain('type: "user"');
    expect(source).not.toContain('role: "user"');
  });

  test("one process serves many turns; send during idle starts a turn; result delimits it (A-001)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    // The session opens ONE process with the stream-json session argv.
    expect(d.spawner.calls).toHaveLength(1);
    expect(d.spawner.calls[0]?.argv).toContain("--input-format");
    expect(d.spawner.calls[0]?.argv).toContain(sid);

    const first = session.send("turn one prompt");
    expect(first.disposition).toBe("started");
    const expectedInput = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "turn one prompt" }],
      },
    };
    expect(proc.stdinWrites).toEqual([`${JSON.stringify(expectedInput)}\n`]);
    expect(JSON.parse(proc.stdinLines[0] ?? "null")).toEqual(expectedInput);

    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(init);
    proc.emitLine(assistant("first answer"));
    proc.emitLine(result);

    const events1 = await drainTurn(turn1);
    expect(events1.find((e) => e.kind === "message")).toMatchObject({ text: "first answer" });
    expect(events1.at(-1)).toMatchObject({ kind: "done", cause: "clean" });

    // Second turn on the SAME process.
    const second = session.send("turn two prompt");
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

  test("send during a live turn is QUEUED to the next boundary, not delivered mid-turn (A-001)", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send("first");
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;

    proc.emitLine(init);
    const queued = session.send("second while busy");
    expect(queued.disposition).toBe("queued");
    // Nothing new on stdin yet - mid-turn writes would interleave.
    expect(proc.stdinLines).toHaveLength(1);

    proc.emitLine(result);
    await drainTurn(turn1);
    // The boundary flushed the queue: the second prompt is on stdin now.
    expect(proc.stdinLines).toHaveLength(2);
    expect(proc.stdinWrites[1]).toBe(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "second while busy" }],
        },
      })}\n`,
    );
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

    expect(() => session.send("too late")).toThrowError(SessionClosedError);
  });

  test("send after process death keeps the typed SessionClosedError contract", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);

    proc.exit(0);
    await proc.exited;

    expect(() => session.send("too late")).toThrowError(SessionClosedError);
  });

  test("an idle stdin write failure keeps the typed SessionClosedError contract", () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    proc.stdin?.end();

    expect(() => session.send("unwritable")).toThrowError(SessionClosedError);
  });

  test("a process that dies mid-turn ends the live turn with a crash done and completes the session", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send("doomed turn");
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
    session.send("burst turn");
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
    session.send("hello");
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

describe("result is_error is not double-emitted", () => {
  test("a claude result is_error yields exactly one error event through openSession", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send("doomed");
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
