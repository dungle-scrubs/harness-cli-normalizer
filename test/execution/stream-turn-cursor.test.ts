/**
 * Issue #440: cursor launches spawn the SDK worker, whose stdin is a pipe
 * carrying the open and prompt lines (any prompt size - argv limits no
 * longer apply). The legacy reader-state discipline still holds through
 * the worker runner: decoded records share the same content reader.
 */
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

describe("streamTurn cursor spawn", () => {
  test("stdin is a pipe carrying the open and prompt lines, any prompt size", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawner.calls[0]?.opts.stdin).toBe("pipe");
    const open = JSON.parse(proc.stdinLines[0] as string) as Record<string, unknown>;
    expect(open.hcn).toBe("open");
    const prompt = JSON.parse(proc.stdinLines[1] as string) as { message?: string };
    expect(prompt.message).toBe("x".repeat(20_000));
    proc.exit(0);
    await pending;
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
