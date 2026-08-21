import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

describe("F-06 limit on stdout ends without done.failure", () => {
  test("fake stdout plain limit line then exit 1 yields usage-limit failure and done.failure", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const sig = fakeSignal();
    const spawner = fakeSpawner([proc]);
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine("You've hit your usage limit");
    proc.exit(1);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { kind: string; cause: string; failure?: { class: string; retryable: boolean } }
      | undefined;
    expect(done).toBeDefined();
    expect(done?.cause).toBe("limit");
    expect(done?.failure).toBeDefined();
    expect(done?.failure?.class).toBe("usage-limit");
    expect(done?.failure?.retryable).toBe(true);
    const failureEvent = events.find((e) => e.kind === "failure") as unknown as
      | { class: string }
      | undefined;
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.class).toBe("usage-limit");
  });
});
