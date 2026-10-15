import { expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const deps = (proc: FakeProcess) => ({
  spawn: fakeSpawner([proc]).spawn,
  signal: fakeSignal().signal,
  clock: new FakeClock(),
});
const collect = async (stream: AsyncIterable<HarnessEvent>) => {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};
const response = (input: number) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    stopReason: "stop",
    usage: { input, output: 3 },
  },
});

test("Pi session results remain lossless for a late consumer and usage stays within each turn", async () => {
  const proc = new FakeProcess();
  const session = openSession(piCli, { sessionId: sid, questions: "none" }, deps(proc));
  const turns = session.turns[Symbol.asyncIterator]();
  for (let n = 1; n <= 2; n++) {
    const receipt = session.send({ id: `send-${n}`, text: "fixture" });
    const turn = (await turns.next()).value;
    if (turn === undefined) throw new Error("no turn");
    proc.emitLine(
      JSON.stringify({
        type: "response",
        command: "prompt",
        id: `hcn-send:send-${n}`,
        success: true,
      }),
    );
    expect(await receipt.settled).toEqual({ disposition: "started" });
    for (let i = 0; i < 200; i++)
      proc.emitLine(
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "workflow",
          toolCallId: `t${n}-${i}`,
          result: {
            content: [{ type: "text", text: "x".repeat(5000) }],
            details: { status: "error", index: i },
          },
          isError: true,
        }),
      );
    proc.emitLine(JSON.stringify(response(n * 100)));
    proc.emitLine(JSON.stringify({ type: "agent_settled" }));
    const events = await collect(turn);
    const results = events.filter((e) => e.kind === "tool-result");
    expect(results).toHaveLength(200);
    for (let i = 0; i < 200; i++)
      expect(results[i]).toMatchObject({
        callId: `t${n}-${i}`,
        result: { content: [{ text: "x".repeat(5000) }], details: { index: i } },
        isError: true,
      });
    expect(events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "message",
        inputTokens: n * 100,
        outputTokens: 3,
        inputIncludesCache: false,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
  }
  await session.close();
});

test("native usage survives a terminal Pi provider error without changing its failure", async () => {
  const proc = new FakeProcess();
  const pending = collect(streamTurn(piCli, { prompt: "fixture", questions: "none" }, deps(proc)));
  proc.emitLine(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
        usage: { input: 17, output: 0 },
      },
    }),
  );
  proc.exit(0);
  const events = await pending;
  expect(events).toContainEqual({
    kind: "usage",
    scope: "message",
    inputTokens: 17,
    outputTokens: 0,
    inputIncludesCache: false,
  });
  expect(events.at(-1)).toMatchObject({
    kind: "done",
    cause: "failed",
    failure: { class: "task" },
  });
});
