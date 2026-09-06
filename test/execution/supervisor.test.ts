/**
 * RFC-02 change 5: one turn supervisor owns the stall clock, the signal
 * escalation, stderr classification, and the turn close, for both
 * runners. These pin its contract under a fake clock; the runner suites
 * pin that the event order per turn did not move.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import type { FailureSummary } from "../../src/execution/failure.js";
import { KILL_GRACE_MS, StderrTail, superviseTurn } from "../../src/execution/supervisor.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { FakeClock } from "./fakes.js";

const rig = (stall: number | "no-budget" = 1000, mode: "ask" | "assume" | "none" = "ask") => {
  const stallMs = stall === "no-budget" ? undefined : stall;
  const clock = new FakeClock();
  const signals: string[] = [];
  const emitted: HarnessEvent[] = [];
  const failed: FailureSummary[] = [];
  const tail = new StderrTail();
  let stalls = 0;
  let questions = 0;
  const sup = superviseTurn(claudeCode, mode, {
    clock,
    stallMs,
    signal: (sig) => signals.push(sig),
    emit: async (e) => {
      emitted.push(e);
    },
    fail: async (f) => {
      failed.push(f);
    },
    tail,
    onStall: () => {
      stalls++;
    },
    onQuestion: () => {
      questions++;
    },
  });
  return {
    sup,
    clock,
    signals,
    emitted,
    failed,
    tail,
    stalls: () => stalls,
    questions: () => questions,
  };
};

describe("stall clock", () => {
  test("arms at turn start, rearms on output, fires once, then escalates", () => {
    const r = rig(1000);
    r.sup.beginTurn();
    r.clock.advance(900);
    r.sup.rearm();
    r.clock.advance(900);
    expect(r.stalls()).toBe(0);
    r.clock.advance(200);
    expect(r.stalls()).toBe(1);
    expect(r.signals).toEqual(["SIGTERM"]);
    r.clock.advance(KILL_GRACE_MS);
    expect(r.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a disarmed turn never stalls, and no budget means no clock", () => {
    const r = rig(1000);
    r.sup.beginTurn();
    r.sup.disarm();
    r.clock.advance(5000);
    expect(r.stalls()).toBe(0);
    const none = rig("no-budget");
    none.sup.beginTurn();
    none.clock.advance(60_000);
    expect(none.stalls()).toBe(0);
    expect(none.clock.pendingTimerCount).toBe(0);
  });
});

describe("escalation", () => {
  test("is single-shot while pending and silent after settle", () => {
    const r = rig();
    r.sup.escalate();
    r.sup.escalate();
    expect(r.signals).toEqual(["SIGTERM"]);
    r.sup.settle();
    r.clock.advance(KILL_GRACE_MS);
    expect(r.signals).toEqual(["SIGTERM"]);
    expect(r.clock.pendingTimerCount).toBe(0);
  });
});

describe("stderr classification", () => {
  test("a limit wall is a limit event plus a failure; an auth wall a failure plus an error; else tail", async () => {
    const r = rig();
    await r.sup.stderrLine("You've hit your usage limit");
    await r.sup.stderrLine("Not logged in. Please run /login");
    await r.sup.stderrLine("some noise");
    expect(r.emitted.map((e) => e.kind)).toEqual(["limit", "error"]);
    expect(r.failed.map((f) => f.class)).toEqual(["usage-limit", "auth"]);
    expect(r.tail.snapshot()).toEqual(["some noise"]);
  });
});

describe("turn close", () => {
  const block = (body: string) =>
    ({
      kind: "message",
      role: "assistant",
      text: `done\n\`\`\`hcn-question\n${body}\n\`\`\``,
    }) as const;

  test("a well-formed block becomes one question event and the turn asked", async () => {
    const r = rig();
    r.sup.beginTurn();
    r.sup.noteEvent(block('{"question":"which?","options":["a","b"],"recommended":"a"}'));
    const close = r.sup.close();
    expect(close).toEqual({ detection: "block", asked: true });
    expect(r.emitted).toEqual([
      { kind: "question", question: "which?", options: ["a", "b"], recommended: "a" },
    ]);
    expect(r.questions()).toBe(1);
  });

  test("a malformed block is an error plus a task failure, never silence", async () => {
    const r = rig();
    r.sup.beginTurn();
    r.sup.noteEvent(block("not json"));
    const close = r.sup.close();
    expect(close).toEqual({ detection: "malformed", asked: false });
    expect(r.emitted[0]?.kind).toBe("error");
    expect(r.failed[0]?.class).toBe("task");
  });

  test("detection is armed only in ask mode, and each turn starts clean", async () => {
    const assume = rig(1000, "assume");
    assume.sup.beginTurn();
    assume.sup.noteEvent(block('{"question":"q","options":["a"]}'));
    expect(assume.sup.close()).toEqual({ detection: "none", asked: false });
    const r = rig();
    r.sup.beginTurn();
    r.sup.noteEvent(block('{"question":"q","options":["a"]}'));
    r.sup.beginTurn();
    expect(r.sup.close()).toEqual({ detection: "none", asked: false });
  });
});

describe("one owner per policy", () => {
  test("escalation, the stall clock, stderr classification, and question detection are defined once in execution", () => {
    const dir = join(import.meta.dirname, "../../src/execution");
    const owners: Record<string, string[]> = {
      '("SIGKILL")': [],
      "auth wall: ": [],
      "detectQuestionBlock(": [],
      "questionEventOf(": [],
    };
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const needle of Object.keys(owners)) {
        if (source.includes(needle)) owners[needle]?.push(file);
      }
    }
    expect(owners).toEqual({
      '("SIGKILL")': ["supervisor.ts"],
      "auth wall: ": ["supervisor.ts"],
      "detectQuestionBlock(": [],
      "questionEventOf(": ["supervisor.ts"],
    });
  });
});
