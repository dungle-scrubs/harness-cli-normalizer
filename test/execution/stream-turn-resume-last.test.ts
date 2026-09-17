/**
 * RFC-06 Phase 3: the resume-last runner gate at the streamTurn seam.
 * The pre-spawn lines arrive as plain option data from the CLI layer;
 * execution only emits them before any harness output, spawn failures
 * included. The identity resumeLast signal rides the decode state. Fake
 * spawner only; never runs a real harness CLI.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const notices = (cwd: string): readonly string[] => [
  `hcn: --resume-last forks the most-recent claude session in ${cwd} under a new fork id`,
  `hcn: --resume-last store root /tmp/fake-root for scope ${cwd}`,
  `hcn: --resume-last found no store directory for scope ${cwd} (/tmp/fake-root/-tmp-x)`,
];

const freshCwd = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-rl-")));

describe("RFC-06 Phase 3: resume-last pre-spawn notices", () => {
  test("a resume-last turn yields the passed notices before any harness output", async () => {
    const cwd = freshCwd();
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi", resumeLast: true, resumeLastNotices: notices(cwd), cwd, questions: "none" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine(init);
    proc.exit(0);
    const events = await collect(turn);
    const errors = events.filter((e) => e.kind === "error") as Array<{ message: string }>;
    expect(errors.map((e) => e.message)).toEqual([...notices(cwd)]);
    const identityIndex = events.findIndex((e) => e.kind === "identity");
    const firstWarningIndex = events.findIndex(
      (e) => e.kind === "error" && e.message.startsWith("hcn: --resume-last"),
    );
    expect(firstWarningIndex).toBeGreaterThanOrEqual(0);
    expect(firstWarningIndex).toBeLessThan(identityIndex);
  });

  test("notices without the resume-last flag are never emitted", async () => {
    const cwd = freshCwd();
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi", resumeLastNotices: notices(cwd), cwd, questions: "none" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.exit(0);
    const events = await collect(turn);
    expect(
      events.some(
        (e) => e.kind === "error" && (e as { message: string }).message.includes("--resume-last"),
      ),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "done" });
  });

  test("a spawn failure still emits the notices before the spawn-failed error", async () => {
    const cwd = freshCwd();
    const spawner = fakeSpawner([]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi", resumeLast: true, resumeLastNotices: notices(cwd), cwd, questions: "none" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    const events = await collect(turn);
    const errors = events.filter((e) => e.kind === "error") as Array<{ message: string }>;
    expect(errors.length).toBe(4);
    expect(errors.slice(0, 3).map((e) => e.message)).toEqual([...notices(cwd)]);
    expect(errors[3]?.message.startsWith("spawn failed:")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "done", exitCode: 127 });
  });
});

describe("RFC-06 Phase 3: resume-last identity signal", () => {
  test("a resume-last turn marks identity resumeLast:true with harness-minted authority", async () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    const sig = fakeSignal();
    const clock = new FakeClock();
    const turn = streamTurn(
      claudeCode,
      { prompt: "hi", resumeLast: true, cwd: freshCwd(), questions: "none" },
      { spawn: spawner.spawn, clock, signal: sig.signal },
    );
    proc.emitLine(init);
    proc.exit(0);
    const events = await collect(turn);
    const id = events.find((e) => e.kind === "identity") as unknown as
      | { sessionId: string; authority: string; resumeLast?: true }
      | undefined;
    expect(id?.sessionId).toBe(sid);
    expect(id?.authority).toBe("harness-minted");
    expect(id?.resumeLast).toBe(true);
  });
});
