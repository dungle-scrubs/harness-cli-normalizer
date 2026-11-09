/**
 * Background jobs on a live claude session and the `stop-background`
 * session op (spec 2026-11-09). Receipt shapes follow the interrupt
 * precedent (issue #426/#429): a requested phase on the wire, then
 * exactly one terminal receipt; the receipt never claims the job ended -
 * the job's own end arrives on the stream as a `background` event. Wire
 * records are the claude 2.1.319 shapes from the 2026-11-09 capture.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { isSessionTurn, openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { PIPE_GRACE_MS } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const rig = (descriptor = claudeCode) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  const log: Record<string, unknown>[] = [];
  const session = openSession(
    descriptor,
    { sessionId: sid, questions: "none" },
    {
      spawn: spawner.spawn,
      clock,
      signal: sig.signal,
      log: (entry) => log.push(entry),
    },
  );
  const turns = session.turns[Symbol.asyncIterator]();
  return { proc, spawner, sig, clock, log, session, turns };
};

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
};

const lastStdin = (proc: FakeProcess): Record<string, unknown> =>
  JSON.parse(proc.stdinLines.at(-1) ?? "null") as Record<string, unknown>;

const claudeInitWith = (uuids: string[]) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sid, user_message_uuids: uuids });
const claudeCompleted = (uuid: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    session_id: sid,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
  });
const stopTaskResponse = (requestId: unknown, ok: boolean) =>
  JSON.stringify({
    type: "control_response",
    response: {
      subtype: ok ? "success" : "error",
      request_id: requestId,
      ...(ok ? {} : { error: "no such task" }),
    },
  });

// The task records of the 2026-11-09 capture (claude 2.1.319), trimmed to
// the fields the decoder reads.
const shellStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  description: "Run background tick loop",
  is_backgrounded: true,
  task_type: "local_bash",
  session_id: sid,
};
const shellStopped = {
  type: "system",
  subtype: "task_updated",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  patch: { status: "killed", end_time: 1794203909753 },
  session_id: sid,
};
const shellNotificationKilled = {
  type: "system",
  subtype: "task_notification",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  status: "killed",
  output_file: "/tmp/tasks/bcrfa3pxt.output",
  summary: 'Background command "Run background tick loop" was stopped',
  session_id: sid,
};

/** A claude send whose turn the harness opened with an init record. */
const startClaudeTurn = async (r: ReturnType<typeof rig>, id: string) => {
  r.session.send({ id, text: "work" });
  const uuid = String(lastStdin(r.proc).uuid);
  r.proc.emitLine(claudeInitWith([uuid]));
  const turn = (await r.turns.next()).value as SessionTurn;
  expect(turn.inputId).toBe(id);
  return { turn, uuid };
};

describe("stop-background receipts on claude", () => {
  test("a success response settles sent, without claiming the job ended", async () => {
    const r = rig();
    const requested = r.session.stopBackground({ id: "stop-1", job: "bcrfa3pxt" });
    if (requested.state !== "requested") throw new Error("expected requested");
    expect(lastStdin(r.proc)).toEqual({
      type: "control_request",
      request_id: expect.stringMatching(/^hcn-stop-background:/),
      request: { subtype: "stop_task", task_id: "bcrfa3pxt" },
    });
    // The caller id never reaches the wire.
    expect(JSON.stringify(lastStdin(r.proc))).not.toContain("stop-1");
    r.proc.emitLine(stopTaskResponse(lastStdin(r.proc).request_id, true));
    expect(await requested.settled).toEqual({ state: "sent" });
    await r.session.close();
    const requestedLog = r.log.filter(
      (e) => e.event === "stop_background" || e.event === "stop_background_settled",
    );
    expect(requestedLog.map((e) => [e.id, e.state])).toEqual([
      ["stop-1", "requested"],
      ["stop-1", "sent"],
    ]);
  });

  test("a native error response settles rejected native-rejected and the session stays usable", async () => {
    const r = rig();
    const { turn, uuid } = await startClaudeTurn(r, "a1");
    const requested = r.session.stopBackground({ id: "stop-1", job: "nope" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(stopTaskResponse(lastStdin(r.proc).request_id, false));
    expect(await requested.settled).toEqual({ state: "rejected", reason: "native-rejected" });
    expect(r.proc.hasExited).toBe(false);
    r.proc.emitLine(claudeCompleted(uuid));
    expect((await drainTurn(turn)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("a reused caller id gets its own wire request; each settles exactly once", async () => {
    const r = rig();
    const first = r.session.stopBackground({ id: "same", job: "bcrfa3pxt" });
    const firstWire = lastStdin(r.proc).request_id;
    const second = r.session.stopBackground({ id: "same", job: "bcrfa3pxt" });
    const secondWire = lastStdin(r.proc).request_id;
    if (first.state !== "requested" || second.state !== "requested") throw new Error("requested");
    expect(firstWire).not.toBe(secondWire);
    r.proc.emitLine(stopTaskResponse(firstWire, true));
    r.proc.emitLine(stopTaskResponse(secondWire, false));
    expect(await first.settled).toEqual({ state: "sent" });
    expect(await second.settled).toEqual({ state: "rejected", reason: "native-rejected" });
    // A repeated answer settles nothing twice.
    r.proc.emitLine(stopTaskResponse(firstWire, true));
    await r.session.close();
  });

  test("close while a request is pending resolves it closed; a later request rejects closed", async () => {
    const r = rig();
    const requested = r.session.stopBackground({ id: "pending", job: "bcrfa3pxt" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const closing = r.session.close();
    await closing;
    expect(await requested.settled).toEqual({ state: "rejected", reason: "closed" });
    expect(r.session.stopBackground({ id: "after", job: "bcrfa3pxt" })).toEqual({
      state: "rejected",
      reason: "closed",
    });
  });

  test("process death resolves a pending request explicitly", async () => {
    const r = rig();
    const requested = r.session.stopBackground({ id: "doomed", job: "bcrfa3pxt" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.exit(1);
    await r.session.close();
    expect(await requested.settled).toEqual({ state: "rejected", reason: "closed" });
  });
});

describe("stop-background on a harness without the native stop", () => {
  test("pi rejects unsupported, writes nothing, and the session stays usable", async () => {
    const r = rig(piCli);
    expect(r.session.controls.stopBackground).toEqual({ supported: false });
    const before = r.proc.stdinLines.length;
    expect(r.session.stopBackground({ id: "stop-1", job: "bcrfa3pxt" })).toEqual({
      state: "rejected",
      reason: "unsupported",
    });
    expect(r.proc.stdinLines).toHaveLength(before);
    // Usable: a send still opens its turn.
    r.session.send({ id: "s", text: "hi" });
    r.proc.emitLine(
      JSON.stringify({
        id: r.proc.lastSendRequestId(),
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      }),
    );
    const next = await r.turns.next();
    expect((next.value as SessionTurn).inputId).toBe("s");
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("background events on a live claude session", () => {
  test("a job's end between turns arrives as a bare sequence item, with no further send", async () => {
    const r = rig();
    const first = await startClaudeTurn(r, "a1");
    r.proc.emitLine(JSON.stringify(shellStarted));
    r.proc.emitLine(claudeCompleted(first.uuid));
    const firstEvents = await drainTurn(first.turn);
    // task_started landed inside the turn that was running.
    expect(firstEvents.filter((e) => e.kind === "background").map((e) => e.state)).toEqual([
      "running",
    ]);
    expect(firstEvents.at(-1)).toMatchObject({ kind: "done", cause: "clean" });

    // The job ends after the result, with no turn open. Like a between-turn
    // compaction it opens no turn - but unlike one it does not wait for the
    // next turn either: each end record reaches the session sequence as
    // it arrives, with no send, and the notification (which carries no
    // task_type) still finds its job through the registry entry the
    // preceding task_updated kept.
    r.proc.emitLine(JSON.stringify(shellStopped));
    const stopped = await r.turns.next();
    expect(stopped).toEqual({
      done: false,
      value: {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "stopped",
      },
    });
    r.proc.emitLine(JSON.stringify(shellNotificationKilled));
    const notified = await r.turns.next();
    expect(notified.value).toMatchObject({
      kind: "background",
      id: "bcrfa3pxt",
      state: "stopped",
      outputFile: "/tmp/tasks/bcrfa3pxt.output",
    });
    // No turn was opened for any of it.
    expect(r.log.filter((e) => e.event === "turn_start")).toHaveLength(1);
    await r.session.close();
  });

  test("a job's end between turns is not lost when the session closes idle", async () => {
    const r = rig();
    const first = await startClaudeTurn(r, "a1");
    r.proc.emitLine(JSON.stringify(shellStarted));
    r.proc.emitLine(claudeCompleted(first.uuid));
    await drainTurn(first.turn);
    // The job ends after the result and the session closes with no further
    // send: the end still reaches the sequence consumer before the
    // channel ends with the session.
    r.proc.emitLine(JSON.stringify(shellStopped));
    r.proc.emitLine(JSON.stringify(shellNotificationKilled));
    const closing = r.session.close();
    const seen: HarnessEvent[] = [];
    for (;;) {
      const item = await r.turns.next();
      if (item.done) break;
      if (isSessionTurn(item.value)) throw new Error("unexpected turn");
      seen.push(item.value);
    }
    await closing;
    expect(seen).toHaveLength(2);
    expect(
      seen.map((e) => (e.kind === "background" ? [e.state, e.outputFile ?? ""] : null)),
    ).toEqual([
      ["stopped", ""],
      ["stopped", "/tmp/tasks/bcrfa3pxt.output"],
    ]);
    expect(r.log.filter((e) => e.event === "turn_start")).toHaveLength(1);
  });

  test("a completion after send but before acknowledgment is bare before the turn", async () => {
    const r = rig();
    const first = await startClaudeTurn(r, "a1");
    r.proc.emitLine(JSON.stringify(shellStarted));
    r.proc.emitLine(claudeCompleted(first.uuid));
    await drainTurn(first.turn);

    r.session.send({ id: "a2", text: "next" });
    const uuid = r.proc.lastSentUuid();
    r.proc.emitLine(JSON.stringify(shellStopped));
    r.proc.emitLine(JSON.stringify(shellNotificationKilled));
    // Both events are readable before any native acknowledgment publishes
    // a2. A provisional turn must neither park nor claim them.
    expect((await r.turns.next()).value).toEqual({
      kind: "background",
      id: "bcrfa3pxt",
      job: "shell",
      state: "stopped",
    });
    expect((await r.turns.next()).value).toMatchObject({
      kind: "background",
      outputFile: shellNotificationKilled.output_file,
      summary: shellNotificationKilled.summary,
    });
    expect(r.log.filter((entry) => entry.event === "turn_start")).toHaveLength(1);

    r.proc.emitLine(claudeInitWith([uuid]));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a2");
    r.proc.emitLine(claudeCompleted(uuid));
    expect((await drainTurn(turn)).some((event) => event.kind === "background")).toBe(false);
    await r.session.close();
  });

  test("pipe grace releases more than 1024 unread bare events and a pending receipt", async () => {
    const r = rig();
    const requested = r.session.stopBackground({ id: "pending", job: "bcrfa3pxt" });
    if (requested.state !== "requested") throw new Error("expected requested");
    // The first chunk saturates the session sequence. Keep another chunk
    // queued to prove releasing the producer also joins the stdout pump.
    const record = `${JSON.stringify(shellStarted)}\n`;
    r.proc.emitChunk(record.repeat(1_026));
    r.proc.emitChunk(record.repeat(74));
    r.proc.exitWithoutClosing(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(r.proc.stdout.pullCount).toBe(1);
    r.clock.advance(PIPE_GRACE_MS + 1);

    await r.session.close();
    expect(await requested.settled).toEqual({ state: "rejected", reason: "closed" });
    const seen: HarnessEvent[] = [];
    for (;;) {
      const item = await r.turns.next();
      if (item.done) break;
      if (isSessionTurn(item.value)) throw new Error("unexpected turn");
      seen.push(item.value);
    }
    expect(seen).toHaveLength(1_100);
    expect(seen.every((event) => event.kind === "background" && event.state === "running")).toBe(
      true,
    );
    expect(r.log.filter((entry) => entry.event === "turn_start")).toHaveLength(0);
    expect(r.proc.outputDisposed).toBe(true);
    expect(r.proc.stdout.activeReaderCount).toBe(0);
    expect(r.proc.stderr.activeReaderCount).toBe(0);
  });

  test("the stop's own job end arrives as background stopped events after the receipt", async () => {
    const r = rig();
    const { turn, uuid } = await startClaudeTurn(r, "a1");
    r.proc.emitLine(JSON.stringify(shellStarted));
    const requested = r.session.stopBackground({
      id: "stop-1",
      job: "bcrfa3pxt",
    });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(stopTaskResponse(lastStdin(r.proc).request_id, true));
    expect(await requested.settled).toEqual({ state: "sent" });
    // The job's own end follows on the stream, independent of the receipt.
    r.proc.emitLine(JSON.stringify(shellStopped));
    r.proc.emitLine(JSON.stringify(shellNotificationKilled));
    r.proc.emitLine(claudeCompleted(uuid));
    const events = await drainTurn(turn);
    expect(events.filter((e) => e.kind === "background").map((e) => e.state)).toEqual([
      "running",
      "stopped",
      "stopped",
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("a subagent's steps stream inside the turn carrying parentCallId", async () => {
    const r = rig();
    const { turn, uuid } = await startClaudeTurn(r, "a1");
    r.proc.emitLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01MUEttnZ12CienaciPXJPmq",
              name: "Bash",
              input: { command: "ls / | wc -l" },
            },
          ],
        },
        parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent_id: "a34310bd3dc4bd051",
        session_id: sid,
      }),
    );
    r.proc.emitLine(claudeCompleted(uuid));
    const events = await drainTurn(turn);
    expect(events.filter((e) => e.kind === "tool")).toEqual([
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls / | wc -l" },
        callId: "toolu_01MUEttnZ12CienaciPXJPmq",
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
    await r.session.close();
  });
});
