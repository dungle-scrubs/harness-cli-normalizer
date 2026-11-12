/**
 * An output line over hcn's line bound is discarded, and the discard is
 * never silent: LineBuffer reports it once with its size and the line's
 * own start, and the run and session pumps judge that report where it
 * happened. An overflow that repeated records hcn had already read (pi's
 * `turn_end` and `agent_end`) warns and never fails; any other overflow
 * is held until the turn's end, where a turn that recovered from it warns
 * and a turn that did not fails on it. Invented data only; fake processes,
 * never a real harness.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { LineBuffer, type LineOverflow, RUN_LINE_MAX } from "../../src/execution/lines.js";
import { openSession } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { claudeInitNaming, FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const result = JSON.stringify({ type: "result", subtype: "success" });
const failedResult = JSON.stringify({ type: "result", subtype: "error", is_error: true });
const OVER = RUN_LINE_MAX + 1;

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const overflowMessage = (stream: string, bytes: string) =>
  `Transport failure (output line overflow: ${stream} line of ${bytes} bytes exceeds the 16,777,216-character line limit and was discarded) - retry or route to another provider`;

const overflowWarning = (stream: string, bytes: string, reason: string) =>
  `output line overflow: ${stream} line of ${bytes} bytes exceeds the 16,777,216-character line limit and was discarded; ${reason}`;

/** The same digit grouping the failure text uses, without an ICU
 * dependency. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

describe("LineBuffer overflow report", () => {
  test("reports one over-long line at its newline with its characters and UTF-8 bytes", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(8, (o) => reports.push(o));
    // 6 ASCII + 2 two-byte + 1 three-byte + 1 four-byte (a surrogate pair)
    // = 11 characters, 6 + 4 + 3 + 4 = 17 bytes, torn across three chunks.
    expect(lines.push("abcdef")).toEqual([]);
    expect(lines.push("éé")).toEqual([]);
    expect(reports).toEqual([]);
    expect(lines.push("€\u{1f600}\nnext\n")).toEqual(["next"]);
    expect(reports).toEqual([{ characters: 11, bytes: 17, limit: 8, head: "abcdeféé€\u{1f600}" }]);
  });

  test("reports an unterminated over-long final line at flush, and a lone surrogate as 3 bytes", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(2, (o) => reports.push(o));
    expect(lines.push("ok\n\ud800xyz")).toEqual(["ok"]);
    expect(lines.flush()).toBeNull();
    expect(reports).toEqual([{ characters: 4, bytes: 6, limit: 2, head: "\ud800xyz" }]);
  });

  test("keeps counting UTF-8 bytes of text that arrives after the line overflowed", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(2, (o) => reports.push(o));
    expect(lines.push("abc")).toEqual([]);
    expect(lines.push("é€")).toEqual([]);
    expect(lines.push("\u{1f600}\n")).toEqual([]);
    // 3 + 2 + 2 characters; 3 + (2 + 3) + 4 bytes.
    expect(reports).toEqual([{ characters: 7, bytes: 12, limit: 2, head: "abc" }]);
  });

  test("the head carries the line's own start, bounded at 256 characters", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(10, (o) => reports.push(o));
    const start = "z".repeat(300);
    expect(lines.push(`${start}\n`)).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.head).toHaveLength(256);
    expect(reports[0]?.head).toBe(start.slice(0, 256));
  });

  test("the head of a line that overflowed in one chunk is the line's start", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(4, (o) => reports.push(o));
    expect(lines.push("abcdefghij\n")).toEqual([]);
    expect(reports[0]?.head).toBe("abcdefghij");
  });

  test.each([
    "\u007f",
    "\u0080",
    "\u07ff",
    "\u0800",
    "\ud7ff",
    "\ud800",
    "\udbff",
    "\udc00",
    "\udfff",
    "\ue000",
    "\uffff",
    "\ud800\udc00",
    "\udbff\udfff",
    "\ud800\udbff",
    "\ud800\ue000",
    "\ud800a",
    "a\ud800",
    "\udc00\udc00",
    "\u0800\udc00",
    "\ud7ff\udfff",
  ])("the byte count of %j matches TextEncoder", (text) => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(0, (o) => reports.push(o));
    lines.push(`${text}\n`);
    expect(reports).toEqual([
      {
        characters: text.length,
        bytes: new TextEncoder().encode(text).length,
        limit: 0,
        head: text,
      },
    ]);
  });

  test("counts decoded bytes pushed as Uint8Array chunks", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(3, (o) => reports.push(o));
    const bytes = new TextEncoder().encode("éééé\n");
    // Tear the second character across two chunks.
    expect(lines.push(bytes.subarray(0, 3))).toEqual([]);
    expect(lines.push(bytes.subarray(3))).toEqual([]);
    expect(reports).toEqual([{ characters: 4, bytes: 8, limit: 3, head: "éééé" }]);
  });

  test("an incomplete UTF-8 sequence at stream close decodes as U+FFFD on the final line", () => {
    const lines = new LineBuffer(4);
    expect(lines.push(new Uint8Array([0x61, 0xc3]))).toEqual([]);
    expect(lines.flush()).toBe("a\ufffd");
  });

  test("a line at the limit passes and reports nothing", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(4, (o) => reports.push(o));
    expect(lines.push("abcd\n")).toEqual(["abcd"]);
    expect(lines.push("wxyz")).toEqual([]);
    expect(lines.flush()).toBe("wxyz");
    expect(reports).toEqual([]);
  });
});

describe("streamTurn: an over-long line is judged where it happened", () => {
  const run = (harness = claudeCode) => {
    const proc = new FakeProcess();
    const turn = streamTurn(
      harness,
      { prompt: "invented prompt" },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    return { proc, turn };
  };

  test("stdout: an overflow the turn recovered from warns, and done stays clean", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.filter((e) => e.kind === "failure")).toEqual([]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([
      {
        kind: "warning",
        message: overflowWarning("stdout", "16,777,217", "the turn completed after it"),
      },
    ]);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "invented answer" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  });

  test("stdout: an overflow with no later assistant message fails the run", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message },
    });
  });

  test("stdout: an overflow the turn did not recover from fails the run", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    // The stream ended without a successful turn end: nothing says the
    // turn completed, so the recovered overflow is still a failure.
    proc.exit(0);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message },
    });
  });

  test("stdout: an overflow followed by a failed turn end fails the run", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(failedResult);
    proc.exit(0);
    const events = await collect(turn);
    // The overflow is a failure of its own; the turn's own error outranks
    // it in the reduction, so the done carries the task failure.
    expect(events.filter((e) => e.kind === "failure")).toContainEqual({
      kind: "failure",
      class: "transport",
      retryable: true,
      message: overflowMessage("stdout", "16,777,217"),
    });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "task" },
    });
  });

  test("stdout: a pi echo record warns even with no later message", async () => {
    const { proc, turn } = run(piCli);
    // pi repeats the assistant message on agent_end; hcn read it from
    // message_end, so losing the echo costs the caller nothing.
    const echo = JSON.stringify({ type: "agent_end", messages: ["x".repeat(OVER)] });
    proc.emitChunk(`${echo}\n`);
    proc.exit(0);
    const events = await collect(turn);
    const bytes = new TextEncoder().encode(echo).length;
    expect(events.filter((e) => e.kind === "failure")).toEqual([]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([
      {
        kind: "warning",
        message: overflowWarning("stdout", grouped(bytes), "it repeats records already read"),
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  });

  test("stdout: an unterminated over-long final line is reported at stream close", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk("y".repeat(OVER));
    proc.exit(0);
    const events = await collect(turn);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message: overflowMessage("stdout", "16,777,217") },
    });
  });

  test("stderr: an over-long diagnostic line fails the run too", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitStderr("e".repeat(OVER));
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    // Let the stderr pump read its line before the pipes close.
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.exit(0);
    const events = await collect(turn);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message: overflowMessage("stderr", "16,777,217") },
    });
  });

  test("stderr: an unterminated over-long final line is reported at stream close", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.stderr.push("f".repeat(OVER));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message: overflowMessage("stderr", "16,777,217") },
    });
  });
});

describe("openSession: an over-long line is judged where it happened", () => {
  const openTurn = async (harness = claudeCode) => {
    const proc = new FakeProcess();
    const session = openSession(
      harness,
      { sessionId: sid },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    session.send({ id: "s", text: "invented prompt" });
    // Native uuid evidence publishes the input's turn (issue #426).
    proc.emitLine(claudeInitNaming(sid, proc));
    const turn = (await session.turns[Symbol.asyncIterator]().next())
      .value as AsyncIterable<HarnessEvent>;
    return { proc, session, turn };
  };

  test("stdout: an overflow the turn recovered from warns, and the turn stays clean", async () => {
    const { proc, session, turn } = await openTurn();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    const events = await collect(turn);
    expect(events.filter((e) => e.kind === "failure")).toEqual([]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([
      {
        kind: "warning",
        message: overflowWarning("stdout", "16,777,217", "the turn completed after it"),
      },
    ]);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "invented answer" });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await session.close();
  });

  test("stdout: an overflow with no later assistant message fails the turn", async () => {
    const { proc, session, turn } = await openTurn();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(result);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message },
    });
    await session.close();
  });

  test("stderr", async () => {
    const { proc, session, turn } = await openTurn();
    proc.emitLine(init);
    proc.emitStderr("e".repeat(OVER));
    // Let the stderr pump read its line before the turn ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    const events = await collect(turn);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message: overflowMessage("stderr", "16,777,217") },
    });
    await session.close();
  });
});

/** Issue #466: the pending stdout overflows settle with the turn they
 * landed in. Every ending that reports a turn's outcome to the caller
 * settles them there, so a later turn can no longer supersede an earlier
 * turn's overflow. */
describe("openSession: the overflow settles with the turn it landed in", () => {
  const piSession = () => {
    const proc = new FakeProcess();
    const session = openSession(
      piCli,
      { sessionId: sid, questions: "none" },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    return { proc, session };
  };

  const claudeTurn = async () => {
    const proc = new FakeProcess();
    const session = openSession(
      claudeCode,
      { sessionId: sid, questions: "none" },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    session.send({ id: "s", text: "invented prompt" });
    // Native uuid evidence publishes the input's turn (issue #426).
    proc.emitLine(claudeInitNaming(sid, proc));
    const turn = (await session.turns[Symbol.asyncIterator]().next())
      .value as AsyncIterable<HarnessEvent>;
    return { proc, session, turn };
  };

  /** pi's assistant message: it publishes a provisional turn (run
   * evidence) and supersedes the overflows the turn held. */
  const piMessage = (text: string) =>
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });
  /** pi's turn-end record. */
  const piSettled = () => JSON.stringify({ type: "agent_settled" });
  /** pi's receipt for the prompt the runner wrote. */
  const piReceipt = (proc: FakeProcess, disposition: string) =>
    JSON.stringify({
      id: proc.lastSendRequestId(),
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition },
    });

  test("a refused opener settles the overflow it held, and the next turn does not carry it", async () => {
    const { proc, session } = piSession();
    const turns = session.turns[Symbol.asyncIterator]();
    const send = session.send({ id: "a", text: "invented prompt" });
    // The overflow lands in the turn the refused prompt opened.
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    // pi refuses the prompt natively: the refusal is the turn's outcome.
    proc.emitLine(
      JSON.stringify({
        id: proc.lastSendRequestId(),
        type: "response",
        command: "prompt",
        success: false,
        error: "invented refusal",
      }),
    );
    const turn = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    expect(await send.settled).toMatchObject({
      disposition: "rejected",
      reason: "native-rejected",
    });
    const events = await collect(turn);
    // The overflow settled with the refusal: the refused turn failed on
    // it, and it landed inside that turn.
    expect(events.filter((e) => e.kind === "failure")).toContainEqual({
      kind: "failure",
      class: "transport",
      retryable: true,
      message: overflowMessage("stdout", "16,777,217"),
    });
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "failed" });

    // The next turn starts from no inherited overflow.
    session.send({ id: "b", text: "another prompt" });
    proc.emitLine(piMessage("invented answer"));
    proc.emitLine(piSettled());
    const next = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    const nextEvents = await collect(next);
    expect(nextEvents.filter((e) => e.kind === "failure")).toEqual([]);
    expect(nextEvents.filter((e) => e.kind === "warning")).toEqual([]);
    expect(nextEvents.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await session.close();
  });

  test("a handled receipt that ends a published turn settles the overflow there", async () => {
    const { proc, session } = piSession();
    const turns = session.turns[Symbol.asyncIterator]();
    const send = session.send({ id: "a", text: "invented prompt" });
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    // The assistant message publishes the provisional turn and supersedes
    // the overflow it held: the turn recovered from the discard.
    proc.emitLine(piMessage("invented answer"));
    // pi consumed the input with no run, so no settlement will follow:
    // the turn ends here, and the caller sees that outcome.
    proc.emitLine(piReceipt(proc, "handled"));
    const turn = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    expect(await send.settled).toEqual({ disposition: "started" });
    const events = await collect(turn);
    // The ending reports a clean turn, so the overflow it recovered from
    // warns - and it settled here, inside that turn.
    expect(events.filter((e) => e.kind === "failure")).toEqual([]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([
      {
        kind: "warning",
        message: overflowWarning("stdout", "16,777,217", "the turn completed after it"),
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });

    // The next turn starts from no inherited overflow.
    session.send({ id: "b", text: "another prompt" });
    proc.emitLine(piMessage("invented answer"));
    proc.emitLine(piSettled());
    const next = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    const nextEvents = await collect(next);
    expect(nextEvents.filter((e) => e.kind === "failure")).toEqual([]);
    expect(nextEvents.filter((e) => e.kind === "warning")).toEqual([]);
    expect(nextEvents.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    await session.close();
  });

  test("an aborted turn-end fails a superseded overflow", async () => {
    const { proc, session, turn } = await claudeTurn();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    // The harness cancelled the turn: an overflow the turn recovered from
    // fails, because the turn did not complete.
    proc.emitLine(
      JSON.stringify({ type: "result", subtype: "success", terminal_reason: "aborted_streaming" }),
    );
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message },
    });
    await session.close();
  });

  test("a turn still open when the process died fails on its held overflows", async () => {
    const { proc, session, turn } = await claudeTurn();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    // The assistant message supersedes the first overflow: the turn
    // recovered from it.
    proc.emitLine(assistant("invented answer"));
    // A second overflow lands after it and is still held.
    proc.emitChunk(`${"y".repeat(OVER)}\n`);
    proc.exit(1);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    // Both fail: the recovered one because the turn never completed, the
    // held one because nothing recovered from it.
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.filter((e) => e.kind === "warning")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "crash",
      failure: { class: "transport", message },
    });
    await session.close();
  });
});
