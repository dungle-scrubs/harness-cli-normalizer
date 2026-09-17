/**
 * RFC-05 Phase 3: cursor launches close stdin (descriptor stdin
 * close-required: a positional prompt plus open stdin emits `result` then
 * never exits, notes 07). The execution layer already closes stdin for
 * this policy; this pins cursor rides it.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

describe("streamTurn cursor spawn", () => {
  test("stdin is closed, even for a large prompt", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const spawner = fakeSpawner([proc]);
    const pending = (async () => {
      const events = [];
      for await (const e of streamTurn(
        cursorCli,
        { prompt: "x".repeat(20_000), questions: "none" },
        { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
      )) {
        events.push(e);
      }
      return events;
    })();
    proc.exit(0);
    await pending;
    expect(spawner.calls[0]?.opts.stdin).toBe("close");
  });

  test("reader state resets per turn: turn 2 re-emits tool for turn 1's pending id", async () => {
    // L3: the first turn leaves a pending id; the second turn must build
    // fresh reader state, so a completion with the same id emits a tool
    // event instead of being suppressed as a duplicate.
    const runTurn = async (lines: string[]): Promise<HarnessEvent[]> => {
      const proc = new FakeProcess();
      const spawner = fakeSpawner([proc]);
      const pending = (async () => {
        const events: HarnessEvent[] = [];
        for await (const e of streamTurn(
          cursorCli,
          { prompt: "hi" },
          { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
        )) {
          events.push(e);
        }
        return events;
      })();
      for (const line of lines) proc.emitLine(line);
      proc.exit(0);
      return pending;
    };
    const started = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-1",
      tool_call: { shellToolCall: { args: { command: "ls" } } },
      session_id: "s",
    });
    const completed = JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "call-1",
      tool_call: { shellToolCall: { result: { success: { exitCode: 0 } } } },
      session_id: "s",
    });
    const first = await runTurn([started]);
    expect(first.filter((e) => e.kind === "tool")).toHaveLength(1);
    const second = await runTurn([completed]);
    const tools = second.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "shellToolCall" });
  });
});
