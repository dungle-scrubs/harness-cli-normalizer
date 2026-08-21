import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const depsFor = (proc: FakeProcess) => {
  const clock = new FakeClock();
  const sig = fakeSignal();
  const spawner = fakeSpawner([proc]);
  return { spawn: spawner.spawn, clock, signal: sig.signal };
};

describe("F-08 progress before identity", () => {
  test("replay bare-claude raw lines first event is identity", async () => {
    // Simulate raw claude hooks before init: 4 hook_started + 4 hook_response before init
    const sid = "83118d2a-5899-4b01-b37c-a0e61a8ac94f";
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    for (let i = 0; i < 4; i++)
      proc.emitLine(JSON.stringify({ type: "system", subtype: "hook_started" }));
    for (let i = 0; i < 4; i++)
      proc.emitLine(JSON.stringify({ type: "system", subtype: "hook_response" }));
    proc.emitLine(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
    proc.emitLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    expect(events[0]?.kind).toBe("identity");
    // progress events should appear after identity
    const progressIndices = events
      .map((e, i) => (e.kind === "progress" ? i : -1))
      .filter((i) => i >= 0);
    const identityIndex = events.findIndex((e) => e.kind === "identity");
    // First 8 progress were before identity raw - after fix they should be after identity
    // So all progress indices should be > identityIndex, except maybe those after identity originally?
    // At least the earliest progress should be after identity
    expect(Math.min(...progressIndices)).toBeGreaterThan(identityIndex);
  });

  test("stream with no identity still delivers progress before done", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "system", subtype: "hook_started" }));
    proc.emitLine(JSON.stringify({ type: "system", subtype: "hook_started" }));
    proc.emitLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("progress");
    const doneIndex = events.findIndex((e) => e.kind === "done");
    const progressIndex = events.findIndex((e) => e.kind === "progress");
    expect(progressIndex).toBeGreaterThan(-1);
    expect(progressIndex).toBeLessThan(doneIndex);
    expect(events.some((e) => e.kind === "identity")).toBe(false);
  });

  test("lossless message flushes buffered progress before itself", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "system", subtype: "hook_started" }));
    proc.emitLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const progressIdx = events.findIndex((e) => e.kind === "progress");
    const messageIdx = events.findIndex((e) => e.kind === "message");
    // progress was buffered before identity never arrived, but message is lossless and should flush buffer before itself
    // So progress should appear before message
    expect(progressIdx).toBeGreaterThan(-1);
    expect(messageIdx).toBeGreaterThan(-1);
    expect(progressIdx).toBeLessThan(messageIdx);
  });
});
