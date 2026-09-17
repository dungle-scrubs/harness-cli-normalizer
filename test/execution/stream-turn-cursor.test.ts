/**
 * RFC-05 Phase 3: cursor launches close stdin (descriptor stdin
 * close-required: a positional prompt plus open stdin emits `result` then
 * never exits, notes 07). The execution layer already closes stdin for
 * this policy; this pins cursor rides it.
 */
import { describe, expect, test } from "vitest";
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
});
