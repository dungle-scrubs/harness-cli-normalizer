/**
 * Issue #456: the `settings` op and `verbatim` sends on the `--json`
 * machine surface, driven through runJsonSession over a real openSession
 * on a fake native process.
 */
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runJsonSession } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (questions: "ask" | "none" = "ask", descriptor: HarnessDescriptor = claudeCode) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const closeInfo: { exitCode: number | null; cause: string } = { exitCode: null, cause: "clean" };
  const handle = openSession(
    descriptor,
    { sessionId: sid, questions },
    {
      spawn: spawner.spawn,
      clock: new FakeClock(),
      signal: fakeSignal().signal,
      log: (entry) => {
        if (entry.event === "session_close") {
          closeInfo.exitCode = (entry.exitCode as number | null) ?? null;
          closeInfo.cause = (entry.cause as string) ?? "clean";
        }
      },
    },
  );
  const input = new PassThrough();
  const out: string[] = [];
  const done = runJsonSession({
    handle,
    sessionId: sid,
    harness: "claude",
    hcnVersion: "9.9.9",
    questions,
    origin: "fresh",
    getCloseInfo: () => closeInfo,
    input,
    write: (line) => {
      out.push(line);
      return true;
    },
    onDrain: (fn) => fn(),
  });
  const events = () =>
    out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const raw = (line: string): void => {
    input.write(`${line}\n`);
  };
  return { proc, input, done, raw, events };
};

const claudeSetModelAnswer = (requestId: string, model: string): string =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { model } },
  });

describe("issue #456: the settings op over the wire", () => {
  test("an applied op emits exactly one settings event; the stream stays open for later commands", async () => {
    const r = rig();
    await tick();
    r.raw('{"op":"settings","id":"set-1","model":"haiku"}');
    await tick();
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-haiku-5-5"));
    await tick();
    r.input.end();
    const code = await r.done;
    expect(code).toBe(0);
    expect(r.events().filter((e) => e.kind === "settings")).toEqual([
      { kind: "settings", id: "set-1", state: "applied", model: "claude-haiku-5-5" },
    ]);
  });

  test("an invalid op rejects without a native write; a malformed one is an error event", async () => {
    const r = rig();
    await tick();
    r.raw('{"op":"settings","id":"set-1","model":"nope"}');
    r.raw('{"op":"settings","id":"set-2"}');
    r.raw('{"op":"settings","id":"set-3","effort":7}');
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs.filter((e) => e.kind === "settings")).toEqual([
      { kind: "settings", id: "set-1", state: "rejected", reason: "invalid-model" },
    ]);
    const errors = evs.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toContain("model, effort, or both");
    expect(errors[1]?.message).toContain("effort must be a non-empty string");
    // No settings command ever reached the harness.
    expect(r.proc.stdinLines.some((line) => line.includes("hcn-settings"))).toBe(false);
  });

  test("receipts arrive in op order: a queued op invalidated by the applied model settles after the op that invalidated it (review round 3, H4)", async () => {
    // The real claude vocabulary has one effort ladder; a synthetic
    // per-model one makes the invalidation observable, the way the
    // sequencer-level G8 test does. Through the real CLI: set-1 takes
    // the wire, set-2 queues, and set-1's settlement drains set-2 into
    // an invalid-at-dispatch rejection - which must still be the SECOND
    // settings event on stdout.
    const laddered: HarnessDescriptor = {
      ...claudeCode,
      vocabulary: {
        ...claudeCode.vocabulary,
        effortsByModel: { "claude-haiku-5-5": ["low"], "claude-sonnet-5-5": ["high"] },
      },
    };
    const r = rig("ask", laddered);
    await tick();
    r.raw('{"op":"settings","id":"set-1","model":"sonnet"}');
    r.raw('{"op":"settings","id":"set-2","effort":"low"}');
    await tick();
    expect(r.proc.stdinLines.some((line) => line.includes("effortLevel"))).toBe(false);
    r.proc.emitLine(claudeSetModelAnswer("hcn-settings:1", "claude-sonnet-5-5"));
    await tick();
    r.input.end();
    await r.done;
    expect(r.events().filter((e) => e.kind === "settings")).toEqual([
      { kind: "settings", id: "set-1", state: "applied", model: "claude-sonnet-5-5" },
      { kind: "settings", id: "set-2", state: "rejected", reason: "invalid-effort" },
    ]);
  });
});

describe("issue #456 (review round 3, H2): an idle readback failure reaches the host", () => {
  test("a settings op whose state readback fails, closed with no further send, still delivers receipt and error", async () => {
    const r = rig("ask", piCli);
    await tick();
    // An idle op (no turn open): catalog read, model write, then a
    // failed get_state - the writes applied, the readback confirmed
    // nothing. The host closes without sending anything else, so a
    // diagnostic parked for the next turn would vanish with the session.
    r.raw('{"op":"settings","id":"set-1","model":"glm-5.2"}');
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:c",
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ id: "glm-5.2", provider: "zai" }] },
      }),
    );
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1",
        type: "response",
        command: "set_model",
        success: true,
        data: { id: "glm-5.2" },
      }),
    );
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:s",
        type: "response",
        command: "get_state",
        success: false,
        error: "busy",
      }),
    );
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    // The receipt confirms nothing it could not read back, and the
    // diagnostic error leaves on the control output immediately after
    // it - both before the session closes.
    expect(evs.filter((e) => e.kind === "settings")).toEqual([
      { kind: "settings", id: "set-1", state: "applied", unconfirmed: ["model"] },
    ]);
    const errors = evs.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("state readback failed");
    expect(errors[0]?.message).toContain("model");
    // The diagnostic follows its receipt, and both precede the close.
    const receiptAt = evs.findIndex((e) => e.kind === "settings");
    const errorAt = evs.findIndex((e) => e.kind === "error");
    const closedAt = evs.findIndex((e) => e.kind === "closed");
    expect(receiptAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBe(receiptAt + 1);
    expect(closedAt).toBeGreaterThan(errorAt);
  });

  test("the readback diagnostic directly follows its own receipt even when a later op settles inside that receipt's drain (review round 4, J3)", async () => {
    // set-1 takes the wire; set-2 queues behind it (its bogus effort
    // only validates at dispatch, inside set-1's settlement drain).
    // set-1's failed readback settles it applied-with-unconfirmed; the
    // drain then rejects set-2 in the same synchronous step - and
    // set-2's receipt must not slip between set-1's receipt and its
    // diagnostic.
    const r = rig("ask", piCli);
    await tick();
    r.raw('{"op":"settings","id":"set-1","model":"glm-5.2","effort":"high"}');
    r.raw('{"op":"settings","id":"set-2","effort":"bogus"}');
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:c",
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ id: "glm-5.2", provider: "zai" }] },
      }),
    );
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1",
        type: "response",
        command: "set_model",
        success: true,
        data: { id: "glm-5.2" },
      }),
    );
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:e",
        type: "response",
        command: "set_thinking_level",
        success: true,
      }),
    );
    await tick();
    r.proc.emitLine(
      JSON.stringify({
        id: "hcn-settings:1:s",
        type: "response",
        command: "get_state",
        success: false,
        error: "busy",
      }),
    );
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    const receiptAt = evs.findIndex((e) => e.kind === "settings" && e.id === "set-1");
    expect(receiptAt).toBeGreaterThanOrEqual(0);
    // The diagnostic names BOTH unconfirmed fields, in full - a join
    // mutant dies here (review round 4, J5).
    expect(evs[receiptAt + 1]).toEqual({
      kind: "error",
      message: 'settings op "set-1": state readback failed; unconfirmed: model, effort',
    });
    // The later op's receipt follows the diagnostic, never between it
    // and its own receipt.
    expect(evs[receiptAt + 2]).toEqual({
      kind: "settings",
      id: "set-2",
      state: "rejected",
      reason: "invalid-effort",
    });
  });
});

describe("issue #456: verbatim over the wire", () => {
  test("send accepts verbatim; answer refuses it in every spelling; a non-boolean verbatim is malformed", async () => {
    const r = rig("ask");
    await tick();
    r.raw('{"op":"send","id":"a","text":"/model haiku","verbatim":true}');
    r.raw('{"op":"send","id":"b","text":"/compact","verbatim":"yes"}');
    r.raw('{"op":"answer","id":"c","text":"prod","verbatim":true}');
    // answer carries no verbatim at all: false is as malformed as true
    // (review round 1, F7).
    r.raw('{"op":"answer","id":"d","text":"prod","verbatim":false}');
    await tick();
    // Close the turn the send opened, then the stream.
    const uuid = (JSON.parse(r.proc.stdinLines[0] ?? "{}") as { uuid?: string }).uuid;
    r.proc.emitLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sid,
        user_message_uuids: [uuid],
      }),
    );
    r.proc.emitLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: sid,
        is_error: false,
        user_message_uuid: uuid,
        user_message_uuids: [uuid],
      }),
    );
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    const userFrames = r.proc.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect((userFrames[0]?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe(
      "/model haiku",
    );
    // Exactly the three malformed lines error - one per bad verbatim - and
    // each names its diagnostic, so a mutant that drops or rewrites the
    // message dies here (review round 1, F11).
    const errors = evs.filter((e) => e.kind === "error");
    expect(errors).toEqual([
      { kind: "error", message: "malformed command: verbatim must be a boolean" },
      {
        kind: "error",
        message: "malformed command: answer carries no verbatim; compose the reply yourself",
      },
      {
        kind: "error",
        message: "malformed command: answer carries no verbatim; compose the reply yourself",
      },
    ]);
    // The ordinary send answered normally: one exact started disposition.
    expect(evs.filter((e) => e.kind === "disposition" && e.id === "a")).toEqual([
      { kind: "disposition", id: "a", disposition: "started" },
    ]);
    // The refused answers produced no disposition and no write.
    expect(evs.filter((e) => e.kind === "disposition" && e.id !== "a")).toEqual([]);
    expect(userFrames).toHaveLength(1);
  });
});
