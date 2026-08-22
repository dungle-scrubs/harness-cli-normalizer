import { describe, expect, test } from "vitest";
import type { HarnessEvent } from "../../src/execution/events.js";
import { openSession } from "../../src/execution/open-session.js";
import { buildSessionArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const result = JSON.stringify({ type: "result", subtype: "success" });

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const rig = (stallMs?: number) => {
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  const logged: Record<string, unknown>[] = [];
  const session = openSession(
    claudeCode,
    { sessionId: sid },
    {
      spawn: spawner.spawn,
      clock,
      signal: sig.signal,
      log: (e: Record<string, unknown>) => logged.push(e),
      ...(stallMs !== undefined ? { stallMs } : {}),
    },
  );
  return { proc, clock, sig, session, logged };
};

describe("T05: per-turn stall watchdog", () => {
  test("a turn that goes silent past the budget ends stall and kills the process", async () => {
    const r = rig(1_000);
    r.session.send({ id: "in-1", text: "hi" });
    const turns = r.session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;

    r.proc.emitLine(init);
    await new Promise<void>((res) => setTimeout(res, 0));
    // No further output; the budget expires.
    r.clock.advance(1_000);

    const events = await drainTurn(turn1);
    const done = events.at(-1) as Extract<HarnessEvent, { kind: "done" }>;
    expect(done.cause).toBe("stall");
    expect(done.failure).toMatchObject({ class: "transport" });
    expect(r.sig.sent.map((e) => e.sig)).toContain("SIGTERM");
    expect(r.logged.some((e) => e.event === "stall" && e.reason === "inactivity")).toBe(true);
  });

  test("output rearms the budget, so a slow but live turn is not stalled", async () => {
    const r = rig(1_000);
    r.session.send({ id: "in-1", text: "hi" });
    const turns = r.session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;

    for (let i = 0; i < 3; i++) {
      r.clock.advance(600);
      r.proc.emitLine(init);
      await new Promise<void>((res) => setTimeout(res, 0));
    }
    r.proc.emitLine(result);
    const events = await drainTurn(turn1);
    expect((events.at(-1) as Extract<HarnessEvent, { kind: "done" }>).cause).toBe("clean");
    expect(r.logged.some((e) => e.event === "stall")).toBe(false);
    await r.session.close();
  });

  test("with no budget set, a silent turn is never stalled", async () => {
    const r = rig();
    r.session.send({ id: "in-1", text: "hi" });
    const turns = r.session.turns[Symbol.asyncIterator]();
    await turns.next();
    r.proc.emitLine(init);
    await new Promise<void>((res) => setTimeout(res, 0));
    r.clock.advance(3_600_000);
    expect(r.logged.some((e) => e.event === "stall")).toBe(false);
    expect(r.sig.sent).toHaveLength(0);
  });

  test("the budget is disarmed at turn end, so an idle session is not stalled", async () => {
    const r = rig(1_000);
    r.session.send({ id: "in-1", text: "hi" });
    const turns = r.session.turns[Symbol.asyncIterator]();
    const turn1 = (await turns.next()).value as AsyncIterable<HarnessEvent>;
    r.proc.emitLine(init);
    r.proc.emitLine(result);
    await drainTurn(turn1);

    r.clock.advance(10_000); // idle between turns
    expect(r.logged.some((e) => e.event === "stall")).toBe(false);
  });
});

describe("T06: --provider reaches the session argv", () => {
  test("pi renders the provider selector on a session spawn", () => {
    const argv = buildSessionArgv(piCli, { sessionId: sid, provider: "lmstudio" });
    expect(argv).toContain("--provider");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("lmstudio");
  });

  test("a bare pi session renders no provider flag", () => {
    expect(buildSessionArgv(piCli, { sessionId: sid })).not.toContain("--provider");
  });

  test("a harness with no provider selector refuses, naming where it is supported", () => {
    try {
      buildSessionArgv(claudeCode, { sessionId: sid, provider: "lmstudio" });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgvRefusalError);
      const e = err as ArgvRefusalError;
      expect(e.option).toBe("provider");
      expect(e.message).toContain("provider");
    }
  });

  test("openSession passes the provider through to the spawned argv", () => {
    const proc = new FakeProcess();
    const spawner = fakeSpawner([proc]);
    openSession(
      piCli,
      { sessionId: sid, provider: "lmstudio" },
      { spawn: spawner.spawn, clock: new FakeClock(), signal: fakeSignal().signal },
    );
    expect(spawner.calls[0]?.argv).toContain("--provider");
  });
});
