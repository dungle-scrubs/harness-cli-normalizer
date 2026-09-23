import { describe, expect, test } from "vitest";
import { museCompactionOf, museViewPageOf } from "../../src/interpretation/muse-compaction.js";

/**
 * ADR 0009, muse's mapping (#241). The items below are quoted verbatim
 * from the 1.3.0-R3401.1 probe in
 * `docs/research/2026-09-22-compaction-signals/muse/`, which captured the
 * MSP view's started/completed pair for one compaction of 68,376 tokens
 * down to 22,388.
 */

const sessionId = "2cf3841d-2128-4da8-b3c4-905cf06d9975";
const itemId = "9e1e3266-528f-4192-97cd-627deda523c1";
const turnId = "b855aea7-4d38-431b-b9ce-55145cfb2576";

const startedItem = {
  itemId,
  kind: "compaction",
  turnId,
  revision: 1,
  status: "inProgress",
  recordedAt: "2026-09-22T09:42:21.975079Z",
  fallbackText: "Context compaction",
  trigger: "auto",
  tokensBefore: 68376,
};

const completedItem = {
  itemId,
  kind: "compaction",
  turnId,
  revision: 2,
  status: "completed",
  recordedAt: "2026-09-22T09:42:21.979277Z",
  fallbackText: "Context compaction",
  outcome: "compacted",
  trigger: "auto",
  strategyId: "summary-preserved-suffix/v1",
  summarizedThrough: `run:${turnId}:seq:0`,
  tokensBefore: 68376,
  tokensAfter: 22388,
};

describe("museCompactionOf", () => {
  test("the completed half carries the outcome and the counts muse measured", () => {
    expect(museCompactionOf(completedItem)).toEqual({
      itemId,
      state: "compacted",
      trigger: "auto",
      tokensBefore: 68376,
      tokensAfter: 22388,
    });
  });

  test("the inProgress half reports nothing, so muse announces no start", () => {
    // `outcome` is documented terminal-only. Reporting the started half
    // would give a `started` muse never actually announces, and a second
    // event for one compaction.
    expect(museCompactionOf(startedItem)).toBeNull();
  });

  test("cancelled is translated to aborted; the other three names agree", () => {
    const stateOf = (outcome: string) =>
      museCompactionOf({ ...completedItem, outcome })?.state ?? null;
    expect(stateOf("compacted")).toBe("compacted");
    expect(stateOf("noop")).toBe("noop");
    expect(stateOf("failed")).toBe("failed");
    // muse's word is `cancelled`; ADR 0009's word is `aborted`.
    expect(stateOf("cancelled")).toBe("aborted");
  });

  test("the harness's own reason rides as detail, verbatim", () => {
    expect(
      museCompactionOf({
        itemId,
        kind: "compaction",
        outcome: "noop",
        reason: "no_compactable_history",
      }),
    ).toEqual({ itemId, state: "noop", detail: "no_compactable_history" });
  });

  test("a cancelled compaction reports aborted, carrying muse's own reason", () => {
    expect(
      museCompactionOf({
        ...completedItem,
        outcome: "cancelled",
        reason: "superseded_by_newer_request",
        tokensAfter: undefined,
      }),
    ).toEqual({
      itemId,
      state: "aborted",
      trigger: "auto",
      tokensBefore: 68376,
      detail: "superseded_by_newer_request",
    });
  });

  test("an outcome this version has no arm for reports nothing rather than guessing", () => {
    // The schema declares CompactionOutcome `x-msp-openness: open`, so a
    // later muse can add a word. An unknown one must not become a state.
    expect(museCompactionOf({ ...completedItem, outcome: "sideways" })).toBeNull();
    expect(museCompactionOf({ ...completedItem, trigger: "sideways" })).toEqual({
      itemId,
      state: "compacted",
      tokensBefore: 68376,
      tokensAfter: 22388,
    });
  });

  test("a non-compaction item, or one with no identity, reports nothing", () => {
    expect(museCompactionOf({ itemId, kind: "approval", outcome: "compacted" })).toBeNull();
    expect(museCompactionOf({ kind: "compaction", outcome: "compacted" })).toBeNull();
    expect(museCompactionOf({ itemId: "", kind: "compaction", outcome: "compacted" })).toBeNull();
    expect(museCompactionOf(null)).toBeNull();
    expect(museCompactionOf("compaction")).toBeNull();
  });

  test("counts that are not finite numbers are dropped, not coerced", () => {
    expect(
      museCompactionOf({ ...completedItem, tokensBefore: "lots", tokensAfter: Number.NaN }),
    ).toEqual({ itemId, state: "compacted", trigger: "auto" });
  });
});

describe("museViewPageOf", () => {
  test("a page yields its terminal compactions in view order, with the next cursor", () => {
    const page = museViewPageOf({
      sessionId,
      nextCursor: `v:${sessionId}:7`,
      items: [
        { item: { itemId: "other", kind: "approval" } },
        { item: startedItem },
        { item: completedItem },
      ],
    });
    expect(page?.compactions.map((c) => c.state)).toEqual(["compacted"]);
    expect(page?.nextCursor).toBe(`v:${sessionId}:7`);
  });

  test("an item carried inline, not under `item`, is read the same way", () => {
    const page = museViewPageOf({ items: [completedItem], viewCursor: `v:${sessionId}:7` });
    expect(page?.compactions).toHaveLength(1);
    expect(page?.nextCursor).toBe(`v:${sessionId}:7`);
  });

  test("a page hcn cannot read returns null, never an empty page", () => {
    // Null is a skipped sample. An empty page would falsely advance the
    // fold past a compaction it never actually read.
    expect(museViewPageOf({ sessionId })).toBeNull();
    expect(museViewPageOf(null)).toBeNull();
    expect(museViewPageOf({ items: "nope" })).toBeNull();
    expect(museViewPageOf({ items: [] })).toEqual({ compactions: [], nextCursor: null });
  });
});

describe("muse stdout is not a compaction signal", () => {
  test("the failure prose stays a generic native error, never a compaction event", async () => {
    // The one compaction-shaped thing on muse's stdout is a prose string
    // in a general-purpose failure field: no kind, no trigger, no outcome.
    // Matching on it would report a compaction from a sentence, and would
    // report nothing at all for the successful case - stdout is silent
    // there. Quoted verbatim from the probe.
    const { contentEventsOf } = await import("../../src/interpretation/content.js");
    const failed = {
      payload_type: "run.terminal.failed",
      payload: {
        kind: "run_terminal",
        terminal: "failed",
        text: "",
        reason:
          "context compaction replacement still exceeds the hard threshold (22132 >= 20480 tokens)",
      },
    };
    const events = contentEventsOf("muse", failed);
    expect(events.some((e) => e.kind === "compaction")).toBe(false);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });
});
