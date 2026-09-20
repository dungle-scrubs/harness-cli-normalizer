import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

describe("Antigravity execution boundary", () => {
  test("a structured ERROR result fails the turn even when the native process exits zero", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const pending = collect(
      streamTurn(
        antigravityCli,
        { prompt: "hello", questions: "none" },
        { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
      ),
    );

    proc.emitLine(
      JSON.stringify({
        event: "result",
        result: { status: "ERROR", error: "Authentication required. Please sign in." },
      }),
    );
    proc.exit(0);

    const events = await pending;
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "failure", class: "auth", authKind: "not-logged-in" }),
    );
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      exitCode: 0,
      cause: "failed",
      failure: { class: "auth" },
    });
  });

  test("the HCN wall-clock timeout outranks Antigravity's cancellation result", async () => {
    const proc = new FakeProcess();
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const pending = collect(
      streamTurn(
        antigravityCli,
        { prompt: "wait", questions: "none" },
        {
          spawn: spawner.spawn,
          clock,
          signal: fakeSignal({ autoExit: false }).signal,
          turnTimeoutMs: 100,
        },
      ),
    );

    await Promise.resolve();
    clock.advance(101);
    proc.emitLine(
      JSON.stringify({ event: "result", result: { status: "ERROR", error: "context canceled" } }),
    );
    proc.exit(1);

    const events = await pending;
    expect(events.filter((event) => event.kind === "failure")).toEqual([
      expect.objectContaining({ kind: "failure", class: "timeout" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "done",
      cause: "killed",
      failure: { class: "timeout" },
    });
  });

  test("caller cancellation discards Antigravity's shutdown result", async () => {
    const proc = new FakeProcess();
    const controller = new AbortController();
    const spawner = fakeSpawner([proc]);
    const pending = collect(
      streamTurn(
        antigravityCli,
        { prompt: "wait", questions: "none", signal: controller.signal },
        {
          spawn: spawner.spawn,
          clock: new FakeClock(),
          signal: fakeSignal({ autoExit: false }).signal,
        },
      ),
    );

    await Promise.resolve();
    controller.abort();
    proc.emitLine(
      JSON.stringify({ event: "result", result: { status: "ERROR", error: "context canceled" } }),
    );
    proc.exit(1);

    const done = eventsDone(await pending);
    expect(done).toMatchObject({ kind: "done", cause: "killed" });
    expect(done.failure).toBeUndefined();
  });
});

const eventsDone = (events: HarnessEvent[]): Extract<HarnessEvent, { kind: "done" }> =>
  events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
