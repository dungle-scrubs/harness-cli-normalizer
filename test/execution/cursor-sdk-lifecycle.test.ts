import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { CLOSE_GRACE_MS } from "../../src/execution/open-session.js";
import { PIPE_GRACE_MS, streamTurn } from "../../src/execution/stream-turn.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const collect = async (events: AsyncIterable<HarnessEvent>) => {
  const result: HarnessEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Cursor SDK worker cleanup", () => {
  test("a terminal worker that ignores EOF receives the existing close escalation", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const clock = new FakeClock();
    const signals = fakeSignal();
    const result = collect(
      streamTurn(
        cursorCli,
        { prompt: "fixture" },
        {
          spawn: fakeSpawner([proc]).spawn,
          clock,
          signal: signals.signal,
        },
      ),
    );
    try {
      await tick();
      proc.emitLine(JSON.stringify({ hcn: "turn-end", status: "finished" }));
      await tick();
      expect(proc.stdinEnded).toBe(true);
      clock.advance(CLOSE_GRACE_MS);
      expect(signals.sent.map((sent) => sent.sig)).toEqual(["SIGTERM"]);
      clock.advance(5000);
      expect(signals.sent.map((sent) => sent.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      proc.exit(null);
      await result;
    }
  });

  test("a dead worker cannot leave its output reads open past pipe grace", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const clock = new FakeClock();
    const result = collect(
      streamTurn(
        cursorCli,
        { prompt: "fixture" },
        {
          spawn: fakeSpawner([proc]).spawn,
          clock,
          signal: fakeSignal().signal,
        },
      ),
    );
    try {
      await tick();
      proc.exitWithoutClosing(1);
      await tick();
      clock.advance(PIPE_GRACE_MS);
      expect(proc.outputDisposed).toBe(true);
    } finally {
      proc.disposeOutput();
      await result;
    }
  });
});
