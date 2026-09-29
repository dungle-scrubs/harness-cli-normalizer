/**
 * An output line over hcn's line bound is discarded, and the discard is
 * never silent: LineBuffer reports it once with its size, and every run and
 * session pump turns that report into a transport failure. Invented data
 * only; fake processes, never a real harness.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { LineBuffer, type LineOverflow, RUN_LINE_MAX } from "../../src/execution/lines.js";
import { openSession } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
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
const OVER = RUN_LINE_MAX + 1;

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const overflowMessage = (stream: string, bytes: string) =>
  `Transport failure (output line overflow: ${stream} line of ${bytes} bytes exceeds the 16,777,216-character line limit and was discarded) - retry or route to another provider`;

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
    expect(reports).toEqual([{ characters: 11, bytes: 17, limit: 8 }]);
  });

  test("reports an unterminated over-long final line at flush, and a lone surrogate as 3 bytes", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(2, (o) => reports.push(o));
    expect(lines.push("ok\n\ud800xyz")).toEqual(["ok"]);
    expect(lines.flush()).toBeNull();
    expect(reports).toEqual([{ characters: 4, bytes: 6, limit: 2 }]);
  });

  test("keeps counting UTF-8 bytes of text that arrives after the line overflowed", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(2, (o) => reports.push(o));
    expect(lines.push("abc")).toEqual([]);
    expect(lines.push("\u00e9\u20ac")).toEqual([]);
    expect(lines.push("\u{1f600}\n")).toEqual([]);
    // 3 + 2 + 2 characters; 3 + (2 + 3) + 4 bytes.
    expect(reports).toEqual([{ characters: 7, bytes: 12, limit: 2 }]);
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
      { characters: text.length, bytes: new TextEncoder().encode(text).length, limit: 0 },
    ]);
  });

  test("counts decoded bytes pushed as Uint8Array chunks", () => {
    const reports: LineOverflow[] = [];
    const lines = new LineBuffer(3, (o) => reports.push(o));
    const bytes = new TextEncoder().encode("éééé\n");
    // Tear the second character across two chunks.
    expect(lines.push(bytes.subarray(0, 3))).toEqual([]);
    expect(lines.push(bytes.subarray(3))).toEqual([]);
    expect(reports).toEqual([{ characters: 4, bytes: 8, limit: 3 }]);
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

describe("streamTurn: an over-long line fails the run", () => {
  const run = () => {
    const proc = new FakeProcess();
    const turn = streamTurn(
      claudeCode,
      { prompt: "invented prompt" },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    return { proc, turn };
  };

  test("stdout: the next lines still decode, and done carries the overflow", async () => {
    const { proc, turn } = run();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    proc.exit(0);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "invented answer" });
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "failed",
      failure: { class: "transport", message },
    });
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

describe("openSession: an over-long line fails the turn it lands in", () => {
  const openTurn = async () => {
    const proc = new FakeProcess();
    const session = openSession(
      claudeCode,
      { sessionId: sid },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    session.send({ id: "s", text: "invented prompt" });
    const turn = (await session.turns[Symbol.asyncIterator]().next())
      .value as AsyncIterable<HarnessEvent>;
    return { proc, session, turn };
  };

  test("stdout", async () => {
    const { proc, session, turn } = await openTurn();
    proc.emitLine(init);
    proc.emitChunk(`${"x".repeat(OVER)}\n`);
    proc.emitLine(assistant("invented answer"));
    proc.emitLine(result);
    const events = await collect(turn);
    const message = overflowMessage("stdout", "16,777,217");
    expect(events.filter((e) => e.kind === "failure")).toEqual([
      { kind: "failure", class: "transport", retryable: true, message },
    ]);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ text: "invented answer" });
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
