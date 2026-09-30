/**
 * openSession over the codex app-server protocol (issue #330): NDJSON
 * JSON-RPC on stdio, one process, many turns. The identity probe is the
 * initialize handshake plus the thread open; a send maps to turn/start
 * when idle and turn/steer with the tracked native turn id when busy;
 * turn/completed delimits a turn. Wire evidence:
 * test/fixtures/codex-0.159.2/session (codex-cli 0.159.2).
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import {
  openSession,
  type SessionSendResult,
  type SessionTurn,
} from "../../src/execution/open-session.js";
import { composeEscalatedPrompt } from "../../src/interpretation/question.js";
import {
  IDENTITY_PROBE_ID,
  INITIALIZE_ID,
  SEND_ID,
} from "../../src/interpretation/session-input.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const THREAD = "01a0f0db-4c47-77e1-a299-22e74c5d41df";
const TURN = "01a0f0db-4d72-72d3-b289-54be7290ba03";

const jsonrpc = (id: string | number, result: unknown) =>
  JSON.stringify({ id, result, jsonrpc: "2.0" });
const jsonrpcError = (id: string | number, code: number, message: string) =>
  JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" });
const notification = (method: string, params: unknown) =>
  JSON.stringify({ method, params, jsonrpc: "2.0" });
const turnCompleted = (status: string) =>
  notification("turn/completed", {
    threadId: THREAD,
    turn: { completedAt: 1, durationMs: 5, error: null, id: TURN, items: [], status },
  });

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

const codexMessage = (text: string) =>
  notification("item/completed", {
    completedAtMs: 2,
    item: {
      delivery: null,
      id: "msg_1",
      memoryCitation: null,
      phase: null,
      questions: null,
      text,
      type: "agentMessage",
    },
    threadId: THREAD,
    turnId: TURN,
  });

/** Open a codex session against a fake process and settle the spawn
 * handshake (probe written, thread/start answered, identity announced). */
const openCodexSession = async (
  proc: FakeProcess,
  opts: { clientVersion?: string; isResume?: boolean } = {},
) => {
  const d = makeDeps(proc);
  const session = openSession(
    codexCli,
    {
      sessionId: sid,
      ...(opts.isResume === undefined ? {} : { isResume: opts.isResume }),
      ...(opts.clientVersion === undefined ? {} : { clientVersion: opts.clientVersion }),
    },
    d,
  );
  expect(d.spawner.calls[0]?.argv).toEqual(["codex", "app-server"]);
  const turnsIter = session.turns[Symbol.asyncIterator]();
  // The probe: initialize, then the thread open, then the response.
  proc.emitLine(
    jsonrpc(INITIALIZE_ID, {
      codexHome: "/home/.codex",
      platformOs: "macos",
      userAgent: "hcn/0.9.2",
    }),
  );
  proc.emitLine(
    jsonrpc(IDENTITY_PROBE_ID, { thread: { cwd: "/tmp/w", id: THREAD, model: "gpt-6-astra" } }),
  );
  await new Promise((r) => setTimeout(r, 0));
  return { d, session, turnsIter };
};

describe("openSession (codex app-server, fake process)", () => {
  test("the spawn probe is initialize plus thread/start; the response announces harness-minted identity", async () => {
    const proc = new FakeProcess();
    const { session } = await openCodexSession(proc, { clientVersion: "0.9.2" });
    const lines = proc.stdinLines;
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: { clientInfo: { name: "hcn", version: "0.9.2" } },
    });
    expect(JSON.parse(lines[1] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: IDENTITY_PROBE_ID,
      method: "thread/start",
      params: {},
    });
    await session.close();
  });

  test("a resume open swaps the thread open for thread/resume with the requested id", async () => {
    const proc = new FakeProcess();
    const { session } = await openCodexSession(proc, { isResume: true });
    expect(JSON.parse(proc.stdinLines[1] ?? "null")).toMatchObject({
      method: "thread/resume",
      params: { threadId: sid },
    });
    await session.close();
  });

  test("an idle send opens the hcn turn only when the turn/start receipt confirms it", async () => {
    const proc = new FakeProcess();
    const { session, turnsIter } = await openCodexSession(proc);
    const turnPromise = turnsIter.next();

    let sent: SessionSendResult | undefined;
    setImmediate(() => {
      sent = session.send({ id: "in-1", text: "turn one prompt" });
    });
    await new Promise((r) => setTimeout(r, 10));
    // The request is written immediately; no hcn turn exists yet.
    expect(proc.stdinLines).toHaveLength(3);
    expect(JSON.parse(proc.stdinLines[2] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: `${SEND_ID}:in-1`,
      method: "turn/start",
      params: {
        threadId: THREAD,
        input: [
          { text: composeEscalatedPrompt("turn one prompt", "ask", "session"), type: "text" },
        ],
      },
    });
    expect((turnPromise as { done?: boolean }).done).toBeUndefined();

    proc.emitLine(
      jsonrpc(`${SEND_ID}:in-1`, { turn: { id: TURN, items: [], status: "inProgress" } }),
    );
    const settled = await (sent as SessionSendResult).settled;
    expect(settled).toMatchObject({ disposition: "started" });
    const yielded = await turnPromise;
    const turn = yielded.value as SessionTurn;
    expect(turn.inputId).toBe("in-1");
    proc.emitLine(codexMessage("one"));
    proc.emitLine(turnCompleted("completed"));
    const events = await drainTurn(turn as AsyncIterable<HarnessEvent>);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "one" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean", exitCode: null });
    await session.close();
  });

  test("a failed turn/start receipt rejects the send and leaves no stuck turn", async () => {
    const proc = new FakeProcess();
    const { session, turnsIter } = await openCodexSession(proc);
    let sent: SessionSendResult | undefined;
    setImmediate(() => {
      sent = session.send({ id: "in-1", text: "doomed" });
    });
    await new Promise((r) => setTimeout(r, 10));
    proc.emitLine(jsonrpcError(`${SEND_ID}:in-1`, -32000, "thread is closed"));
    const settled = await (sent as SessionSendResult).settled;
    expect(settled).toMatchObject({ disposition: "rejected", reason: "native-rejected" });
    // No turn opened: the next idle send starts fresh, same process.
    const second = session.send({ id: "in-2", text: "again" });
    expect(second.disposition).toBe("started");
    // Probe (2 lines) + the failed send + the fresh send.
    expect(proc.stdinLines).toHaveLength(4);
    expect(JSON.parse(proc.stdinLines[3] ?? "null")).toMatchObject({ method: "turn/start" });
    await session.close();
  });

  test("a mid-turn send steers into the RUNNING turn; no phantom turn follows", async () => {
    const proc = new FakeProcess();
    const { session, turnsIter } = await openCodexSession(proc);
    session.send({ id: "in-1", text: "long turn" });
    proc.emitLine(
      jsonrpc(`${SEND_ID}:in-1`, { turn: { id: TURN, items: [], status: "inProgress" } }),
    );
    const turn1 = (await turnsIter.next()).value as SessionTurn;
    expect(turn1.inputId).toBe("in-1");

    // Guidance while the turn runs: turn/steer with the tracked id.
    const busy = session.send({ id: "in-2", text: "guidance" });
    expect(JSON.parse(proc.stdinLines.at(-1) ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: `${SEND_ID}:in-2`,
      method: "turn/steer",
      params: {
        threadId: THREAD,
        expectedTurnId: TURN,
        input: [{ text: composeEscalatedPrompt("guidance", "ask", "session"), type: "text" }],
      },
    });
    proc.emitLine(jsonrpc(`${SEND_ID}:in-2`, { turnId: TURN }));
    const settled = await busy.settled;
    expect(settled).toMatchObject({ disposition: "started" });

    // The steered text is consumed by the RUNNING turn (verified: the
    // steered input appears as a userMessage inside it). When the turn
    // ends, NO second turn opens - there is no next turn to tag.
    proc.emitLine(codexMessage("answer with guidance applied"));
    proc.emitLine(turnCompleted("completed"));
    await drainTurn(turn1 as AsyncIterable<HarnessEvent>);
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.stdinLines.filter((l) => JSON.parse(l).method === "turn/start")).toHaveLength(1);
    await session.close();
  });

  test("a steered send the harness refuses reports rejected, not silence", async () => {
    const proc = new FakeProcess();
    const { session, turnsIter } = await openCodexSession(proc);
    session.send({ id: "in-1", text: "long turn" });
    proc.emitLine(
      jsonrpc(`${SEND_ID}:in-1`, { turn: { id: TURN, items: [], status: "inProgress" } }),
    );
    const turn1 = (await turnsIter.next()).value as SessionTurn;

    const busy = session.send({ id: "in-2", text: "guidance" });
    proc.emitLine(
      jsonrpcError(
        `${SEND_ID}:in-2`,
        -32600,
        `expected active turn id \`${TURN}\` but found \`other\``,
      ),
    );
    const settled = await busy.settled;
    expect(settled).toMatchObject({ disposition: "rejected", reason: "native-rejected" });

    // The original turn still completes cleanly; the session stays alive.
    proc.emitLine(codexMessage("done"));
    proc.emitLine(turnCompleted("completed"));
    const events = await drainTurn(turn1 as AsyncIterable<HarnessEvent>);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    const next = session.send({ id: "in-3", text: "fresh" });
    expect(next.disposition).toBe("started");
    await session.close();
  });

  test("a failed turn verdict ends the turn failed with the harness's own error", async () => {
    const proc = new FakeProcess();
    const { session, turnsIter } = await openCodexSession(proc);
    session.send({ id: "in-1", text: "turn" });
    proc.emitLine(
      jsonrpc(`${SEND_ID}:in-1`, { turn: { id: TURN, items: [], status: "inProgress" } }),
    );
    const turn = (await turnsIter.next()).value as SessionTurn;
    proc.emitLine(
      notification("error", {
        error: {
          message: "You've hit your usage limit.",
          codexErrorInfo: null,
          misalignment: null,
          additionalDetails: null,
        },
        threadId: THREAD,
        turnId: TURN,
        willRetry: false,
      }),
    );
    proc.emitLine(turnCompleted("failed"));
    const events = await drainTurn(turn as AsyncIterable<HarnessEvent>);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "limit" });
    expect(events.some((e) => e.kind === "failure")).toBe(true);
    await session.close();
  });

  test("a send before the thread-open response is buffered and flushed with the minted thread id", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(codexCli, { sessionId: sid }, d);
    const early = session.send({ id: "early", text: "too soon" });
    expect(early.disposition).toBe("started");
    expect(early.settled).toBeDefined();
    // Nothing but the probe has been written.
    expect(proc.stdinLines).toHaveLength(2);
    const turnsIter = session.turns[Symbol.asyncIterator]();
    proc.emitLine(jsonrpc(INITIALIZE_ID, { userAgent: "hcn" }));
    proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
    await new Promise((r) => setTimeout(r, 10));
    // Flushed with the minted thread id bound.
    expect(JSON.parse(proc.stdinLines[2] ?? "null")).toMatchObject({
      method: "turn/start",
      params: { threadId: THREAD },
    });
    proc.emitLine(
      jsonrpc(`${SEND_ID}:early`, { turn: { id: TURN, items: [], status: "inProgress" } }),
    );
    const turn = (await turnsIter.next()).value as SessionTurn;
    expect(turn.inputId).toBe("early");
    proc.emitLine(codexMessage("ok"));
    proc.emitLine(turnCompleted("completed"));
    await drainTurn(turn as AsyncIterable<HarnessEvent>);
    await session.close();
  });

  test("close ends stdin and the process exits cleanly (exit 0 observed live)", async () => {
    const proc = new FakeProcess();
    const { session } = await openCodexSession(proc);
    await session.close();
    expect(proc.stdinEnded).toBe(true);
  });

  test("session spawn honors the model render: -c model, never --model", () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    openSession(codexCli, { sessionId: sid, model: "gpt-6-astra", effort: "high" }, d);
    const argv = d.spawner.calls[0]?.argv ?? [];
    expect(argv).toEqual([
      "codex",
      "app-server",
      "-c",
      'model="gpt-6-astra"',
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });
});
