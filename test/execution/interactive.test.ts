import { expect, test } from "vitest";
import type { InteractiveControl } from "../../src/execution/interactive.js";
import { runInteractive } from "../../src/execution/interactive.js";
import type { InteractiveRequest } from "../../src/interpretation/interactive.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

test("lost started control keeps launch uncertain and cleans up only the owned process", async () => {
  const owner = { executable: "/native/codex", pid: 234, startedAt: "123:456" };
  const child = Object.assign(new FakeProcess(), {
    started: Promise.resolve({ kind: "started" as const, owner }),
  });
  const clock = new FakeClock();
  const spawner = fakeSpawner([child]);
  const signals = fakeSignal();
  const records: Parameters<InteractiveControl["emit"]>[0][] = [];
  const result = await runInteractive(
    {
      cwd: "/work",
      harness: "codex",
      interface: "codex-cli",
      launchId: "cf548bfb-e24e-4bb0-ab3e-ad9c70ac04db",
      sessionId: "407feafe-e82b-4df4-91ba-4f1aeb987508",
    },
    { clock, signal: signals.signal, spawn: spawner.spawn },
    {
      emit: (record) => {
        if (record.kind === "started") throw new Error("Caller pipe closed");
        records.push(record);
      },
      preflight: () => ({
        argv: ["/native/codex", "resume", "407feafe-e82b-4df4-91ba-4f1aeb987508"],
        kind: "ready",
      }),
      signal: new AbortController().signal,
    },
  );
  expect(result).toBe(1);
  expect(records.map((record) => record.kind)).toEqual(["ready"]);
  expect(signals.sent).toEqual([{ proc: child, sig: "SIGTERM" }]);
  expect(child.hasExited).toBe(true);
  expect(child.outputDisposed).toBe(true);
  expect(clock.pendingTimerCount).toBe(0);
});

const request: InteractiveRequest = {
  cwd: "/work",
  harness: "codex",
  interface: "codex-cli",
  launchId: "cf548bfb-e24e-4bb0-ab3e-ad9c70ac04db",
  sessionId: "407feafe-e82b-4df4-91ba-4f1aeb987508",
};

// Confirm existing lifecycle branches with deterministic process evidence.
test("a created child without owner evidence stays uncertain and is stopped", async () => {
  const child = Object.assign(new FakeProcess(), {
    started: Promise.resolve({ kind: "started" as const, owner: undefined }),
  });
  const clock = new FakeClock();
  const signals = fakeSignal();
  const spawner = fakeSpawner([child]);
  const records: Parameters<InteractiveControl["emit"]>[0][] = [];
  const result = await runInteractive(
    request,
    { clock, signal: signals.signal, spawn: spawner.spawn },
    {
      emit: (record) => records.push(record),
      preflight: () => ({ argv: ["/native/codex"], kind: "ready" }),
      signal: new AbortController().signal,
    },
  );
  expect(result).toBe(1);
  expect(records.map((record) => record.kind)).toEqual(["ready"]);
  expect(signals.sent).toEqual([{ proc: child, sig: "SIGTERM" }]);
  expect(child.hasExited).toBe(true);
  expect(child.outputDisposed).toBe(true);
  expect(clock.pendingTimerCount).toBe(0);
});

test("adapter no-child evidence is refused without signalling a process", async () => {
  const child = Object.assign(new FakeProcess(), {
    started: Promise.resolve({ code: "ENOENT", kind: "not-started" as const }),
  });
  child.failToStart("Executable missing");
  const clock = new FakeClock();
  const signals = fakeSignal();
  const spawner = fakeSpawner([child]);
  const records: Parameters<InteractiveControl["emit"]>[0][] = [];
  const result = await runInteractive(
    request,
    { clock, signal: signals.signal, spawn: spawner.spawn },
    {
      emit: (record) => records.push(record),
      preflight: () => ({ argv: ["/native/codex"], kind: "ready" }),
      signal: new AbortController().signal,
    },
  );
  expect(result).toBe(2);
  expect(records.map((record) => record.kind)).toEqual(["ready", "refused"]);
  expect(records[1]).toMatchObject({ evidence: "spawn-not-attempted", reason: "spawn-rejected" });
  expect(signals.sent).toEqual([]);
  expect(child.outputDisposed).toBe(true);
  expect(clock.pendingTimerCount).toBe(0);
});

test("cancellation before creation produces no-child evidence without spawning", async () => {
  const clock = new FakeClock();
  const signals = fakeSignal();
  const spawner = fakeSpawner([]);
  const controller = new AbortController();
  controller.abort();
  const records: Parameters<InteractiveControl["emit"]>[0][] = [];
  const result = await runInteractive(
    request,
    { clock, signal: signals.signal, spawn: spawner.spawn },
    {
      emit: (record) => records.push(record),
      preflight: () => ({ argv: ["/native/codex"], kind: "ready" }),
      signal: controller.signal,
    },
  );
  expect(result).toBe(2);
  expect(records.map((record) => record.kind)).toEqual(["ready", "refused"]);
  expect(records[1]).toMatchObject({ evidence: "spawn-not-attempted", reason: "spawn-rejected" });
  expect(spawner.calls).toEqual([]);
  expect(signals.sent).toEqual([]);
  expect(clock.pendingTimerCount).toBe(0);
});
