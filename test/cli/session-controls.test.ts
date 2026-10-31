/**
 * Issue #426: the `hcn session --json` control protocol - optional
 * `delivery` on send/answer, the standalone `interrupt` op, two-phase
 * interruption receipts and the controls on the session packet - driven
 * through runJsonSession over a real openSession on a fake native process.
 */
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runJsonSession } from "../../src/cli/session-json.js";
import { openSession } from "../../src/execution/open-session.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "../execution/fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const rig = (descriptor: HarnessDescriptor) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const closeInfo: { exitCode: number | null; cause: string } = { exitCode: null, cause: "clean" };
  const handle = openSession(
    descriptor,
    { sessionId: sid, questions: "none" },
    {
      spawn: spawner.spawn,
      clock: new FakeClock(),
      signal: sig.signal,
      log: (entry: Record<string, unknown>) => {
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
    harness: descriptor.name,
    hcnVersion: "9.9.9",
    questions: "none",
    origin: "fresh",
    getCloseInfo: () => closeInfo,
    input,
    write: (line) => {
      out.push(line);
      return true;
    },
    onDrain: (fn) => fn(),
  });
  const send = (obj: unknown) => input.write(`${JSON.stringify(obj)}\n`);
  const raw = (line: string) => input.write(`${line}\n`);
  const events = () =>
    out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const stdin = () => proc.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { proc, sig, input, done, send, raw, events, stdin };
};

/** A pi prompt receipt answering the request id the runner actually wrote. */
const piReceipt = (wireId: string | undefined, disposition: "started" | "queued" | "handled") =>
  JSON.stringify({
    id: wireId,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition },
  });
const piSettled = (aborted: boolean) => JSON.stringify({ type: "agent_settled", aborted });

describe("issue #426: the session packet advertises the harness's controls", () => {
  test.each([
    {
      descriptor: claudeCode,
      controls: { deliveryModes: ["queue", "steer"], interrupt: { supported: false } },
    },
    {
      descriptor: piCli,
      controls: {
        deliveryModes: ["queue", "steer"],
        interrupt: { supported: true, toolCancellation: "best-effort" },
      },
    },
    {
      descriptor: codexCli,
      controls: { deliveryModes: ["steer"], interrupt: { supported: false } },
    },
    {
      descriptor: antigravityCli,
      controls: { deliveryModes: [], interrupt: { supported: false } },
    },
    {
      descriptor: popeyeCli,
      controls: { deliveryModes: [], interrupt: { supported: false } },
    },
  ])("$descriptor.name", async ({ descriptor, controls }) => {
    const r = rig(descriptor);
    await tick();
    r.input.end();
    await r.done;
    expect(r.events()[0]).toMatchObject({ kind: "session", controls });
  });
});

describe("issue #426: malformed control commands", () => {
  test.each([
    [{ op: "send", id: "a", text: "t", delivery: "later" }, "delivery must be one of queue, steer"],
    [{ op: "send", id: "a", text: "t", delivery: null }, "delivery must be one of queue, steer"],
    [{ op: "answer", id: "a", text: "t", delivery: 1 }, "delivery must be one of queue, steer"],
    [{ op: "interrupt" }, "missing or empty id"],
    [{ op: "interrupt", id: "" }, "missing or empty id"],
    [{ op: "interrupt", id: 7 }, "missing or empty id"],
    [
      { op: "interrupt", id: "i", text: "replacement" },
      "interrupt carries no text; send it after the receipt",
    ],
  ])("%j is an error, never a disposition or a native write", async (command, message) => {
    const r = rig(piCli);
    await tick();
    const before = r.proc.stdinLines.length;
    r.send(command);
    await tick();
    expect(r.proc.stdinLines).toHaveLength(before);
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs).toContainEqual({ kind: "error", message: `malformed command: ${message}` });
    expect(evs.filter((e) => e.kind === "disposition" || e.kind === "interruption")).toEqual([]);
    expect(evs.at(-1)).toMatchObject({ kind: "closed", cause: "clean" });
  });
});

describe("issue #426: unsupported controls are refused explicitly and the session lives", () => {
  test("an unsupported delivery mode gets exactly one rejected disposition", async () => {
    const r = rig(antigravityCli);
    await tick();
    r.send({ op: "send", id: "q", text: "queued", delivery: "queue" });
    await tick();
    expect(r.proc.stdinLines).toHaveLength(0);
    // The process is untouched and the next ordinary send is written.
    r.send({ op: "send", id: "ok", text: "ordinary" });
    await tick();
    expect(r.stdin()).toEqual([{ event: "user", message: { content: expect.any(String) } }]);
    r.proc.emitLine(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));
    await tick();
    r.input.end();
    const code = await r.done;
    const dispositions = r.events().filter((e) => e.kind === "disposition");
    expect(dispositions).toEqual([
      { kind: "disposition", id: "q", disposition: "rejected", reason: "unsupported-delivery" },
      { kind: "disposition", id: "ok", disposition: "started" },
    ]);
    expect(r.sig.sent).toEqual([]);
    expect(code).toBe(0);
  });

  test("interrupt on a harness without one is a single rejected receipt", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "interrupt", id: "stop" });
    await tick();
    expect(r.proc.stdinLines).toHaveLength(0);
    r.input.end();
    await r.done;
    expect(r.events().filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop", state: "rejected", reason: "unsupported" },
    ]);
  });
});

describe("issue #426: pi interruption over the wire", () => {
  test("requested then interrupted, read while the send receipt is still outstanding, then the session continues", async () => {
    const r = rig(piCli);
    await tick();
    r.send({ op: "send", id: "a1", text: "long work", delivery: "steer" });
    await tick();
    // The prompt receipt has not arrived; the pump still reads the interrupt.
    r.send({ op: "interrupt", id: "stop-1" });
    await tick();
    const abort = r.stdin().at(-1) as Record<string, unknown>;
    expect(abort).toMatchObject({ type: "abort" });
    expect(r.events().filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop-1", state: "requested" },
    ]);
    expect(r.events().some((e) => e.kind === "disposition")).toBe(false);
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[0], "started"));
    r.proc.emitLine(piSettled(true));
    r.proc.emitLine(
      JSON.stringify({ id: abort.id, type: "response", command: "abort", success: true }),
    );
    await tick();
    expect(r.events().filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop-1", state: "requested" },
      { kind: "interruption", id: "stop-1", state: "interrupted" },
    ]);
    // The caller sends the replacement after the confirmation.
    r.send({ op: "send", id: "c1", text: "replacement" });
    await tick();
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[1], "started"));
    r.proc.emitLine(piSettled(false));
    await tick();
    r.input.end();
    const code = await r.done;
    const evs = r.events();
    expect(evs.filter((e) => e.kind === "turn").map((e) => e.id)).toEqual(["a1", "c1"]);
    expect(evs.filter((e) => e.kind === "disposition")).toEqual([
      { kind: "disposition", id: "a1", disposition: "started" },
      { kind: "disposition", id: "c1", disposition: "started" },
    ]);
    expect(evs.at(-1)).toMatchObject({ kind: "closed", cause: "clean", exitCode: 0 });
    expect(code).toBe(0);
  });

  test("an interrupt racing a normal settlement reports not-active", async () => {
    const r = rig(piCli);
    await tick();
    r.send({ op: "send", id: "a1", text: "short" });
    await tick();
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[0], "started"));
    r.send({ op: "interrupt", id: "late" });
    await tick();
    const abort = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(piSettled(false));
    r.proc.emitLine(
      JSON.stringify({ id: abort.id, type: "response", command: "abort", success: true }),
    );
    await tick();
    r.input.end();
    await r.done;
    expect(r.events().filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "late", state: "requested" },
      { kind: "interruption", id: "late", state: "not-active" },
    ]);
  });

  test("close with a send and an interrupt receipt pending answers both before closed", async () => {
    const r = rig(piCli);
    await tick();
    r.send({ op: "send", id: "p", text: "work" });
    await tick();
    r.send({ op: "interrupt", id: "i" });
    r.send({ op: "close" });
    await tick();
    // close() drains the live turn; the harness settles it, answers nothing.
    r.proc.emitLine(piSettled(true));
    const code = await r.done;
    const evs = r.events();
    const closedAt = evs.findIndex((e) => e.kind === "closed");
    expect(closedAt).toBe(evs.length - 1);
    expect(evs.filter((e) => e.kind === "disposition")).toEqual([
      { kind: "disposition", id: "p", disposition: "rejected", reason: "closed" },
    ]);
    expect(evs.filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "i", state: "requested" },
      { kind: "interruption", id: "i", state: "rejected", reason: "closed" },
    ]);
    expect(code).toBe(0);
  });
});

describe("issue #429: claude interruption over the wire", () => {
  const init = (uuid: unknown, capabilities?: unknown) =>
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sid,
      user_message_uuids: [uuid],
      ...(capabilities === undefined ? {} : { capabilities }),
    });
  const result = (uuid: unknown, extra: Record<string, unknown>) =>
    JSON.stringify({ type: "result", session_id: sid, user_message_uuids: [uuid], ...extra });
  const supported = { supported: true, toolCancellation: "best-effort" };

  test("the identity reports advertised support; requested then interrupted; the session continues", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "send", id: "a1", text: "long work" });
    await tick();
    const first = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(init(first.uuid, ["interrupt_receipt_v1"]));
    await tick();
    r.send({ op: "interrupt", id: "stop-1" });
    await tick();
    const request = r.stdin().at(-1) as Record<string, unknown>;
    expect(request).toEqual({
      type: "control_request",
      request_id: expect.stringMatching(/^hcn-interrupt:/),
      request: { subtype: "interrupt" },
    });
    r.proc.emitLine(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request.request_id,
          response: { still_queued: [] },
        },
      }),
    );
    await tick();
    expect(r.events().filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop-1", state: "requested" },
    ]);
    r.proc.emitLine(
      result(first.uuid, {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      }),
    );
    await tick();
    r.send({ op: "send", id: "c1", text: "replacement" });
    await tick();
    const second = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(init(second.uuid, ["interrupt_receipt_v1"]));
    r.proc.emitLine(result(second.uuid, { subtype: "success", terminal_reason: "completed" }));
    await tick();
    r.input.end();
    const code = await r.done;
    const evs = r.events();
    expect(evs[0]).toMatchObject({
      kind: "session",
      controls: { interrupt: { supported: false } },
    });
    expect(evs.filter((e) => e.kind === "identity")).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({
          sessionControls: { deliveryModes: ["queue", "steer"], interrupt: supported },
        }),
      }),
    ]);
    const kinds = evs.filter((e) => e.kind === "interruption" || e.kind === "done");
    expect(kinds.filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop-1", state: "requested" },
      { kind: "interruption", id: "stop-1", state: "interrupted" },
    ]);
    expect(kinds.filter((e) => e.kind === "done").map((e) => e.cause)).toEqual(["clean", "clean"]);
    expect(evs.filter((e) => e.kind === "failure")).toEqual([]);
    expect(evs.filter((e) => e.kind === "turn").map((e) => e.id)).toEqual(["a1", "c1"]);
    expect(evs.at(-1)).toMatchObject({ kind: "closed", cause: "clean", exitCode: 0 });
    expect(r.sig.sent).toEqual([]);
    expect(code).toBe(0);
  });

  test("a late acknowledgement reports the turn it was written for, not the turn running when it lands", async () => {
    const r = rig(claudeCode);
    const success = (requestId: unknown) =>
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { still_queued: [] } },
      });
    await tick();
    r.send({ op: "send", id: "A", text: "work" });
    await tick();
    const a = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(init(a.uuid, ["interrupt_receipt_v1"]));
    await tick();
    r.send({ op: "interrupt", id: "I1" });
    await tick();
    const i1 = r.stdin().at(-1) as Record<string, unknown>;
    // A completes naturally before I1's acknowledgement.
    r.proc.emitLine(result(a.uuid, { subtype: "success", terminal_reason: "completed" }));
    await tick();
    r.send({ op: "send", id: "B", text: "next" });
    await tick();
    const b = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(init(b.uuid, ["interrupt_receipt_v1"]));
    r.proc.emitLine(success(i1.request_id));
    await tick();
    r.send({ op: "interrupt", id: "I2" });
    await tick();
    const i2 = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(success(i2.request_id));
    r.proc.emitLine(
      result(b.uuid, {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      }),
    );
    await tick();
    r.input.end();
    expect(await r.done).toBe(0);
    const receipts = r.events().filter((e) => e.kind === "interruption" && e.state !== "requested");
    expect(receipts).toEqual(
      expect.arrayContaining([
        { kind: "interruption", id: "I1", state: "not-active" },
        { kind: "interruption", id: "I2", state: "interrupted" },
      ]),
    );
    expect(receipts).toHaveLength(2);
    expect(r.sig.sent).toEqual([]);
  });

  test("a process that does not advertise receipts refuses interrupt with nothing written", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "send", id: "a1", text: "work" });
    await tick();
    const first = r.stdin().at(-1) as Record<string, unknown>;
    r.proc.emitLine(init(first.uuid));
    await tick();
    const before = r.proc.stdinLines.length;
    r.send({ op: "interrupt", id: "stop" });
    await tick();
    expect(r.proc.stdinLines).toHaveLength(before);
    r.proc.emitLine(result(first.uuid, { subtype: "success" }));
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs.filter((e) => e.kind === "interruption")).toEqual([
      { kind: "interruption", id: "stop", state: "rejected", reason: "unsupported" },
    ]);
    expect(evs.filter((e) => e.kind === "identity")).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({
          sessionControls: { deliveryModes: ["queue", "steer"], interrupt: { supported: false } },
        }),
      }),
    ]);
  });
});

describe("issue #426: dispositions stay one per command, in command order", () => {
  test("a reused caller id gets distinct native ids; the second answer arriving first keeps command order and outcomes", async () => {
    const r = rig(piCli);
    await tick();
    r.send({ op: "send", id: "a", text: "first" });
    r.send({ op: "send", id: "dup", text: "steer one", delivery: "steer" });
    r.send({ op: "send", id: "dup", text: "steer two", delivery: "queue" });
    r.send({ op: "send", id: "z", text: "steer three" });
    await tick();
    // All four were written before any receipt: the pump never blocked.
    expect(r.stdin().filter((line) => line.type === "prompt")).toHaveLength(4);
    const [aWire, dupOne, dupTwo, zWire] = r.proc.sendRequestIds;
    expect(new Set([aWire, dupOne, dupTwo, zWire]).size).toBe(4);
    // The SECOND dup is answered first, with a different outcome.
    r.proc.emitLine(
      JSON.stringify({
        id: dupTwo,
        type: "response",
        command: "prompt",
        success: false,
        error: "queue full",
      }),
    );
    r.proc.emitLine(piReceipt(zWire, "queued"));
    await tick();
    expect(r.events().some((e) => e.kind === "disposition")).toBe(false);
    r.proc.emitLine(piReceipt(aWire, "started"));
    r.proc.emitLine(piReceipt(dupOne, "queued"));
    r.proc.emitLine(piSettled(false));
    await tick();
    r.input.end();
    await r.done;
    expect(r.events().filter((e) => e.kind === "disposition")).toEqual([
      { kind: "disposition", id: "a", disposition: "started" },
      { kind: "disposition", id: "dup", disposition: "started" },
      { kind: "disposition", id: "dup", disposition: "rejected", reason: "native-rejected" },
      { kind: "disposition", id: "z", disposition: "started" },
    ]);
    // Queued inputs joined the one run; no phantom turn followed.
    expect(r.events().filter((e) => e.kind === "turn")).toHaveLength(1);
  });

  test("a handled command answers started with zero turn or done events, then a real input works", async () => {
    const r = rig(piCli);
    await tick();
    r.send({ op: "send", id: "h1", text: "/probehandled testtoken", delivery: "queue" });
    await tick();
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[0], "handled"));
    await tick();
    expect(r.events().filter((e) => e.kind === "turn" || e.kind === "done")).toEqual([]);
    r.send({ op: "send", id: "c1", text: "real prompt" });
    await tick();
    r.proc.emitLine(piReceipt(r.proc.sendRequestIds[1], "started"));
    r.proc.emitLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "REAL" }],
          stopReason: "stop",
        },
      }),
    );
    r.proc.emitLine(piSettled(false));
    await tick();
    r.input.end();
    const code = await r.done;
    const evs = r.events();
    expect(evs.filter((e) => e.kind === "disposition")).toEqual([
      { kind: "disposition", id: "h1", disposition: "started" },
      { kind: "disposition", id: "c1", disposition: "started" },
    ]);
    expect(evs.filter((e) => e.kind === "turn")).toEqual([
      { kind: "turn", turnId: `${sid}:turn-1`, id: "c1" },
    ]);
    expect(evs.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(evs).toContainEqual(expect.objectContaining({ kind: "message", text: "REAL" }));
    expect(evs.at(-1)).toMatchObject({ kind: "closed", cause: "clean" });
    expect(code).toBe(0);
  });

  test("claude: a reused caller id keeps one disposition per command and its own turn", async () => {
    const r = rig(claudeCode);
    await tick();
    r.send({ op: "send", id: "dup", text: "one" });
    await tick();
    const first = r.stdin().at(-1) as Record<string, unknown>;
    r.send({ op: "send", id: "dup", text: "two" });
    await tick();
    const second = r.stdin().at(-1) as Record<string, unknown>;
    expect(first.uuid).not.toBe(second.uuid);
    r.proc.emitLine(JSON.stringify({ type: "result", user_message_uuids: [first.uuid] }));
    r.proc.emitLine(
      JSON.stringify({ type: "system", subtype: "init", user_message_uuids: [second.uuid] }),
    );
    r.proc.emitLine(JSON.stringify({ type: "result", user_message_uuids: [second.uuid] }));
    await tick();
    r.input.end();
    await r.done;
    const evs = r.events();
    expect(evs.filter((e) => e.kind === "disposition").map((e) => e.id)).toEqual(["dup", "dup"]);
    expect(evs.filter((e) => e.kind === "turn").map((e) => e.id)).toEqual(["dup", "dup"]);
    expect(evs.filter((e) => e.kind === "done")).toHaveLength(2);
  });
});
