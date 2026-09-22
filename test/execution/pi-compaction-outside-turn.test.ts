import { describe, expect, test } from "vitest";
import { DROPPABLE_KINDS, type HarnessEvent } from "../../src/execution/events.js";
import { openSession } from "../../src/execution/open-session.js";
import { piCli } from "../../src/knowledge/pi.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

/**
 * ADR 0009 / #239, the acceptance criterion the unit tests cannot reach: a
 * threshold compaction that runs OUTSIDE the turn markers still produces
 * events.
 *
 * pi checks its threshold before a new user prompt and again after a run
 * ends, so a compaction can land before any `agent_start` - probe E
 * observed exactly that, at 0.619 s against an `agent_start` at 9.698 s
 * (docs/research/2026-09-22-compaction-signals/pi). A consumer keyed on
 * turn boundaries would miss it.
 *
 * openSession buffers between-turn events and hands them to the next turn.
 * That buffer is bounded and sheds droppable events first, which is why
 * `compaction` being lossless is load-bearing here, not a detail.
 */

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

const drainTurn = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const makeDeps = (proc: FakeProcess) => {
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const clock = new FakeClock();
  return { spawn: spawner.spawn, clock, signal: sig.signal, spawner, sig };
};

describe("pi compaction outside the turn markers (#239)", () => {
  test("a compaction that runs before any turn is delivered to the next turn", async () => {
    const proc = new FakeProcess();
    const d = makeDeps(proc);
    const session = openSession(piCli, { sessionId: sid }, d);

    // The crossing, before anything is sent: no turn is active, so these
    // land in the between-turn buffer rather than on a turn.
    proc.emitLine(JSON.stringify({ type: "compaction_start", reason: "threshold" }));
    proc.emitLine(
      JSON.stringify({
        type: "compaction_end",
        reason: "threshold",
        result: { tokensBefore: 58656, estimatedTokensAfter: 39452 },
        aborted: false,
      }),
    );

    session.send({ id: "s", text: "hi" });
    const turnsIter = session.turns[Symbol.asyncIterator]();
    const turn1 = (await turnsIter.next()).value as AsyncIterable<HarnessEvent>;
    proc.emitLine(JSON.stringify({ type: "agent_settled" }));
    const events = await drainTurn(turn1);

    const compactions = events.filter((e) => e.kind === "compaction");
    expect(compactions).toEqual([
      { kind: "compaction", state: "started", trigger: "auto" },
      {
        kind: "compaction",
        state: "compacted",
        trigger: "auto",
        tokensBefore: 58656,
        tokensAfter: 39452,
      },
    ]);
    await session.close();
  });

  test("compaction is not droppable, so the bounded between-turn buffer keeps it", () => {
    // The buffer sheds DROPPABLE_KINDS first when it overflows. If
    // `compaction` were listed there, a busy pre-turn window would discard
    // the one event that tells a caller its history was replaced.
    expect(DROPPABLE_KINDS.has("compaction")).toBe(false);
    expect([...DROPPABLE_KINDS].sort()).toEqual(["progress", "token"]);
  });
});
