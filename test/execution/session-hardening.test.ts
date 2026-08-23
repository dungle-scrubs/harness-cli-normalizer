import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  CLOSE_GRACE_MS,
  openSession,
  SessionSpawnError,
} from "../../src/execution/open-session.js";
import { KILL_GRACE_MS, PIPE_GRACE_MS } from "../../src/execution/stream-turn.js";
import { SessionInputRefusalError } from "../../src/interpretation/session-input.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const _result = JSON.stringify({ type: "result", subtype: "success" });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const makeDeps = (proc: FakeProcess, logged?: Record<string, unknown>[]) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return {
    spawn: spawner.spawn,
    clock,
    signal: sig.signal,
    ...(logged ? { log: (e: Record<string, unknown>) => logged.push(e) } : {}),
    spawner,
    sig,
  };
};

describe("M3.2 boundary-review regression pins", () => {
  test("the session requests a stdin PIPE regardless of the descriptor's one-shot policy", () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    openSession(claudeCode, { sessionId: sid }, d);
    expect(d.spawner.calls[0]?.opts.stdin).toBe("pipe");
  });

  test("limit walls on stderr classify the session - wall detection is not stdout-only", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitStderr("You've hit your weekly limit · resets 2am");
    await tick();
    proc.exit(1);
    const events = await drainTurn(turn1);
    expect(events.find((e) => e.kind === "limit")).toMatchObject({ code: "weekly-limit" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "limit" });
  });

  test("a crashed session's close log carries the stderr tail", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const d = makeDeps(proc, logged);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    proc.emitStderr("Segmentation fault (core dumped)");
    await tick();
    proc.exit(139);
    await new Promise<void>((resolve) => {
      const iter = session.turns[Symbol.asyncIterator]();
      void (async () => {
        while (!(await iter.next()).done) {
          /* drain turn handles */
        }
        resolve();
      })();
    });
    const close = logged.find((e) => e.event === "session_close");
    expect(close?.stderrTail).toEqual(["Segmentation fault (core dumped)"]);
  });

  test("close() escalates SIGTERM->SIGKILL when the child ignores stdin EOF - close is bounded", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal({ autoExit: false }); // wedged child: ignores SIGTERM
    const clock = new FakeClock();
    const d = { spawn: spawner.spawn, clock, signal: sig.signal, sig, clock2: clock };
    const session = openSession(claudeCode, { sessionId: sid }, d);
    const closing = session.close();
    await tick();
    clock.advance(CLOSE_GRACE_MS + 1); // child ignored EOF -> SIGTERM (ignored by fake)
    await tick();
    clock.advance(KILL_GRACE_MS + 1); // -> SIGKILL (fake dies)
    await tick();
    clock.advance(PIPE_GRACE_MS + 1); // pipes never closed -> grace closes out
    await closing;
    expect(sig.sent.map((s) => s.sig)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("session pipe grace disposes descendant-held output and joins both pumps", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([proc]);
    const clock = new FakeClock();
    const signals: string[] = [];
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      {
        spawn: spawner.spawn,
        clock,
        signal: (_proc, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") proc.exitWithoutClosing(null);
        },
      },
    );

    const closing = session.close();
    await tick();
    clock.advance(CLOSE_GRACE_MS + 1);
    await tick();
    clock.advance(KILL_GRACE_MS + 1);
    await tick();
    clock.advance(PIPE_GRACE_MS + 1);
    await closing;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(proc.outputDisposed).toBe(true);
    expect(proc.stdout.activeReaderCount).toBe(0);
    expect(proc.stderr.activeReaderCount).toBe(0);
  });

  test("session pipe grace preserves a backpressured turn and close does not deadlock", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      {
        spawn: spawner.spawn,
        clock,
        signal: sig.signal,
      },
    );
    session.send({ id: "s", text: "hi" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    const content = Array.from({ length: 1_100 }, (_, index) => ({
      type: "tool_use",
      name: `tool-${index}`,
      input: {},
    }));
    proc.emitChunk(
      `${JSON.stringify({ type: "assistant", message: { content: content.slice(0, 1_026) } })}\n`,
    );
    proc.emitChunk(
      `${JSON.stringify({ type: "assistant", message: { content: content.slice(1_026) } })}\n`,
    );
    proc.exitWithoutClosing(0);
    await tick();
    expect(proc.stdout.pullCount).toBe(1);
    clock.advance(PIPE_GRACE_MS + 1);

    await session.close();
    const events = await drainTurn(turn);
    expect(events.filter((event) => event.kind === "tool")).toHaveLength(1_100);
    expect(events.filter((event) => event.kind === "done")).toEqual([
      { kind: "done", exitCode: 0, cause: "clean", escalation: { mode: "ask", detection: "none" } },
    ]);
    expect(proc.stdout.activeReaderCount).toBe(0);
    expect(proc.stderr.activeReaderCount).toBe(0);
  });

  test("session pump failure still joins a descendant-held sibling pipe", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([proc]);
    const clock = new FakeClock();
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      {
        spawn: spawner.spawn,
        clock,
        signal: () => {},
      },
    );
    session.send({ id: "s", text: "hi" });
    const turns = session.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    proc.failStdout(new Error("synthetic session read failure"));
    proc.exitWithoutClosing(1);
    await tick();
    clock.advance(PIPE_GRACE_MS + 1);

    await session.close();
    const events = await drainTurn(turn);
    expect(events.find((event) => event.kind === "error")).toMatchObject({
      message: expect.stringContaining("synthetic session read failure"),
    });
    expect(proc.outputDisposed).toBe(true);
    expect(proc.stderr.activeReaderCount).toBe(0);
  });

  test("queued sends that die with the session are surfaced, never silently dropped", async () => {
    const logged: Record<string, unknown>[] = [];
    const proc = new FakeProcess();
    const d = makeDeps(proc, logged);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "first" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    expect(session.send({ id: "s", text: "second - accepted as queued" }).disposition).toBe(
      "queued",
    );
    proc.emitLine(init);
    proc.exit(7); // dies before the boundary ever flushes the queue
    const events = await drainTurn(turn1);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      message: expect.stringContaining("queued send"),
    });
    expect(logged.find((e) => e.event === "sends_dropped")).toMatchObject({ count: 1 });
  });

  test("a result carrying is_error ends the turn as crash, not clean", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "doomed" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
    );
    const events = await drainTurn(turn1);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      message: expect.stringContaining("error_during_execution"),
    });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "crash" });
    await session.close();
  });

  test("a trailing partial line at process death is not lost", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(init);
    proc.emitChunk(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "last words" }] },
      }),
    ); // no trailing newline
    proc.exit(0);
    const events = await drainTurn(turn1);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "last words" });
  });

  test("a spawn failure throws typed and logs a boundary event - never an orphaned child", () => {
    const logged: Record<string, unknown>[] = [];
    const clock = new FakeClock();
    const sig = fakeSignal();
    expect(() =>
      openSession(
        claudeCode,
        { sessionId: sid },
        {
          spawn: () => {
            throw new Error("ENOENT");
          },
          clock,
          signal: sig.signal,
          log: (e) => logged.push(e),
        },
      ),
    ).toThrow(SessionSpawnError);
    expect(logged.find((e) => e.event === "session_spawn_failed")).toBeDefined();
  });

  test("a malformed session input contract is refused and logged before spawn", () => {
    const logged: Record<string, unknown>[] = [];
    const malformed = {
      ...claudeCode,
      sessionMode: {
        flags: claudeCode.sessionMode?.flags ?? [],
        idFlag: claudeCode.sessionMode?.idFlag ?? "--session-id",
      },
    } as unknown as HarnessDescriptor;
    let spawnCalls = 0;

    expect(() =>
      openSession(
        malformed,
        { sessionId: sid },
        {
          clock: new FakeClock(),
          log: (event) => logged.push(event),
          signal: fakeSignal().signal,
          spawn: () => {
            spawnCalls++;
            throw new Error("spawn must not be reached");
          },
        },
      ),
    ).toThrowError(SessionInputRefusalError);
    expect(spawnCalls).toBe(0);
    expect(logged).toEqual([
      {
        event: "session_input_refused",
        harness: "claude",
        issue: "missing-session-input-contract",
        sessionId: sid,
      },
    ]);
  });

  test("abandoning the turns iterable closes the session - no leaked child", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(claudeCode, { sessionId: sid }, d);
    session.send({ id: "s", text: "hi" });
    for await (const _turn of session.turns) {
      break; // consumer walks away from the whole session
    }
    await tick();
    expect(proc.stdinEnded).toBe(true); // close() ran
  });
});
