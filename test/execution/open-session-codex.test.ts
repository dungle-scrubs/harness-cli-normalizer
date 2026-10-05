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
    const { session } = await openCodexSession(proc);
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

// Issue #345: codex app-server's identity probe fails when its config.toml
// is invalid. hcn's runner used to park the error in preTurnEvents and let
// the buffered sends hang forever; the fix settles the sends' receipts,
// records it as a session-scoped failure, and ends stdin so the runner does
// not wait for stdin EOF.
describe("issue #345: a refused identity probe on codex settles sends and closes", () => {
  const configMessage =
    "failed to load configuration: <path>/config.toml:1:9: string values must be quoted, expected literal string";

  test("identity probe answers -32600 with a config error: send settles rejected, session closes failed", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const logged: Record<string, unknown>[] = [];
    const session = openSession(codexCli, { sessionId: sid }, { ...d, log: (e) => logged.push(e) });
    // Send arrives before the probe settles; buffered.
    const send = session.send({ id: "a", text: "say hi" });
    expect(send.disposition).toBe("started");
    expect(send.settled).toBeDefined();
    expect(proc.stdinLines).toHaveLength(2); // probe only

    // The probe fails: initialize answered, then thread/start -32600.
    proc.emitLine(jsonrpc(INITIALIZE_ID, { userAgent: "hcn/0.9.4" }));
    proc.emitLine(jsonrpcError(IDENTITY_PROBE_ID, -32600, configMessage));
    await new Promise((r) => setTimeout(r, 10));

    // Buffered send's receipt settles rejected/native-rejected.
    const settled = await send.settled;
    expect(settled).toMatchObject({ disposition: "rejected", reason: "native-rejected" });

    // hcn ends stdin on its own; the runner does not wait for close() to
    // be called.
    expect(proc.stdinEnded).toBe(true);

    // The fake exits cleanly; the runner records the failure and the
    // session-close log shows cause "failed" with the failure attached.
    proc.exit(0);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 10));
    const close = logged.find((e) => e.event === "session_close");
    expect(close).toMatchObject({ cause: "failed", exitCode: 0 });
    const failure = (close as { failure?: { class: string; message: string } })?.failure;
    expect(failure?.class).toBe("native");
    expect(failure?.message).toContain(configMessage);
  });
});

describe("issue #345 popeye variant: a refused create leaves the buffered send's turn ending in done with that failure", () => {
  test("popeye create answers error: buffered send's turn ends done with the failure", async () => {
    const proc = new FakeProcess();
    const { popeyeCli } = await import("../../src/knowledge/popeye.js");
    const d = makeDeps(proc);
    const logged: Record<string, unknown>[] = [];
    const session = openSession(
      popeyeCli,
      { sessionId: "session-1" },
      { ...d, log: (e) => logged.push(e) },
    );
    // Buffered send arrives before the create response.
    const send = session.send({ id: "a", text: "say hi" });
    expect(send.disposition).toBe("started");
    // popeye has no native receipt; only the probe is on the wire.
    expect(proc.stdinLines).toHaveLength(1);

    // Create answers with an error: probe-failed. popeyePending stays,
    // and the runner ends stdin so finalize can settle.
    proc.emitLine(
      JSON.stringify({
        id: IDENTITY_PROBE_ID,
        error: { code: "invalid_config", message: "config.toml parse error" },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.stdinEnded).toBe(true);
    proc.exit(0);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 10));

    const turns = session.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    const events: HarnessEvent[] = [];
    for await (const event of turn) events.push(event);
    expect(events.find((event) => event.kind === "error")).toMatchObject({
      message: expect.stringContaining("config.toml parse error"),
    });
    expect(events.find((event) => event.kind === "failure")).toMatchObject({ class: "native" });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      failure: expect.objectContaining({ class: "native" }),
    });
    const close = logged.find((e) => e.event === "session_close");
    expect(close).toMatchObject({ cause: "failed", exitCode: 0 });
    const failure = (close as { failure?: { class: string } })?.failure;
    expect(failure?.class).toBe("native");
  });
});

// Issue #347: codex crashes after a send but before the turn/start
// receipt. No hcn turn is open (codex opens its turn on the receipt).
// session_close used to report cause "crash" with no failure; the fix
// classifies the crash via the stderr tail and records it as a
// session-scoped failure.
describe("issue #347: codex crash with no open turn classifies the exit", () => {
  test("stderr line + exit 1 before any turn/start response: closed.failure.class is native", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const logged: Record<string, unknown>[] = [];
    const session = openSession(codexCli, { sessionId: sid }, { ...d, log: (e) => logged.push(e) });
    const send = session.send({ id: "a", text: "say hi" });
    expect(send.disposition).toBe("started");
    // The send is buffered until identity lands: only the probe has been
    // written.
    expect(proc.stdinLines).toHaveLength(2);

    // Identity settles; the buffered send flushes a turn/start, then the
    // harness dies before the receipt arrives.
    proc.emitLine(jsonrpc(INITIALIZE_ID, { userAgent: "hcn/0.9.4" }));
    proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.stdinLines).toHaveLength(3); // probe + flushed turn/start
    proc.emitStderr("panicked at config: bridge closed");
    proc.exit(1);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 10));

    const settled = await send.settled;
    expect(settled).toMatchObject({ disposition: "rejected", reason: "closed" });

    const close = logged.find((e) => e.event === "session_close");
    expect(close).toMatchObject({ cause: "crash", exitCode: 1 });
    const failure = (close as { failure?: { class: string; message: string } })?.failure;
    expect(failure?.class).toBe("native");
    expect(failure?.message).toContain("panicked at config: bridge closed");
  });

  test("empty stderr + nonzero exit with no open turn: closed.failure.class is transport", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const logged: Record<string, unknown>[] = [];
    const session = openSession(codexCli, { sessionId: sid }, { ...d, log: (e) => logged.push(e) });
    session.send({ id: "a", text: "say hi" });
    proc.emitLine(jsonrpc(INITIALIZE_ID, { userAgent: "hcn/0.9.4" }));
    proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
    await new Promise((r) => setTimeout(r, 10));
    proc.exit(1);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 10));

    const close = logged.find((e) => e.event === "session_close");
    expect(close).toMatchObject({ cause: "crash", exitCode: 1 });
    const failure = (close as { failure?: { class: string } })?.failure;
    expect(failure?.class).toBe("transport");
  });

  test("exit 0 with no turn and no refusal: no session_failure recorded", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const logged: Record<string, unknown>[] = [];
    openSession(codexCli, { sessionId: sid }, { ...d, log: (e) => logged.push(e) });
    proc.exit(0);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 10));

    const close = logged.find((e) => e.event === "session_close");
    expect(close?.cause).toBe("clean");
    expect((close as { failure?: unknown })?.failure).toBeUndefined();
  });
});

test("an identified popeye session ends a refused prompt with native failure and closes", async () => {
  const proc = new FakeProcess();
  const { popeyeCli } = await import("../../src/knowledge/popeye.js");
  const session = openSession(popeyeCli, { sessionId: sid }, makeDeps(proc));
  proc.emitLine(
    JSON.stringify({
      id: IDENTITY_PROBE_ID,
      result: { _tag: "snapshot", sessionId: "popeye-session" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.send({ id: "a", text: "say hi" });
  expect(JSON.parse(proc.stdinLines.at(-1) ?? "null")).toMatchObject({
    id: `${SEND_ID}:a`,
    sessionId: "popeye-session",
  });
  const turns = session.turns[Symbol.asyncIterator]();
  const turn = (await turns.next()).value as SessionTurn;
  expect(turn.inputId).toBe("a");
  proc.emitLine(jsonrpcError(`${SEND_ID}:a`, -32000, "prompt refused"));
  const events = await drainTurn(turn);
  expect(events.find((event) => event.kind === "failure")).toMatchObject({ class: "native" });
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { class: "native" },
  });
  await session.close();
  expect(proc.stdinEnded).toBe(true);
  expect((await turns.next()).done).toBe(true);
});

test("a codex stderr auth wall before turn acceptance closes crash with auth failure", async () => {
  const proc = new FakeProcess();
  const logged: Record<string, unknown>[] = [];
  const session = openSession(
    codexCli,
    { sessionId: sid },
    { ...makeDeps(proc), log: (e) => logged.push(e) },
  );
  proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const send = session.send({ id: "a", text: "say hi" });
  expect(JSON.parse(proc.stdinLines.at(-1) ?? "null")).toMatchObject({ method: "turn/start" });
  proc.emitStderr("401 Unauthorized");
  proc.exit(1);
  await session.close();
  expect(await send.settled).toEqual({ disposition: "rejected", reason: "closed" });
  expect((await session.turns[Symbol.asyncIterator]().next()).done).toBe(true);
  expect(logged.find((e) => e.event === "session_close")).toMatchObject({
    cause: "crash",
    exitCode: 1,
    failure: { class: "auth" },
  });
});

test("a codex stderr limit wall before turn acceptance closes limit with usage-limit failure", async () => {
  const proc = new FakeProcess();
  const logged: Record<string, unknown>[] = [];
  const session = openSession(
    codexCli,
    { sessionId: sid },
    { ...makeDeps(proc), log: (e) => logged.push(e) },
  );
  proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const send = session.send({ id: "a", text: "say hi" });
  expect(JSON.parse(proc.stdinLines.at(-1) ?? "null")).toMatchObject({ method: "turn/start" });
  proc.emitStderr("You have hit your usage limit.");
  proc.exit(1);
  await session.close();
  expect(await send.settled).toEqual({ disposition: "rejected", reason: "closed" });
  expect((await session.turns[Symbol.asyncIterator]().next()).done).toBe(true);
  expect(logged.find((e) => e.event === "session_close")).toMatchObject({
    cause: "limit",
    exitCode: 1,
    failure: { class: "usage-limit" },
  });
});

test("a no-turn codex crash does not inherit the completed turn's task failure", async () => {
  const proc = new FakeProcess();
  const logged: Record<string, unknown>[] = [];
  const session = openSession(
    codexCli,
    { sessionId: sid },
    { ...makeDeps(proc), log: (e) => logged.push(e) },
  );
  proc.emitLine(jsonrpc(IDENTITY_PROBE_ID, { thread: { id: THREAD } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const first = session.send({ id: "first", text: "do work" });
  proc.emitLine(jsonrpc(`${SEND_ID}:first`, { turn: { id: TURN } }));
  expect(await first.settled).toEqual({ disposition: "started" });
  const turns = session.turns[Symbol.asyncIterator]();
  const turn = (await turns.next()).value as SessionTurn;
  proc.emitLine(
    notification("error", {
      error: { message: "could not finish work", codexErrorInfo: null },
      threadId: THREAD,
      turnId: TURN,
      willRetry: false,
    }),
  );
  proc.emitLine(turnCompleted("failed"));
  const events = await drainTurn(turn);
  expect(events.at(-1)).toMatchObject({ kind: "done", failure: { class: "task" } });
  const next = session.send({ id: "a", text: "try again" });
  expect(JSON.parse(proc.stdinLines.at(-1) ?? "null")).toMatchObject({ method: "turn/start" });
  proc.exit(1);
  await session.close();
  expect(await next.settled).toEqual({ disposition: "rejected", reason: "closed" });
  expect((await turns.next()).done).toBe(true);
  expect(logged.find((e) => e.event === "session_close")).toMatchObject({
    cause: "crash",
    failure: { class: "transport" },
  });
});
