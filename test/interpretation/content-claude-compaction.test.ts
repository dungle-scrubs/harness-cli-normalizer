import { describe, expect, test } from "vitest";
import { contentEventsOf } from "../../src/interpretation/content.js";

/**
 * ADR 0009, claude's mapping. Every record below is a real one, quoted from
 * the 2.1.278 probe in `docs/research/2026-09-22-compaction-signals/claude/`.
 * The decoder reads one record at a time and holds no state between them, so
 * exactly one record has to produce the end event.
 */

const boundary = {
  type: "system",
  subtype: "compact_boundary",
  uuid: "6e3ba91d-a99c-471a-88ac-7eff80fa2fb5",
  compact_metadata: {
    trigger: "auto",
    pre_tokens: 42375,
    post_tokens: 1793,
    cumulative_dropped_tokens: 40582,
    duration_ms: 25052,
  },
  session_id: "146fcef1-dce9-46f3-857b-b3d76d3bf358",
};

const startedStatus = {
  type: "system",
  subtype: "status",
  status: "compacting",
  session_id: "146fcef1-dce9-46f3-857b-b3d76d3bf358",
  uuid: "a6488b40-4803-44dd-b92b-29ca8beb9c52",
};

const successStatus = {
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "success",
  session_id: "146fcef1-dce9-46f3-857b-b3d76d3bf358",
  uuid: "2126b7ec-2d9a-4056-bb8f-c9015ebce8cb",
};

describe("claude compaction decoding", () => {
  test("the compacting status opens the pause", () => {
    expect(contentEventsOf("claude", startedStatus)).toEqual([
      { kind: "compaction", state: "started" },
    ]);
  });

  test("the boundary record carries the end, with the counts claude reported", () => {
    expect(contentEventsOf("claude", boundary)).toEqual([
      {
        kind: "compaction",
        state: "compacted",
        trigger: "auto",
        tokensBefore: 42375,
        tokensAfter: 1793,
        durationMs: 25052,
      },
    ]);
  });

  test("the success status is silent, so one compaction yields one end", () => {
    // Emitting this as well as the boundary would give two ends for one
    // compaction, and a caller counting boundaries would double-count.
    expect(contentEventsOf("claude", successStatus)).toEqual([]);

    const crossing = [startedStatus, successStatus, boundary].flatMap((r) =>
      contentEventsOf("claude", r),
    );
    expect(crossing.map((e) => (e.kind === "compaction" ? e.state : e.kind))).toEqual([
      "started",
      "compacted",
    ]);
  });

  test("a failed compaction reports the harness's own error text as detail", () => {
    expect(
      contentEventsOf("claude", {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "summary exceeded the window",
      }),
    ).toEqual([{ kind: "compaction", state: "failed", detail: "summary exceeded the window" }]);
  });

  test("compaction records no longer surface as progress labels", () => {
    // They did before ADR 0009. The map's charting decision was that the new
    // event replaces the label rather than riding beside it.
    for (const record of [startedStatus, successStatus, boundary]) {
      expect(contentEventsOf("claude", record).filter((e) => e.kind === "progress")).toEqual([]);
    }
  });

  test("a non-compaction system record keeps its droppable progress label", () => {
    // `status: "requesting"` was observed on the same turn as a compaction
    // and is not one, so it must not be swallowed by the compaction arms.
    expect(
      contentEventsOf("claude", { type: "system", subtype: "status", status: "requesting" }),
    ).toEqual([{ kind: "progress", label: "status" }]);
    expect(
      contentEventsOf("claude", { type: "system", subtype: "hook_started", hook_name: "x" }),
    ).toEqual([{ kind: "progress", label: "hook_started" }]);
  });

  test("a boundary with no metadata still reports the state, and invents no numbers", () => {
    expect(contentEventsOf("claude", { type: "system", subtype: "compact_boundary" })).toEqual([
      { kind: "compaction", state: "compacted" },
    ]);
    expect(
      contentEventsOf("claude", {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "sideways", pre_tokens: "lots" },
      }),
    ).toEqual([{ kind: "compaction", state: "compacted" }]);
  });
});
