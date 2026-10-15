import { expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const run = async (
  h: HarnessDescriptor,
  records: unknown[],
  stderr = "Error: extension failed",
) => {
  const proc = new FakeProcess();
  const pending = (async () => {
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(
      h,
      { prompt: "invented", questions: "none" },
      {
        spawn: fakeSpawner([proc]).spawn,
        clock: new FakeClock(),
        signal: fakeSignal().signal,
      },
    ))
      events.push(event);
    return events;
  })();
  for (const record of records) proc.emitLine(JSON.stringify(record));
  if (stderr) proc.emitStderr(stderr);
  proc.exit(1);
  return pending;
};

const piMessage = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "delivered" }],
    stopReason: "stop",
  },
};

test.each([
  [claudeCode, { type: "result", subtype: "success" }],
  [codexCli, { type: "turn.completed" }],
  [piCli, { type: "agent_settled" }],
  [museCode, { payload: { kind: "run_terminal", terminal: "completed", text: "done" } }],
  [cursorCli, { type: "result", subtype: "success" }],
  [antigravityCli, { event: "result", result: { status: "SUCCESS", response: "done" } }],
  [popeyeCli, { kind: "done", cause: "clean" }],
] as const)(
  "%s successful native terminal survives a silent process crash without retrying work",
  async (h, terminal) => {
    const events = await run(h, [terminal], "");
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      completion: "native-terminal",
      exitCode: 1,
      cause: "crash",
      failure: { class: "native", retryable: false, nativeExitCode: 1 },
    });
  },
);

test("a delivered pi message without native terminal is not proof of a finished turn", async () => {
  const events = await run(piCli, [piMessage, { type: "agent_end", messages: [] }]);
  expect(events).toContainEqual({ kind: "message", role: "assistant", text: "delivered" });
  expect(events.at(-1)).toMatchObject({
    completion: "message-delivered",
    cause: "crash",
    exitCode: 1,
  });
});

test("a crash before any output has no completion observation", async () => {
  const events = await run(piCli, []);
  expect(events.at(-1)).not.toHaveProperty("completion");
  expect(events.at(-1)).toMatchObject({
    failure: { class: "native", nativeExitCode: 1 },
    exitCode: 1,
  });
});

test("an aborted pi delimiter does not claim successful completion", async () => {
  const events = await run(piCli, [{ type: "agent_settled", aborted: true }]);
  expect(events.at(-1)).not.toHaveProperty("completion");
});

test("a pi terminal cannot erase the provider error that ended the attempt", async () => {
  const events = await run(piCli, [
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
    },
    { type: "agent_settled" },
  ]);
  expect(events.at(-1)).not.toHaveProperty("completion");
  expect(events.at(-1)).toMatchObject({ cause: "failed", failure: { class: "task" } });
});
