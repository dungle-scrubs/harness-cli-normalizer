import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
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

describe("F-07 terminal error record ends clean", () => {
  test("claude result is_error true yields task failure and cause failed", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(claudeCode, { prompt: "hi" }, d);
    const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
    proc.emitLine(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
    proc.emitLine(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" }));
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("replay pi-autherror.ndjson through streamTurn ends with task failure and cause failed", async () => {
    const raw = readFileSync(
      join(import.meta.dirname, "../fixtures/harnesses/pi-autherror.ndjson"),
      "utf8",
    );
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(piCli, { prompt: "Reply with only: alpha" }, d);
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") proc.emitLine(line);
    }
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("codex error item yields task failure", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(codexCli, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    proc.emitLine(
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "codex failed" } }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });

  test("muse run_terminal failed yields task failure", async () => {
    const proc = new FakeProcess();
    const d = depsFor(proc);
    const turn = streamTurn(museCode, { prompt: "hi" }, d);
    proc.emitLine(JSON.stringify({ stream: { id: "s-1" } }));
    proc.emitLine(
      JSON.stringify({
        payload: { kind: "run_terminal", terminal: "failed", reason: "model error" },
      }),
    );
    proc.exit(0);
    const events = await collect(turn);
    const done = events.find((e) => e.kind === "done") as unknown as
      | { cause: string; failure?: { class: string } }
      | undefined;
    expect(done?.cause).toBe("failed");
    expect(done?.failure?.class).toBe("task");
  });
});
