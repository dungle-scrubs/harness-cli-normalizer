/**
 * Session-runner tests for the cursor-sdk input kind (issue #440): the
 * generic openSession machinery driven by a FakeProcess speaking the
 * worker wire. Covers the spawn (marker argv, stdin pipe, open line with
 * model and restriction), receipts, turn publication on run evidence,
 * busy rejection, interrupt settlement through the native cancelled turn
 * end, follow-up sends, the open-failure path settling buffered state,
 * and malformed worker records.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { isSessionTurn, openSession } from "../../src/execution/open-session.js";
import { encodeCursorSdkOpened } from "../../src/interpretation/cursor-sdk.js";
import { composeEscalatedPrompt } from "../../src/interpretation/question.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";
const callerSessionId = "0f0e0d0c-0b0a-4000-8000-000000000001";

const makeDeps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
};

const opened = () => encodeCursorSdkOpened("hcn-identity", agentId).trim();
const receipt = (token: string) =>
  JSON.stringify({ hcn: "receipt", id: `hcn-send:${token}`, disposition: "started" });
const sendFailed = (token: string, message: string) =>
  JSON.stringify({ hcn: "send-failed", id: `hcn-send:${token}`, message, errorKind: "native" });
const turnEnd = (status: string) => JSON.stringify({ hcn: "turn-end", status });
const event = (observation: Record<string, unknown>) =>
  JSON.stringify({ hcn: "event", event: observation });
const delta = (text: string) =>
  JSON.stringify({ hcn: "event", delta: { type: "text-delta", text } });

describe("openSession cursor-sdk (fake worker process)", () => {
  test("spawns the worker marker with a pipe, writes the open line with model and restriction, and announces the minted agent id", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(
      cursorCli,
      { sessionId: callerSessionId, model: "grok-4.7-high" },
      deps,
    );
    expect(deps.spawner.calls[0]?.argv).toEqual(["hcn-cursor-sdk-worker"]);
    expect(deps.spawner.calls[0]?.opts.stdin).toBe("pipe");
    expect(proc.stdinLines[0]).toBe(
      JSON.stringify({
        hcn: "open",
        id: "hcn-identity",
        model: "grok-4.7-high",
      }),
    );
    proc.emitLine(opened());
    handle.send({ id: "one", text: "hello" });
    expect(proc.stdinLines[1]).toBe(
      JSON.stringify({
        hcn: "prompt",
        id: "hcn-send:1",
        message: composeEscalatedPrompt("hello", "ask", "session"),
      }),
    );
    proc.emitLine(receipt("1"));
    proc.emitLine(delta("H"));
    proc.emitLine(
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "HCN_CURSOR_SDK_OK" }] },
      }),
    );
    proc.emitLine(turnEnd("finished"));
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    expect(turn).toBeDefined();
    if (turn === undefined) return;
    const events = await drainTurn(turn);
    expect(events.map((e) => e.kind)).toEqual(["identity", "token", "message", "done"]);
    const identity = events[0];
    expect(identity).toMatchObject({
      kind: "identity",
      sessionId: agentId,
      authority: "harness-minted",
    });
    expect(events[3]).toMatchObject({ kind: "done", cause: "clean" });
    await handle.close();
  });

  test("a settled send resolves started; a busy send resolves rejected natively and the active turn keeps running", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, deps);
    proc.emitLine(opened());
    const first = handle.send({ id: "a", text: "first" });
    proc.emitLine(receipt("1"));
    const settled = await first.settled;
    expect(settled).toEqual({ disposition: "started" });
    proc.emitLine(delta("w"));
    const raced = handle.send({ id: "b", text: "second" });
    proc.emitLine(sendFailed("2", `Agent ${agentId} already has active run`));
    expect(await raced.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    proc.emitLine(turnEnd("finished"));
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    const events = turn ? await drainTurn(turn) : [];
    // The busy send's rejection is an error observation inside the turn,
    // and the active run still ends the turn clean.
    expect(
      events.some(
        (e) => e.kind === "error" && String(e.message).includes("already has active run"),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await handle.close();
  });

  test("interrupt during a run settles interrupted on the native cancelled turn end; idle settles not-active", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, deps);
    proc.emitLine(opened());
    handle.send({ id: "a", text: "essay" });
    proc.emitLine(receipt("1"));
    proc.emitLine(delta("w"));
    const interrupt = handle.interrupt({ id: "i1" });
    if (interrupt.state !== "requested") throw new Error("interrupt rejected");
    // The runner mints its own correlation token; answer the one written.
    const abortId = (JSON.parse(proc.stdinLines.at(-1) as string) as { id: string }).id;
    proc.emitLine(JSON.stringify({ hcn: "abort-receipt", id: abortId, accepted: true }));
    proc.emitLine(turnEnd("cancelled"));
    const receiptSettled = await interrupt.settled;
    expect(receiptSettled).toEqual({ state: "interrupted" });
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    const events = turn ? await drainTurn(turn) : [];
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    // The worker explicitly distinguishes idle from a native cancel refusal.
    const idle = handle.interrupt({ id: "i2" });
    if (idle.state !== "requested") throw new Error("idle interrupt rejected");
    const idleAbortId = (JSON.parse(proc.stdinLines.at(-1) as string) as { id: string }).id;
    proc.emitLine(
      JSON.stringify({ hcn: "abort-receipt", id: idleAbortId, accepted: false, idle: true }),
    );
    expect(await idle.settled).toEqual({ state: "not-active" });
    await handle.close();
  });

  test("a second idle send opens its own turn (follow-up recall)", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, deps);
    proc.emitLine(opened());
    handle.send({ id: "one", text: "remember" });
    proc.emitLine(receipt("1"));
    proc.emitLine(turnEnd("finished"));
    handle.send({ id: "two", text: "recall" });
    proc.emitLine(receipt("2"));
    proc.emitLine(
      event({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "violet-acorn" }] },
      }),
    );
    proc.emitLine(turnEnd("finished"));
    const turns = handle.turns[Symbol.asyncIterator]();
    const first = (await turns.next()).value;
    const firstEvents = first ? await drainTurn(first) : [];
    expect(firstEvents.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    const second = (await turns.next()).value;
    const secondEvents = second ? await drainTurn(second) : [];
    expect(second.inputId).toBe("two");
    expect(secondEvents.some((e) => e.kind === "message" && e.text === "violet-acorn")).toBe(true);
    await handle.close();
  });

  test("an open failure fails the session with the native message and settles any written send", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, deps);
    const send = handle.send({ id: "one", text: "early" });
    proc.emitLine(
      JSON.stringify({
        hcn: "open-failed",
        id: "hcn-identity",
        message: "Invalid API key",
        errorKind: "auth",
      }),
    );
    // The refused open settles the written send natively and closes the
    // session instead of hanging on a receipt that can never arrive.
    expect(await send.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    proc.exit(1);
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    const events = turn ? await drainTurn(turn) : [];
    expect(events.some((e) => e.kind === "failure")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    await handle.close();
  });

  test("#476: a failed open settles the stdout overflow its turn held", async () => {
    const proc = new FakeProcess();
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, makeDeps(proc));
    const send = handle.send({ id: "one", text: "early" });
    proc.emitChunk(`${"x".repeat(16_777_217)}\n`);
    proc.emitLine(
      JSON.stringify({ hcn: "open-failed", message: "Invalid API key", errorKind: "auth" }),
    );
    expect(await send.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    proc.exit(1);
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    const events = turn ? await drainTurn(turn) : [];
    expect(events.filter((e) => e.kind === "failure")).toContainEqual({
      kind: "failure",
      class: "transport",
      retryable: true,
      message:
        "Transport failure (output line overflow: stdout line of 16,777,217 bytes exceeds the 16,777,216-character line limit and was discarded) - retry or route to another provider",
    });
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    await handle.close();
  });

  test("a failed open rejects two sends without starting a second provisional turn", async () => {
    const proc = new FakeProcess();
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, makeDeps(proc));
    const collected = (async () => {
      const turns = [];
      for await (const item of handle.turns) {
        // Main widened the turns channel with bare background events
        // (claude); a cursor session yields turns only, and the guard
        // keeps the drain typed.
        if (isSessionTurn(item)) turns.push(await drainTurn(item));
      }
      return turns;
    })();
    const first = handle.send({ id: "one", text: "first" });
    const second = handle.send({ id: "two", text: "second" });
    proc.emitLine(
      JSON.stringify({ hcn: "open-failed", message: "Invalid API key", errorKind: "auth" }),
    );
    expect(await first.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    expect(await second.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    proc.exit(1);
    const turns = await collected;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.at(-1)).toMatchObject({
      kind: "done",
      failure: { class: "auth", authKind: "invalid-key" },
    });
    await handle.close();
  });

  test("cancelling an unopened prompt settles the interruption without a run or failure", async () => {
    const proc = new FakeProcess();
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, makeDeps(proc));
    const collected = (async () => {
      const turns = [];
      for await (const item of handle.turns) {
        // Main widened the turns channel with bare background events
        // (claude); a cursor session yields turns only, and the guard
        // keeps the drain typed.
        if (isSessionTurn(item)) turns.push(await drainTurn(item));
      }
      return turns;
    })();
    const send = handle.send({ id: "early", text: "not sent" });
    const interrupt = handle.interrupt({ id: "cancel" });
    if (interrupt.state !== "requested") throw new Error("interrupt rejected");
    const abortId = (JSON.parse(proc.stdinLines.at(-1) as string) as { id: string }).id;
    proc.emitLine(JSON.stringify({ hcn: "send-cancelled", id: "hcn-send:1" }));
    proc.emitLine(JSON.stringify({ hcn: "abort-receipt", id: abortId, accepted: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.exit(0);
    expect(await send.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    expect(await interrupt.settled).toEqual({ state: "interrupted" });
    expect(await collected).toEqual([]);
    await handle.close();
  });

  // The refusal receipt can land before or after the run's own turn-end
  // record (the SDK settles a refused cancel in either order). Both wire
  // orders must read `rejected`/`native-rejected` - a normal completion
  // that arrives first never converts the refusal into `not-active`.
  for (const [label, refusalAfterTurnEnd] of [
    ["receipt first", false],
    ["turn-end first", true],
  ] as const) {
    test(`a live native cancellation refusal remains rejected (${label})`, async () => {
      const proc = new FakeProcess();
      const handle = openSession(cursorCli, { sessionId: callerSessionId }, makeDeps(proc));
      proc.emitLine(opened());
      const send = handle.send({ id: "live", text: "ongoing" });
      proc.emitLine(receipt("1"));
      await send.settled;
      const interrupt = handle.interrupt({ id: "cancel" });
      if (interrupt.state !== "requested") throw new Error("interrupt rejected");
      const abortId = (JSON.parse(proc.stdinLines.at(-1) as string) as { id: string }).id;
      if (refusalAfterTurnEnd) proc.emitLine(turnEnd("finished"));
      proc.emitLine(JSON.stringify({ hcn: "abort-receipt", id: abortId, accepted: false }));
      expect(await interrupt.settled).toEqual({ state: "rejected", reason: "native-rejected" });
      if (!refusalAfterTurnEnd) proc.emitLine(turnEnd("finished"));
      await handle.close();
    });
  }

  test("resume rides the open line; the worker wire is identical for a resumed session", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(
      cursorCli,
      { sessionId: agentId, isResume: true, model: "grok-4.7" },
      deps,
    );
    expect(JSON.parse(proc.stdinLines[0] as string)).toMatchObject({
      hcn: "open",
      resume: agentId,
      model: "grok-4.7",
    });
    proc.emitLine(encodeCursorSdkOpened("hcn-identity", agentId).trim());
    handle.send({ id: "one", text: "continue" });
    proc.emitLine(receipt("1"));
    proc.emitLine(turnEnd("finished"));
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    expect(turn).toBeDefined();
    await handle.close();
  });

  test("malformed worker records never kill the pump", async () => {
    const proc = new FakeProcess();
    const deps = makeDeps(proc);
    const handle = openSession(cursorCli, { sessionId: callerSessionId }, deps);
    proc.emitLine(opened());
    proc.emitLine("not json at all");
    proc.emitLine('{"hcn":"event"}');
    proc.emitLine('{"hcn":"event","event":{"type":"tool_call","status":"weird"}}');
    handle.send({ id: "one", text: "hi" });
    proc.emitLine(receipt("1"));
    proc.emitLine(turnEnd("finished"));
    const turns = handle.turns[Symbol.asyncIterator]();
    const turn = (await turns.next()).value;
    const events = turn ? await drainTurn(turn) : [];
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await handle.close();
  });
});
