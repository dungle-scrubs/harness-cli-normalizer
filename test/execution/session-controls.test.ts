/**
 * Issue #426: explicit delivery modes and interruption on a live session,
 * driven through openSession over a fake native process. The Pi records use
 * the wire shapes captured from pi 1.4.0 (prompt receipts carry
 * data.disposition started|queued|handled; agent_settled carries aborted;
 * the abort response arrives AFTER the aborted settlement). The Claude
 * records use the 2.1.312 shapes (user_message_uuids on init/status,
 * message_start, assistant and result; background task results carry
 * origin.kind task-notification and no input uuids). Native fakes answer
 * with the request id the runner actually wrote.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (
  descriptor: HarnessDescriptor,
  procOpts: { exitOnStdinEnd?: boolean } = {},
  stallMs?: number,
) => {
  const proc = new FakeProcess(procOpts);
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
      ...(stallMs === undefined ? {} : { stallMs }),
    },
  );
  const turns = session.turns[Symbol.asyncIterator]();
  return { proc, spawner, sig, clock, log, session, turns };
};

/** Whether a promise has settled once pending I/O has had its turn. */
const settledYet = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await tick();
  return settled;
};

const messagesOf = (events: HarnessEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "message" ? [event.text] : []));

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of turn) out.push(event);
  return out;
};

const lastStdin = (proc: FakeProcess): Record<string, unknown> =>
  JSON.parse(proc.stdinLines.at(-1) ?? "null") as Record<string, unknown>;

const turnStarts = (log: Record<string, unknown>[]) =>
  log.filter((entry) => entry.event === "turn_start");

// --- pi 1.4.0 wire shapes -------------------------------------------------
const piReceipt = (wireId: string, disposition?: "started" | "queued" | "handled") =>
  JSON.stringify({
    id: wireId,
    type: "response",
    command: "prompt",
    success: true,
    ...(disposition === undefined ? {} : { data: { disposition } }),
  });
const piRefusal = (wireId: string, error: string) =>
  JSON.stringify({ id: wireId, type: "response", command: "prompt", success: false, error });
const piAbortResponse = (wireId: unknown, success = true) =>
  JSON.stringify({
    id: wireId,
    type: "response",
    command: "abort",
    success,
    ...(success ? {} : { error: "abort refused" }),
  });
const piSettled = (aborted: boolean) => JSON.stringify({ type: "agent_settled", aborted });
const piAssistant = (text: string) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  });

// --- claude 2.1.312 wire shapes -------------------------------------------
const claudeInit = (uuids?: string[]) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sid,
    ...(uuids === undefined ? {} : { user_message_uuids: uuids }),
  });
const claudeAssistant = (text: string, uuids?: string[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...(uuids === undefined ? {} : { user_message_uuid: uuids[0], user_message_uuids: uuids }),
  });
const claudeResult = (uuids?: string[], origin?: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sid,
    ...(uuids === undefined ? {} : { user_message_uuid: uuids[0], user_message_uuids: uuids }),
    ...(origin === undefined ? {} : { origin }),
  });
const BACKGROUND = { kind: "task-notification", producer: "session-task" };
const uuidOf = (proc: FakeProcess): string => String(lastStdin(proc).uuid);

/** A pi send whose run has started natively: written, receipt answered,
 * turn published. */
const startPiTurn = async (r: ReturnType<typeof rig>, id: string, text = "work") => {
  const send = r.session.send({ id, text });
  r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "started"));
  const turn = (await r.turns.next()).value as SessionTurn;
  expect(await send.settled).toEqual({ disposition: "started" });
  return turn;
};

describe("issue #426: explicit delivery mode mappings", () => {
  test("pi queue and steer ride the prompt as native streamingBehavior, idle or busy", async () => {
    const r = rig(piCli);
    const first = r.session.send({ id: "a", text: "first", delivery: "queue" });
    expect(first.disposition).toBe("started");
    expect(lastStdin(r.proc)).toMatchObject({ type: "prompt", streamingBehavior: "followUp" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "started"));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    expect(await first.settled).toEqual({ disposition: "started" });
    const steer = r.session.send({ id: "b", text: "correct", delivery: "steer" });
    expect(lastStdin(r.proc)).toMatchObject({ type: "prompt", streamingBehavior: "steer" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "queued"));
    expect(await steer.settled).toEqual({ disposition: "started" });
    r.proc.emitLine(piAssistant("steered answer"));
    r.proc.emitLine(piSettled(false));
    const events = await drainTurn(turn);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "steered answer" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
  });

  test("claude stamps a uuid on every frame; only explicit delivery sets priority", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const omitted = lastStdin(r.proc);
    // Omitted delivery keeps native default behavior: no priority field.
    expect(omitted).not.toHaveProperty("priority");
    expect(typeof omitted.uuid).toBe("string");
    r.session.send({ id: "b", text: "later", delivery: "queue" });
    const queued = lastStdin(r.proc);
    expect(queued).toMatchObject({ type: "user", priority: "later" });
    expect(typeof queued.uuid).toBe("string");
    r.session.send({ id: "c", text: "next", delivery: "steer" });
    const steered = lastStdin(r.proc);
    expect(steered).toMatchObject({ type: "user", priority: "next" });
    expect(new Set([omitted.uuid, queued.uuid, steered.uuid]).size).toBe(3);
    r.proc.exit(0);
    await r.session.close();
  });

  test.each([
    { descriptor: codexCli, delivery: "queue" as const },
    { descriptor: antigravityCli, delivery: "queue" as const },
    { descriptor: antigravityCli, delivery: "steer" as const },
  ])(
    "$descriptor.name refuses unsupported $delivery with nothing written, and stays usable",
    async ({ descriptor, delivery }) => {
      const r = rig(descriptor);
      const before = [...r.proc.stdinLines];
      const refused = r.session.send({ id: "x", text: "nope", delivery });
      expect(refused).toEqual({ disposition: "rejected", reason: "unsupported-delivery" });
      expect(r.proc.stdinLines).toEqual(before);
      expect(r.proc.hasExited).toBe(false);
      expect(r.sig.sent).toEqual([]);
      expect(turnStarts(r.log)).toHaveLength(0);
      // The same session still takes an ordinary send.
      const ordinary = r.session.send({ id: "y", text: "fine" });
      expect(ordinary.disposition).toBe("started");
      r.proc.exit(0);
      await r.session.close();
      expect(r.spawner.calls).toHaveLength(1);
    },
  );

  test("explicit codex steer keeps the native turn/start mapping when idle", async () => {
    const r = rig(codexCli);
    r.proc.emitLine(JSON.stringify({ id: "hcn-initialize", jsonrpc: "2.0", result: {} }));
    r.proc.emitLine(
      JSON.stringify({ id: "hcn-identity", jsonrpc: "2.0", result: { thread: { id: "thr-1" } } }),
    );
    await tick();
    r.session.send({ id: "a", text: "go", delivery: "steer" });
    expect(lastStdin(r.proc)).toMatchObject({
      id: expect.stringMatching(/^hcn-send:/),
      method: "turn/start",
    });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #426: every receipt-bearing send carries its own native request id", () => {
  test("pi: a reused caller id gets distinct request ids; answers settle the right command out of order", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a");
    const first = r.session.send({ id: "dup", text: "one", delivery: "steer" });
    const firstWire = r.proc.lastSendRequestId();
    const second = r.session.send({ id: "dup", text: "two", delivery: "queue" });
    const secondWire = r.proc.lastSendRequestId();
    expect(firstWire).not.toBe(secondWire);
    // Caller ids never ride the wire.
    expect(firstWire).not.toContain("dup");
    // The SECOND command is answered first, with a different outcome.
    r.proc.emitLine(piRefusal(secondWire, "queue full"));
    expect(await second.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    r.proc.emitLine(piReceipt(firstWire, "queued"));
    expect(await first.settled).toEqual({ disposition: "started" });
    r.proc.emitLine(piSettled(false));
    expect((await drainTurn(turn)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("codex: a reused caller id gets distinct request ids; answers settle the right command out of order", async () => {
    const r = rig(codexCli);
    r.proc.emitLine(JSON.stringify({ id: "hcn-initialize", jsonrpc: "2.0", result: {} }));
    r.proc.emitLine(
      JSON.stringify({ id: "hcn-identity", jsonrpc: "2.0", result: { thread: { id: "thr-1" } } }),
    );
    await tick();
    const first = r.session.send({ id: "dup", text: "one" });
    const firstWire = r.proc.lastSendRequestId();
    const second = r.session.send({ id: "dup", text: "two" });
    const secondWire = r.proc.lastSendRequestId();
    expect(firstWire).not.toBe(secondWire);
    r.proc.emitLine(
      JSON.stringify({
        id: secondWire,
        jsonrpc: "2.0",
        error: { code: -32600, message: "busy" },
      }),
    );
    expect(await second.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    r.proc.emitLine(
      JSON.stringify({
        id: firstWire,
        jsonrpc: "2.0",
        result: { turn: { id: "turn-1", items: [], status: "inProgress" } },
      }),
    );
    expect(await first.settled).toEqual({ disposition: "started" });
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("dup");
    r.proc.exit(0);
    await drainTurn(turn);
    await r.session.close();
  });

  test("a response for a request hcn never wrote settles nothing and opens no turn", async () => {
    const r = rig(piCli);
    const send = r.session.send({ id: "a", text: "work" });
    r.proc.emitLine(piReceipt("hcn-send:a", "started"));
    let settled: unknown = "pending";
    void send.settled?.then((result) => {
      settled = result;
    });
    await tick();
    expect(settled).toBe("pending");
    expect(turnStarts(r.log)).toHaveLength(0);
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "started"));
    expect(await send.settled).toEqual({ disposition: "started" });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #426: pi interruption is two-phase and settles on native observation", () => {
  test("abort-active: aborted settlement then success response confirms, and the same process continues", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1", "long work");
    const requested = r.session.interrupt({ id: "stop-1" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const abort = lastStdin(r.proc);
    expect(abort).toMatchObject({ type: "abort" });
    expect(String(abort.id)).toMatch(/^hcn-interrupt:/);
    // The caller's id never reaches the wire; the token is internal.
    expect(String(abort.id)).not.toContain("stop-1");
    let settled: unknown = "pending";
    void requested.settled.then((receipt) => {
      settled = receipt;
    });
    r.proc.emitLine(piSettled(true));
    const events = await drainTurn(turn);
    expect(events.at(-1)).toMatchObject({ kind: "done" });
    await tick();
    // Settlement alone waits for the harness to answer the command.
    expect(settled).toBe("pending");
    r.proc.emitLine(piAbortResponse(abort.id));
    expect(await requested.settled).toEqual({ state: "interrupted" });
    // Continued use: the replacement instruction is an ordinary send.
    const second = await startPiTurn(r, "c1", "replacement");
    expect(second.inputId).toBe("c1");
    r.proc.emitLine(piAssistant("PI-GAMMA-DONE"));
    r.proc.emitLine(piSettled(false));
    expect(await drainTurn(second)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "PI-GAMMA-DONE",
    });
    expect(r.spawner.calls).toHaveLength(1);
    expect(r.sig.sent).toEqual([]);
    await r.session.close();
  });

  test("abort-race: a normal settlement before the response reports not-active", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const requested = r.session.interrupt({ id: "late" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const abort = lastStdin(r.proc);
    r.proc.emitLine(piSettled(false));
    await drainTurn(turn);
    r.proc.emitLine(piAbortResponse(abort.id));
    expect(await requested.settled).toEqual({ state: "not-active" });
    await r.session.close();
  });

  test("a response that arrives while the run is live waits for the settlement outcome", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const requested = r.session.interrupt({ id: "early" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const abort = lastStdin(r.proc);
    r.proc.emitLine(piAbortResponse(abort.id));
    let settled: unknown = "pending";
    void requested.settled.then((receipt) => {
      settled = receipt;
    });
    await tick();
    expect(settled).toBe("pending");
    r.proc.emitLine(piSettled(true));
    await drainTurn(turn);
    expect(await requested.settled).toEqual({ state: "interrupted" });
    await r.session.close();
  });

  test("an idle interrupt is written and reports not-active", async () => {
    const r = rig(piCli);
    const requested = r.session.interrupt({ id: "idle" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(piAbortResponse(lastStdin(r.proc).id));
    expect(await requested.settled).toEqual({ state: "not-active" });
    await r.session.close();
  });

  test("a native refusal rejects the receipt and the session stays usable", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const requested = r.session.interrupt({ id: "refused" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(piAbortResponse(lastStdin(r.proc).id, false));
    expect(await requested.settled).toEqual({ state: "rejected", reason: "native-rejected" });
    expect(r.proc.hasExited).toBe(false);
    r.proc.emitLine(piSettled(false));
    expect((await drainTurn(turn)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("reused interrupt ids settle independently", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const first = r.session.interrupt({ id: "same" });
    const firstWire = lastStdin(r.proc).id;
    const second = r.session.interrupt({ id: "same" });
    const secondWire = lastStdin(r.proc).id;
    if (first.state !== "requested" || second.state !== "requested") throw new Error("requested");
    expect(firstWire).not.toBe(secondWire);
    r.proc.emitLine(piSettled(true));
    await drainTurn(turn);
    r.proc.emitLine(piAbortResponse(firstWire));
    r.proc.emitLine(piAbortResponse(secondWire, false));
    expect(await first.settled).toEqual({ state: "interrupted" });
    expect(await second.settled).toEqual({ state: "rejected", reason: "native-rejected" });
    await r.session.close();
  });

  test("close while an interrupt receipt is pending resolves it closed", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const requested = r.session.interrupt({ id: "pending" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const closing = r.session.close();
    // close() drains the live turn; the harness settles it, never answers.
    r.proc.emitLine(piSettled(true));
    await drainTurn(turn);
    await closing;
    expect(await requested.settled).toEqual({ state: "rejected", reason: "closed" });
    expect(r.session.interrupt({ id: "after" })).toEqual({ state: "rejected", reason: "closed" });
  });

  test("process death resolves a pending interrupt explicitly", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const requested = r.session.interrupt({ id: "doomed" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.exit(1);
    await drainTurn(turn);
    expect(await requested.settled).toEqual({ state: "rejected", reason: "closed" });
  });

  test("abort-queued: hcn writes only the abort; the native queue is left to pi", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a1");
    const followUp = r.session.send({ id: "b1", text: "after", delivery: "queue" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "queued"));
    expect(await followUp.settled).toEqual({ disposition: "started" });
    const before = r.proc.stdinLines.length;
    const requested = r.session.interrupt({ id: "stop" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const written = r.proc.stdinLines.slice(before).map((line) => JSON.parse(line));
    expect(written).toEqual([{ id: expect.stringMatching(/^hcn-interrupt:/), type: "abort" }]);
    r.proc.emitLine(piSettled(true));
    await drainTurn(turn);
    r.proc.emitLine(piAbortResponse(written[0].id));
    expect(await requested.settled).toEqual({ state: "interrupted" });
    // The queued follow-up opened no turn of its own and nothing re-sent it.
    expect(turnStarts(r.log)).toHaveLength(1);
    expect(r.proc.stdinLines).toHaveLength(before + 1);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
  });

  test("interrupt is refused as unsupported on claude with nothing written", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "work" });
    const before = r.proc.stdinLines.length;
    expect(r.session.interrupt({ id: "stop" })).toEqual({
      state: "rejected",
      reason: "unsupported",
    });
    expect(r.proc.stdinLines).toHaveLength(before);
    expect(r.session.controls).toEqual({
      deliveryModes: ["queue", "steer"],
      interrupt: { supported: false },
    });
    r.proc.exit(0);
    await r.session.close();
  });
});

describe("issue #426: a pi turn is published on native run evidence only", () => {
  test("handled with no output publishes no turn, then a real prompt opens turn 1", async () => {
    const r = rig(piCli);
    const handled = r.session.send({ id: "h1", text: "/probehandled testtoken" });
    // The extension notification is protocol chatter, not run output.
    r.proc.emitLine(
      JSON.stringify({
        type: "extension_ui_request",
        id: "92cbdd83-4c47-4a7b-a0da-ce7b86512f83",
        method: "notify",
        message: "probehandled executed: testtoken",
        notifyType: "info",
      }),
    );
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "handled"));
    expect(await handled.settled).toEqual({ disposition: "started" });
    await tick();
    expect(turnStarts(r.log)).toEqual([]);
    expect(r.log.filter((entry) => entry.event === "turn_end")).toEqual([]);
    // The next real input is the session's first public turn.
    const real = await startPiTurn(r, "c1", "real prompt");
    expect(real.inputId).toBe("c1");
    expect(real.turnId).toBe(`${sid}:turn-1`);
    r.proc.emitLine(piAssistant("REAL-DONE"));
    r.proc.emitLine(piSettled(false));
    const events = await drainTurn(real);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "REAL-DONE" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
  });

  test("handled with nothing else lets close() finish with zero turns", async () => {
    const r = rig(piCli);
    const handled = r.session.send({ id: "h1", text: "/cmd" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "handled"));
    expect(await handled.settled).toEqual({ disposition: "started" });
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toEqual([]);
  });

  test("output streamed before the prompt receipt publishes the turn as it arrives", async () => {
    const r = rig(piCli);
    const send = r.session.send({ id: "s1", text: "stream" });
    r.proc.emitLine(piAssistant("EARLY-OUTPUT"));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("s1");
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    // Streaming is not withheld until the receipt or the settlement.
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "EARLY-OUTPUT" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "started"));
    expect(await send.settled).toEqual({ disposition: "started" });
    r.proc.emitLine(piSettled(false));
    await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
    expect(turnStarts(r.log)).toHaveLength(1);
  });

  test("handled while another send owns the turn leaves that turn running", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a");
    const command = r.session.send({ id: "h", text: "/cmd", delivery: "steer" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "handled"));
    expect(await command.settled).toEqual({ disposition: "started" });
    const events: HarnessEvent[] = [];
    const draining = (async () => {
      for await (const event of turn) events.push(event);
    })();
    await tick();
    expect(events.some((event) => event.kind === "done")).toBe(false);
    r.proc.emitLine(piSettled(false));
    await draining;
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("a queued receipt that lands after settlement opens no turn", async () => {
    const r = rig(piCli);
    const turn = await startPiTurn(r, "a");
    const queued = r.session.send({ id: "b", text: "later", delivery: "queue" });
    const queuedWire = r.proc.lastSendRequestId();
    r.proc.emitLine(piSettled(false));
    await drainTurn(turn);
    r.proc.emitLine(piReceipt(queuedWire, "queued"));
    expect(await queued.settled).toEqual({ disposition: "started" });
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
  });

  test("a receipt with no disposition keeps the legacy raced-start behavior", async () => {
    const r = rig(piCli);
    const opener = r.session.send({ id: "a", text: "work" });
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId()));
    const turn = (await r.turns.next()).value as SessionTurn;
    await opener.settled;
    const raced = r.session.send({ id: "b", text: "raced", delivery: "steer" });
    const racedWire = r.proc.lastSendRequestId();
    r.proc.emitLine(piSettled(false));
    await drainTurn(turn);
    r.proc.emitLine(piReceipt(racedWire));
    expect(await raced.settled).toEqual({ disposition: "started" });
    const next = (await r.turns.next()).value as SessionTurn;
    expect(next.inputId).toBe("b");
    r.proc.emitLine(piSettled(false));
    await drainTurn(next);
    await r.session.close();
  });
});

describe("issue #426: claude turns correlate by native uuid on every send", () => {
  test("bare + bare: a busy send merged into the current result gets no phantom turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    const busy = r.session.send({ id: "b", text: "while busy" });
    expect(busy.disposition).toBe("started");
    const uB = uuidOf(r.proc);
    expect(lastStdin(r.proc)).not.toHaveProperty("priority");
    r.proc.emitLine(claudeAssistant("BOTH-DONE"));
    r.proc.emitLine(claudeResult([uA, uB]));
    expect(await drainTurn(turnA)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "BOTH-DONE",
    });
    r.proc.exit(0);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("bare + bare unmerged: the busy send opens on the record naming its uuid", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    r.session.send({ id: "b", text: "while busy" });
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    r.proc.emitLine(claudeInit([uB]));
    const turnB = (await r.turns.next()).value as SessionTurn;
    expect(turnB.inputId).toBe("b");
    r.proc.emitLine(claudeResult([uB]));
    await drainTurn(turnB);
    r.proc.exit(0);
    await r.session.close();
  });

  test("bare + explicit steer merged into one result gets no turn of its own", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    const steer = r.session.send({ id: "b", text: "stop counting", delivery: "steer" });
    expect(steer.disposition).toBe("started");
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeAssistant("BRAVO-DONE"));
    r.proc.emitLine(claudeResult([uA, uB]));
    expect(await drainTurn(turnA)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "BRAVO-DONE",
    });
    r.proc.exit(0);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("a queued send waits for its own records; background output stays an untagged turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    expect(turnA.inputId).toBe("a");
    r.session.send({ id: "b", text: "later", delivery: "queue" });
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    // Background task notification: no input uuid. It must not settle b.
    r.proc.emitLine(claudeInit());
    r.proc.emitLine(claudeAssistant("ALPHA-DONE"));
    r.proc.emitLine(claudeResult(undefined, BACKGROUND));
    const background = (await r.turns.next()).value as SessionTurn;
    expect(background.inputId).toBeUndefined();
    expect(await drainTurn(background)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "ALPHA-DONE",
    });
    r.proc.emitLine(claudeInit([uB]));
    const turnB = (await r.turns.next()).value as SessionTurn;
    expect(turnB.inputId).toBe("b");
    r.proc.emitLine(claudeAssistant("BRAVO-DONE", [uB]));
    r.proc.emitLine(claudeResult([uB]));
    const eventsB = await drainTurn(turnB);
    expect(eventsB).toContainEqual({ kind: "message", role: "assistant", text: "BRAVO-DONE" });
    expect(eventsB).not.toContainEqual(expect.objectContaining({ text: "ALPHA-DONE" }));
    r.proc.exit(0);
    await r.session.close();
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("background output with no input waiting never leaks into the next caller turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    // Idle, nothing waiting: a background task notification turn runs.
    r.proc.emitLine(claudeInit());
    r.proc.emitLine(claudeAssistant("BACKGROUND-ONLY"));
    r.proc.emitLine(claudeResult(undefined, BACKGROUND));
    const background = (await r.turns.next()).value as SessionTurn;
    expect(background.inputId).toBeUndefined();
    expect(await drainTurn(background)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "BACKGROUND-ONLY",
    });
    r.session.send({ id: "c", text: "next" });
    const uC = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uC]));
    const turnC = (await r.turns.next()).value as SessionTurn;
    expect(turnC.inputId).toBe("c");
    r.proc.emitLine(claudeAssistant("C-DONE", [uC]));
    r.proc.emitLine(claudeResult([uC]));
    const eventsC = await drainTurn(turnC);
    expect(eventsC).toContainEqual({ kind: "message", role: "assistant", text: "C-DONE" });
    expect(eventsC).not.toContainEqual(expect.objectContaining({ text: "BACKGROUND-ONLY" }));
    r.proc.exit(0);
    await r.session.close();
  });

  test.each([false, true])(
    "a queued send cannot claim background output (send before first output: %s)",
    async (sendFirst) => {
      const r = rig(claudeCode);
      const collected = (async () => {
        const turns: { id: string | undefined; messages: string[] }[] = [];
        for await (const turn of r.session.turns) {
          const events = await drainTurn(turn);
          turns.push({
            id: turn.inputId,
            messages: events.flatMap((event) => (event.kind === "message" ? [event.text] : [])),
          });
        }
        return turns;
      })();
      r.session.send({ id: "a", text: "first" });
      const uA = uuidOf(r.proc);
      r.proc.emitLine(claudeAssistant("A-DONE", [uA]));
      r.proc.emitLine(claudeResult([uA]));
      await tick();
      let uC = "";
      const send = () => {
        r.session.send({ id: "c", text: "next", delivery: "queue" });
        uC = uuidOf(r.proc);
      };
      if (sendFirst) send();
      r.proc.emitLine(claudeInit());
      r.proc.emitLine(claudeAssistant("BACKGROUND-ONLY"));
      await tick();
      if (!sendFirst) send();
      r.proc.emitLine(claudeResult(undefined, BACKGROUND));
      r.proc.emitLine(claudeAssistant("C-DONE", [uC]));
      r.proc.emitLine(claudeResult([uC]));
      await tick();
      r.proc.exit(0);
      await r.session.close();
      expect(await collected).toEqual([
        { id: "a", messages: ["A-DONE"] },
        { id: undefined, messages: ["BACKGROUND-ONLY"] },
        { id: "c", messages: ["C-DONE"] },
      ]);
    },
  );

  test("an unmerged steer opens its turn on the record naming its uuid", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    r.session.send({ id: "b", text: "next", delivery: "steer" });
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    r.proc.emitLine(claudeAssistant("for b", [uB]));
    const turnB = (await r.turns.next()).value as SessionTurn;
    expect(turnB.inputId).toBe("b");
    r.proc.emitLine(claudeResult([uB]));
    expect(await drainTurn(turnB)).toContainEqual({
      kind: "message",
      role: "assistant",
      text: "for b",
    });
    r.proc.exit(0);
    await r.session.close();
  });

  test("reused caller ids keep their own uuids and turns", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    r.session.send({ id: "dup", text: "one", delivery: "queue" });
    const u1 = uuidOf(r.proc);
    r.session.send({ id: "dup", text: "two" });
    const u2 = uuidOf(r.proc);
    expect(u1).not.toBe(u2);
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    r.proc.emitLine(claudeInit([u1]));
    const first = (await r.turns.next()).value as SessionTurn;
    r.proc.emitLine(claudeResult([u1]));
    await drainTurn(first);
    r.proc.emitLine(claudeInit([u2]));
    const second = (await r.turns.next()).value as SessionTurn;
    r.proc.emitLine(claudeResult([u2]));
    await drainTurn(second);
    expect([first.inputId, second.inputId]).toEqual(["dup", "dup"]);
    expect(first.turnId).not.toBe(second.turnId);
    r.proc.exit(0);
    await r.session.close();
  });

  test("a busy send the process never ran is reported lost", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    r.session.send({ id: "b", text: "never ran" });
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    r.proc.exit(1);
    await r.session.close();
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toMatchObject({
      ids: ["b"],
    });
  });
});

describe("issue #426: native uuid evidence, not the write, publishes a claude input's turn", () => {
  test("nothing is published at write time; the init naming the private opener publishes it", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    const next = r.turns.next();
    expect(await settledYet(next)).toBe(false);
    expect(turnStarts(r.log)).toHaveLength(0);
    r.proc.emitLine(claudeInit([uA]));
    const turn = (await next).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    expect(turnStarts(r.log)).toHaveLength(1);
    r.proc.emitLine(claudeAssistant("A-DONE", [uA]));
    r.proc.emitLine(claudeResult([uA]));
    expect(messagesOf(await drainTurn(turn))).toEqual(["A-DONE"]);
    r.proc.exit(0);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
  });

  test("evidence naming another waiting input binds that input; the private opener keeps waiting", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.session.send({ id: "b", text: "second" });
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uB]));
    const turnB = (await r.turns.next()).value as SessionTurn;
    expect(turnB.inputId).toBe("b");
    r.proc.emitLine(claudeAssistant("B-DONE", [uB]));
    r.proc.emitLine(claudeResult([uB]));
    expect(messagesOf(await drainTurn(turnB))).toEqual(["B-DONE"]);
    const next = r.turns.next();
    expect(await settledYet(next)).toBe(false);
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await next).value as SessionTurn;
    expect(turnA.inputId).toBe("a");
    r.proc.emitLine(claudeAssistant("A-DONE", [uA]));
    r.proc.emitLine(claudeResult([uA]));
    expect(messagesOf(await drainTurn(turnA))).toEqual(["A-DONE"]);
    r.proc.exit(0);
    await r.session.close();
    expect(turnStarts(r.log)).toHaveLength(2);
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("inputs named alongside the opener are consumed once, with no phantom turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.session.send({ id: "b", text: "merged" });
    const uB = uuidOf(r.proc);
    r.proc.emitLine(claudeInit([uA, uB]));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    r.proc.emitLine(claudeAssistant("BOTH-DONE", [uA, uB]));
    r.proc.emitLine(claudeResult([uA, uB]));
    expect(messagesOf(await drainTurn(turn))).toEqual(["BOTH-DONE"]);
    r.proc.exit(0);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
    expect(turnStarts(r.log)).toHaveLength(1);
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("uncorrelated output while the opener is private streams at once in an untagged turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit());
    const next = r.turns.next();
    expect(await settledYet(next)).toBe(false);
    r.proc.emitLine(claudeAssistant("BACKGROUND-ONLY"));
    // Published on the output itself, before any result arrives.
    const background = (await next).value as SessionTurn;
    expect(background.inputId).toBeUndefined();
    const reader = background[Symbol.asyncIterator]();
    expect((await reader.next()).value).toMatchObject({ kind: "identity" });
    expect((await reader.next()).value).toEqual({
      kind: "message",
      role: "assistant",
      text: "BACKGROUND-ONLY",
    });
    r.proc.emitLine(claudeResult(undefined, BACKGROUND));
    while (!(await reader.next()).done) {
      /* drain to the background done */
    }
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    expect(turnA.inputId).toBe("a");
    r.proc.emitLine(claudeAssistant("A-DONE", [uA]));
    r.proc.emitLine(claudeResult([uA]));
    expect(messagesOf(await drainTurn(turnA))).toEqual(["A-DONE"]);
    r.proc.exit(0);
    await r.session.close();
  });

  test("an uncorrelated result with no earlier output is an untagged turn; the opener keeps waiting", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "first" });
    const uA = uuidOf(r.proc);
    r.proc.emitLine(claudeInit());
    r.proc.emitLine(claudeResult(undefined, BACKGROUND));
    const background = (await r.turns.next()).value as SessionTurn;
    expect(background.inputId).toBeUndefined();
    expect((await drainTurn(background)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    r.proc.emitLine(claudeInit([uA]));
    const turnA = (await r.turns.next()).value as SessionTurn;
    expect(turnA.inputId).toBe("a");
    r.proc.emitLine(claudeResult([uA]));
    await drainTurn(turnA);
    r.proc.exit(0);
    await r.session.close();
    expect(r.log.find((entry) => entry.event === "sends_dropped")).toBeUndefined();
  });

  test("close before any native metadata still drains the send's turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "only" });
    const uA = uuidOf(r.proc);
    const closing = r.session.close();
    await tick();
    expect(r.proc.stdinEnded).toBe(false);
    expect(turnStarts(r.log)).toHaveLength(0);
    r.proc.emitLine(claudeInit([uA]));
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    r.proc.emitLine(claudeAssistant("ONLY-DONE", [uA]));
    r.proc.emitLine(claudeResult([uA]));
    const events = await drainTurn(turn);
    expect(messagesOf(events)).toEqual(["ONLY-DONE"]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await closing;
    expect(r.proc.stdinEnded).toBe(true);
    expect((await r.turns.next()).done).toBe(true);
  });

  test("a process that dies before any native metadata owes the send its failed turn", async () => {
    const r = rig(claudeCode);
    r.session.send({ id: "a", text: "doomed" });
    const closing = r.session.close();
    const next = r.turns.next();
    await tick();
    r.proc.exit(3);
    const turn = (await next).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    expect((await drainTurn(turn)).at(-1)).toMatchObject({
      kind: "done",
      exitCode: 3,
      cause: "crash",
    });
    await closing;
    expect((await r.turns.next()).done).toBe(true);
  });

  test("a send that goes silent before any native metadata ends stall, tagged with the send", async () => {
    const r = rig(claudeCode, {}, 1_000);
    r.session.send({ id: "a", text: "silent" });
    const next = r.turns.next();
    await tick();
    r.clock.advance(1_000);
    const turn = (await next).value as SessionTurn;
    expect(turn.inputId).toBe("a");
    const done = (await drainTurn(turn)).at(-1);
    expect(done).toMatchObject({ kind: "done", cause: "stall", failure: { class: "transport" } });
    expect(r.sig.sent.map((entry) => entry.sig)).toContain("SIGTERM");
    await r.session.close();
  });
});

// pi 1.4.0 threshold compaction records (the shapes in
// pi-compaction-outside-turn.test.ts): pi can compact outside the run markers.
const piCompactionStart = JSON.stringify({ type: "compaction_start", reason: "threshold" });
const piCompactionEnd = JSON.stringify({
  type: "compaction_end",
  reason: "threshold",
  result: { tokensBefore: 58656, estimatedTokensAfter: 39452 },
  aborted: false,
});

describe("issue #426: a pi opener consumed with no run settles its interrupt and publishes nothing", () => {
  test("an abort accepted before a handled receipt settles not-active, with no turn", async () => {
    const r = rig(piCli);
    const handled = r.session.send({ id: "h1", text: "/cmd" });
    const requested = r.session.interrupt({ id: "stop" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(piAbortResponse(lastStdin(r.proc).id));
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[0] ?? "", "handled"));
    expect(await handled.settled).toEqual({ disposition: "started" });
    // No agent_settled follows a handled input: the receipt cannot wait for one.
    expect(await settledYet(requested.settled)).toBe(true);
    expect(await requested.settled).toEqual({ state: "not-active" });
    expect(turnStarts(r.log)).toEqual([]);
    // The session stays usable; the replacement is the first public turn.
    const real = await startPiTurn(r, "c1", "replacement");
    expect(real.turnId).toBe(`${sid}:turn-1`);
    r.proc.emitLine(piSettled(false));
    expect((await drainTurn(real)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
    expect(turnStarts(r.log)).toHaveLength(1);
  });

  test("a handled receipt before the abort response settles not-active from that response", async () => {
    const r = rig(piCli);
    const handled = r.session.send({ id: "h1", text: "/cmd" });
    const requested = r.session.interrupt({ id: "stop" });
    if (requested.state !== "requested") throw new Error("expected requested");
    const abortId = lastStdin(r.proc).id;
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[0] ?? "", "handled"));
    expect(await handled.settled).toEqual({ disposition: "started" });
    r.proc.emitLine(piAbortResponse(abortId));
    expect(await requested.settled).toEqual({ state: "not-active" });
    expect(turnStarts(r.log)).toEqual([]);
    await r.session.close();
    expect((await r.turns.next()).done).toBe(true);
  });

  test("an abort accepted before a refused opener settles not-active; the failed turn stays", async () => {
    const r = rig(piCli);
    const sent = r.session.send({ id: "a1", text: "work" });
    const requested = r.session.interrupt({ id: "stop" });
    if (requested.state !== "requested") throw new Error("expected requested");
    r.proc.emitLine(piAbortResponse(lastStdin(r.proc).id));
    r.proc.emitLine(piRefusal(r.proc.sendRequestIds[0] ?? "", "model unavailable"));
    expect(await sent.settled).toEqual({ disposition: "rejected", reason: "native-rejected" });
    const turn = (await r.turns.next()).value as SessionTurn;
    expect(turn.inputId).toBe("a1");
    const events = await drainTurn(turn);
    expect(events.filter((event) => event.kind === "failure")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });
    expect(await settledYet(requested.settled)).toBe(true);
    expect(await requested.settled).toEqual({ state: "not-active" });
    // Still usable.
    const next = await startPiTurn(r, "b1", "again");
    r.proc.emitLine(piSettled(false));
    expect((await drainTurn(next)).at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await r.session.close();
  });

  test("compaction between a send and its handled receipt publishes nothing; the next turn carries it", async () => {
    const r = rig(piCli);
    const handled = r.session.send({ id: "h1", text: "/cmd" });
    r.proc.emitLine(piCompactionStart);
    r.proc.emitLine(piCompactionEnd);
    r.proc.emitLine(piReceipt(r.proc.lastSendRequestId(), "handled"));
    expect(await handled.settled).toEqual({ disposition: "started" });
    await tick();
    expect(turnStarts(r.log)).toEqual([]);
    expect(r.log.filter((entry) => entry.event === "turn_end")).toEqual([]);
    const real = await startPiTurn(r, "c1", "real prompt");
    expect(real.inputId).toBe("c1");
    expect(real.turnId).toBe(`${sid}:turn-1`);
    r.proc.emitLine(piAssistant("REAL-DONE"));
    r.proc.emitLine(piSettled(false));
    const events = await drainTurn(real);
    expect(events.filter((event) => event.kind === "compaction")).toEqual([
      { kind: "compaction", state: "started", trigger: "auto" },
      {
        kind: "compaction",
        state: "compacted",
        trigger: "auto",
        tokensBefore: 58656,
        tokensAfter: 39452,
      },
    ]);
    expect(events).toContainEqual({ kind: "message", role: "assistant", text: "REAL-DONE" });
    await r.session.close();
    expect(turnStarts(r.log)).toHaveLength(1);
  });
});
