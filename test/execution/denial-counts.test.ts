import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
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
  });
}
