import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession, type SessionTurn } from "../../src/execution/open-session.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

async function run(harness: HarnessDescriptor, records: unknown[], exitCode: number) {
  const proc = new FakeProcess({ exitOnStdinEnd: false });
  const pending = (async () => {
    const events: HarnessEvent[] = [];
    for await (const event of streamTurn(
      harness,
      { prompt: "fixture", questions: "none" },
      { spawn: fakeSpawner([proc]).spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    )) {
      events.push(event);
    }
    return events;
  })();
  for (const record of records) proc.emitLine(JSON.stringify(record));
  if (exitCode !== 0) proc.emitStderr("Error: isolated native fixture failure");
  proc.exit(exitCode);
  return pending;
}

const cases = [
  {
    harness: cursorCli,
    denial: {
      type: "tool_call",
      subtype: "completed",
      call_id: "same-call",
      tool_call: { shellToolCall: { result: { rejected: { reason: "needs approval" } } } },
    },
    ordinaryError: {
      type: "tool_call",
      subtype: "completed",
      call_id: "ordinary-error",
      tool_call: {
        shellToolCall: { result: { error: { message: "command exited with status 3" } } },
      },
    },
    terminalError: { type: "result", subtype: "error_during_execution", is_error: true },
  },
  {
    harness: antigravityCli,
    denial: {
      event: "step_update",
      step_update: {
        step_type: "tool",
        step_id: "same-step",
        state: "ERROR",
        tool_info: {
          name: "run_command",
          error: { type: "PermissionDenied", message: "user denied permission to run command" },
        },
      },
    },
    ordinaryError: {
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: "ERROR",
        tool_info: {
          name: "run_command",
          error: { type: "CommandError", message: "command exited with status 3" },
        },
      },
    },
    terminalError: {
      event: "result",
      result: { status: "ERROR", error: "invalid model selection" },
    },
  },
];

for (const { harness, denial, ordinaryError, terminalError } of cases) {
  describe(`${harness.name} terminal denial observations`, () => {
    for (const copies of [0, 1, 2]) {
      for (const exitCode of [0, 7]) {
        test(`${copies} repeated reports retain native exit ${exitCode} and count observations`, async () => {
          const events = await run(
            harness,
            [ordinaryError, ...Array.from({ length: copies }, () => denial)],
            exitCode,
          );
          expect(events.filter((event) => event.kind === "error" && event.denial)).toHaveLength(
            copies,
          );
          const done = events.at(-1);
          expect(done).toMatchObject({
            kind: "done",
            exitCode,
            cause: exitCode === 0 ? "clean" : "crash",
          });
          if (copies === 0) expect(done).not.toHaveProperty("denialCount");
          else expect(done).toHaveProperty("denialCount", copies);
          if (exitCode === 0) {
            expect(done).not.toHaveProperty("failure");
            expect(events.filter((event) => event.kind === "failure")).toEqual([]);
          } else {
            expect(done).toMatchObject({
              failure: { class: "native", nativeExitCode: 7, retryable: false },
            });
          }
        });
      }
    }

    test("denial observations do not replace an independent native task failure", async () => {
      const control = await run(harness, [terminalError], 0);
      const events = await run(harness, [denial, denial, terminalError], 0);
      expect(control.at(-1)).toMatchObject({
        kind: "done",
        exitCode: 0,
        cause: "failed",
        failure: { class: "task", retryable: false },
      });
      expect(control.at(-1)).not.toHaveProperty("denialCount");
      expect(events.at(-1)).toEqual({ ...control.at(-1), denialCount: 2 });
      expect(events.filter((event) => event.kind === "failure")).toEqual(
        control.filter((event) => event.kind === "failure"),
      );
    });

    // Issue #394: nonzero native exit beside an independent task failure.
    test("denial observations stay advisory beside a task failure on a nonzero exit", async () => {
      const control = await run(harness, [terminalError], 7);
      const events = await run(harness, [denial, denial, terminalError], 7);
      expect(control.at(-1)).toMatchObject({
        kind: "done",
        exitCode: 7,
        cause: "failed",
        failure: { class: "task", retryable: false },
      });
      expect(control.at(-1)).not.toHaveProperty("denialCount");
      expect(events.at(-1)).toEqual({ ...control.at(-1), denialCount: 2 });
      expect(events.filter((event) => event.kind === "failure")).toEqual(
        control.filter((event) => event.kind === "failure"),
      );
    });
  });
}

// Issue #394: Antigravity persistent-session denial observations. Records
// mirror native shapes captured under test/fixtures/antigravity-1.2.7
// (persistent-session.ndjson for turn delimiters, permission-denied.ndjson
// for the PermissionDenied step_update). Cursor has no persistent session
// mode, so it has no cell here.
describe("antigravity persistent-session denial observations", () => {
  const conversationId = "d297ac09-9d33-4fb3-b696-b8ae081c239e";
  const init = JSON.stringify({ event: "init", conversation_id: conversationId });
  const denialStep = JSON.stringify({
    event: "step_update",
    step_update: {
      step_type: "tool",
      step_id: "same-step",
      state: "ERROR",
      tool_info: {
        name: "run_command",
        error: { type: "PermissionDenied", message: "user denied permission to run command" },
      },
    },
  });
  const result = (response: string) =>
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response,
        usage: {
          input_tokens: 12036,
          output_tokens: 104,
          thinking_tokens: 103,
          cache_read_tokens: 0,
          total_tokens: 12140,
        },
      },
    });

  const drain = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
    const out: HarnessEvent[] = [];
    for await (const event of turn) out.push(event);
    return out;
  };

  test("a session turn counts its step_update denials and the next turn starts from zero", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const session = openSession(
      antigravityCli,
      { sessionId: "11111111-2222-4333-8444-555555555555" },
      { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    const turns = session.turns[Symbol.asyncIterator]();
    try {
      // One process, the session argv - the denials ride the session wire.
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.argv).toContain("--input-format");

      session.send({ id: "denied", text: "first" });
      const first = (await turns.next()).value as SessionTurn;
      proc.emitLine(init);
      proc.emitLine(denialStep);
      proc.emitLine(denialStep);
      proc.emitLine(result("done despite denials"));
      const denied = await drain(first);
      expect(denied.filter((e) => e.kind === "error" && e.denial)).toHaveLength(2);
      // Advisory: the turn still succeeds - denial observations are
      // counted, never turned into a failure.
      expect(denied.some((e) => e.kind === "failure")).toBe(false);
      expect(denied.at(-1)).toMatchObject({
        kind: "done",
        exitCode: null,
        cause: "clean",
        denialCount: 2,
      });

      // The count resets at the next turn boundary: no denials observed,
      // no denialCount on that turn's done, and no leak of turn 1's count.
      session.send({ id: "clear", text: "second" });
      const second = (await turns.next()).value as SessionTurn;
      proc.emitLine(result("clear turn"));
      const clear = await drain(second);
      expect(clear.filter((e) => e.kind === "error" && e.denial)).toHaveLength(0);
      expect(clear.at(-1)).toMatchObject({ kind: "done", exitCode: null, cause: "clean" });
      expect(clear.at(-1)).not.toHaveProperty("denialCount");
    } finally {
      await session.close();
    }
  });
});
