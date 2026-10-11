/**
 * ADR 0009 / #241, seam 2: the MSP view fold that reports muse compaction.
 *
 * `muse exec --json` carries no compaction signal, so the event comes off
 * the same `muse serve` helper the approval observer already runs. This
 * file pins the two properties that make that safe: one compaction reports
 * once across repeated pages, and the fold never decides a turn.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { watchMuseApprovals } from "../../src/execution/muse-approvals.js";
import type { MuseCompaction } from "../../src/interpretation/muse-compaction.js";
import { FakeClock, FakeProcess, fakeSignal, fakeSpawner } from "./fakes.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

const sessionId = "2cf3841d-2128-4da8-b3c4-905cf06d9975";
const itemId = "9e1e3266-528f-4192-97cd-627deda523c1";

const completedItem = {
  itemId,
  kind: "compaction",
  revision: 2,
  status: "completed",
  outcome: "compacted",
  trigger: "auto",
  tokensBefore: 68376,
  tokensAfter: 22388,
};

const setup = () => {
  const proc = new FakeProcess({ exitOnStdinEnd: false });
  const clock = new FakeClock();
  const sig = fakeSignal({ autoExit: true });
  const spawner = fakeSpawner([proc]);
  const compactions: MuseCompaction[] = [];
  let unavailable = 0;
  let incompatible = 0;
  const watch = watchMuseApprovals(
    "/selected/muse",
    { cwd: "/work" },
    { clock, signal: sig.signal, spawn: spawner.spawn },
    "native-session",
    () => {},
    () => {
      unavailable += 1;
    },
    () => {
      incompatible += 1;
    },
    (found) => compactions.push(found),
  );
  const reply = (id: number, result: unknown): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", result }));
  const replyError = (id: number | string, code: number): void =>
    proc.emitLine(JSON.stringify({ id, jsonrpc: "2.0", error: { code, message: "probe" } }));
  /** #241: view replies carry their own string id space, so they never
   * occupy a slot in the approval poll sequence. */
  const replyView = (n: number, result: unknown): void =>
    proc.emitLine(JSON.stringify({ id: `v${n}`, jsonrpc: "2.0", result }));
  const emptyApprovals = { approvals: [], userInputs: [] };
  return {
    proc,
    clock,
    watch,
    reply,
    replyError,
    replyView,
    compactions,
    emptyApprovals,
    unavailable: () => unavailable,
    incompatible: () => incompatible,
  };
};

describe("the MSP view fold (#241)", () => {
  test("current native unframed view events report pre-attach compactions", async () => {
    const replies = readFileSync(
      new URL("../fixtures/muse-1.4.2-R4684.1/msp-attachment.ndjson", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const page = replies.find((reply) => reply.id === "view-0").result;
    const s = setup();
    s.reply(1, {});
    await flush();
    s.replyView(1, page);
    await flush();
    expect(s.compactions.map(({ itemId, state }) => ({ itemId, state }))).toEqual([
      { itemId: "b4551911-b203-4cd5-a458-e37f7d27c139", state: "failed" },
      { itemId: "76ce84ad-0d28-4b34-9070-65d36971f6ea", state: "compacted" },
      { itemId: "9c258731-c4f5-44a9-baab-0ce148bf7af9", state: "compacted" },
      { itemId: "7511d232-89f9-49f3-90a1-7426bca4c00a", state: "noop" },
      { itemId: "75d67d22-ee8f-4015-abda-cb691c452aeb", state: "compacted" },
      { itemId: "4003ca52-0698-4675-bf4c-a66e1e5f7c8e", state: "compacted" },
      { itemId: "15ef44f7-779b-4261-a8cb-892916bbfc52", state: "noop" },
      { itemId: "76e15863-b907-4feb-930b-75caefd09088", state: "aborted" },
      { itemId: "bac368e3-9c3f-4a13-b0b0-210f89b5170f", state: "compacted" },
      { itemId: "08f1af12-21d8-4961-ad36-8c8a13fe6275", state: "compacted" },
      { itemId: "15f3e468-da81-4877-a4d7-61e140141f18", state: "noop" },
      { itemId: "ab66c025-97d4-474e-94af-03c009c76321", state: "compacted" },
      { itemId: "65ee86df-9f42-4e4e-a11c-74f2c709ee0a", state: "failed" },
    ]);
    expect(s.compactions).toContainEqual({
      itemId: "76ce84ad-0d28-4b34-9070-65d36971f6ea",
      state: "compacted",
      trigger: "auto",
      tokensBefore: 91110,
      tokensAfter: 24957,
    });
    expect(s.unavailable()).toBe(0);
    expect(s.incompatible()).toBe(0);
    await s.watch.close();
  });

  test("native events require the completed-item method and tolerate malformed unrelated entries", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    s.replyView(1, {
      events: [
        null,
        { method: "item/completed", params: null },
        { method: "item/completed" },
        { method: "future/event", params: { item: { ...completedItem, itemId: "wrong-method" } } },
        { method: "item/started", params: { item: { ...completedItem, itemId: "wrong-phase" } } },
        { method: "item/completed", params: { item: completedItem } },
      ],
      nextCursor: `v:${sessionId}:7`,
    });
    await flush();
    expect(s.compactions).toEqual([
      {
        itemId,
        state: "compacted",
        trigger: "auto",
        tokensBefore: 68376,
        tokensAfter: 22388,
      },
    ]);
    expect(s.unavailable()).toBe(0);
    expect(s.incompatible()).toBe(0);
    s.reply(2, s.emptyApprovals);
    await flush();
    s.clock.advance(1_000);
    await flush();
    const viewCalls = s.proc.stdinWrites
      .map((wire) => JSON.parse(wire))
      .filter((wire) => wire.method === "view/page");
    expect(viewCalls).toHaveLength(2);
    expect(viewCalls[1].params.cursor).toBe(`v:${sessionId}:7`);
    expect(viewCalls[1].params.limit).toBeGreaterThanOrEqual(1);
    expect(viewCalls[1].params.limit).toBeLessThanOrEqual(1000);
    await s.watch.close();
  });

  test("a compaction on the view is reported with its counts, once", async () => {
    const s = setup();
    s.reply(1, {}); // initialize
    await flush();
    // The first approval poll fires a view page beside it.
    s.replyView(1, { items: [{ item: completedItem }], nextCursor: `v:${sessionId}:7` });
    await flush();

    expect(s.compactions).toEqual([
      {
        itemId,
        state: "compacted",
        trigger: "auto",
        tokensBefore: 68376,
        tokensAfter: 22388,
      },
    ]);
    await s.watch.close();
  });

  test("the same item on a later, overlapping page is not reported twice", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    s.replyView(1, { items: [{ item: completedItem }], nextCursor: `v:${sessionId}:7` });
    await flush();
    // The next poll pages again and the same item comes back, which is
    // what an overlapping or replayed page looks like.
    s.reply(2, s.emptyApprovals);
    await flush();
    s.clock.advance(1_000);
    await flush();
    s.replyView(2, { items: [{ item: completedItem }], nextCursor: `v:${sessionId}:7` });
    await flush();

    expect(s.compactions).toHaveLength(1);
    await s.watch.close();
  });

  test("the first page is taken with NO anchor, so a pre-turn compaction is not missed", async () => {
    // Muse compacts pre-turn and blocking; this observer starts on the
    // identity event, so the compaction is already over. The view is a
    // durable cursor-paged log, and a first page with no anchor returns
    // items recorded before attach. `anchor: "latestCompaction"` would
    // resolve to the boundary and page strictly after it, excluding the
    // compaction item itself.
    const s = setup();
    s.reply(1, {});
    await flush();

    const sent = s.proc.stdinWrites.map((w) => JSON.parse(w) as Record<string, unknown>);
    const viewCall = sent.find((v) => v.method === "view/page");
    expect(viewCall).toBeDefined();
    expect(viewCall?.jsonrpc).toBe("2.0");
    const params = viewCall?.params as Record<string, unknown>;
    expect(params.limit).toBe(1000);
    expect(params.anchor).toBeUndefined();
    expect(params.cursor).toBeUndefined();
    await s.watch.close();
  });

  test("the cursor advances, so the next page resumes where the last one ended", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    s.replyView(1, { items: [], nextCursor: `v:${sessionId}:7` });
    await flush();
    s.reply(2, s.emptyApprovals);
    await flush();
    s.clock.advance(1_000);
    await flush();

    const sent = s.proc.stdinWrites.map((w) => JSON.parse(w) as Record<string, unknown>);
    const viewCalls = sent.filter((v) => v.method === "view/page");
    expect(viewCalls).toHaveLength(2);
    const second = viewCalls[1]?.params as Record<string, unknown> | undefined;
    expect(second?.cursor).toBe(`v:${sessionId}:7`);
    await s.watch.close();
  });

  test("a muse with no view/page turns the fold off and keeps supervising approvals", async () => {
    // This is a muse without the compaction surface, not a muse hcn cannot
    // supervise. Ending the turn as an incompatible surface would be a
    // regression against every such build.
    const s = setup();
    s.reply(1, {});
    await flush();
    s.replyError("v1", -32601); // method not found, on view/page
    await flush();

    expect(s.incompatible()).toBe(0);
    expect(s.unavailable()).toBe(0);

    // The next cycle polls approvals and asks for no further view page.
    s.clock.advance(1_000);
    await flush();
    const methods = s.proc.stdinWrites
      .map((w) => (JSON.parse(w) as Record<string, unknown>).method)
      .filter((m) => m === "view/page");
    expect(methods).toHaveLength(1);
    await s.watch.close();
  });

  test("a malformed view page is skipped, and never counts toward the approval verdict", async () => {
    const s = setup();
    s.reply(1, {});
    await flush();
    for (let cycle = 0; cycle < 4; cycle++) {
      s.replyView(cycle + 1, { items: "nonsense" });
      await flush();
      s.reply(2 + cycle, s.emptyApprovals);
      await flush();
      s.clock.advance(1_000);
      await flush();
    }
    // Four unreadable pages in a row - well past MAX_UNREADABLE_POLLS,
    // which is the approval observer's fail-closed threshold.
    expect(s.unavailable()).toBe(0);
    expect(s.incompatible()).toBe(0);
    expect(s.compactions).toEqual([]);
    await s.watch.close();
  });

  test("native 1.4.4 approval errors fail closed even with a completed compaction", async () => {
    const replies = readFileSync(
      new URL("../fixtures/muse-1.4.4-R5419.1/msp-approval-failure.ndjson", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n");
    const items = JSON.parse(
      readFileSync(
        new URL("../fixtures/muse-1.4.4-R5419.1/compaction-items.snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const s = setup();
    s.reply(1, {});
    await flush();
    for (const [index, line] of replies.entries()) {
      s.proc.emitLine(line);
      s.replyView(index + 1, { items, nextCursor: null });
      await flush();
      s.clock.advance(1_000);
      await flush();
    }
    expect(s.unavailable()).toBe(1);
    expect(s.incompatible()).toBe(0);
    expect(s.compactions).toHaveLength(1);
    expect(s.compactions[0]).toMatchObject({ state: "compacted", tokensAfter: 25861 });
    await s.watch.close();
  });

  test("with no sink the helper never asks for a view page at all", async () => {
    const proc = new FakeProcess({ exitOnStdinEnd: false });
    const clock = new FakeClock();
    const spawner = fakeSpawner([proc]);
    const watch = watchMuseApprovals(
      "/selected/muse",
      { cwd: "/work" },
      { clock, signal: fakeSignal({ autoExit: true }).signal, spawn: spawner.spawn },
      "native-session",
      () => {},
      () => {},
    );
    proc.emitLine(JSON.stringify({ id: 1, jsonrpc: "2.0", result: {} }));
    await flush();
    await flush();
    const methods = proc.stdinWrites.map((w) => (JSON.parse(w) as Record<string, unknown>).method);
    expect(methods).not.toContain("view/page");
    await watch.close();
  });
});
