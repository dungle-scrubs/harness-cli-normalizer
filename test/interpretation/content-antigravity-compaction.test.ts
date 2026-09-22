import { describe, expect, test } from "vitest";
import { contentEventsOf } from "../../src/interpretation/content.js";

/**
 * ADR 0009, antigravity's mapping (#240). The records below are quoted
 * verbatim from the 1.2.8 probe in
 * `docs/research/2026-09-22-compaction-signals/antigravity/`. All four
 * compactions in that 8-turn run emitted exactly this shape and nothing
 * else: one `checkpoint` step in state DONE, carrying a duration and no
 * other payload.
 */

const conversation = "a38ad966-490f-4f6f-9a5f-607595a0175f";

const checkpoint = (step_index: number, duration_seconds: number) => ({
  event: "step_update",
  step_update: {
    conversation_id: conversation,
    step_index,
    state: "DONE",
    step_type: "checkpoint",
    duration_seconds,
  },
});

describe("antigravity compaction decoding", () => {
  test("a DONE checkpoint reports compacted, with the duration in milliseconds", () => {
    // Antigravity reports seconds; the event's unit is milliseconds.
    expect(contentEventsOf("antigravity", checkpoint(3, 5.026148))).toEqual([
      { kind: "compaction", state: "compacted", durationMs: 5026 },
    ]);
    expect(contentEventsOf("antigravity", checkpoint(8, 18.412776))).toEqual([
      { kind: "compaction", state: "compacted", durationMs: 18413 },
    ]);
  });

  test("all four compactions from the probe decode, and none emits a started", () => {
    const observed = [
      checkpoint(3, 5.026148),
      checkpoint(8, 18.412776),
      checkpoint(13, 6.34049),
      checkpoint(18, 10.89551),
    ].flatMap((r) => contentEventsOf("antigravity", r));
    expect(observed).toHaveLength(4);
    expect(observed.every((e) => e.kind === "compaction" && e.state === "compacted")).toBe(true);
    // Antigravity announces no start. There is no ACTIVE phase on the
    // record, so a caller gets the end and nothing before it.
    expect(observed.some((e) => e.kind === "compaction" && e.state === "started")).toBe(false);
  });

  test("a checkpoint that is not DONE reports nothing", () => {
    // DONE is the record's own completion evidence, and the only outcome
    // evidence it carries. Anything else is not a finished compaction.
    for (const state of ["ACTIVE", "ERROR", "PENDING"]) {
      expect(
        contentEventsOf("antigravity", {
          event: "step_update",
          step_update: {
            conversation_id: conversation,
            step_index: 3,
            state,
            step_type: "checkpoint",
          },
        }),
      ).toEqual([]);
    }
  });

  test("a checkpoint with no duration still reports the state and invents no number", () => {
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          conversation_id: conversation,
          step_index: 3,
          state: "DONE",
          step_type: "checkpoint",
        },
      }),
    ).toEqual([{ kind: "compaction", state: "compacted" }]);
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          conversation_id: conversation,
          step_index: 3,
          state: "DONE",
          step_type: "checkpoint",
          duration_seconds: "ages",
        },
      }),
    ).toEqual([{ kind: "compaction", state: "compacted" }]);
  });

  test("a token drop with no checkpoint record produces no compaction event", () => {
    // The token count drops with and without compaction, so reading it as a
    // signal would report compactions that never ran. Nothing here treats
    // usage as evidence.
    const usageOnly = {
      event: "step_update",
      step_update: {
        conversation_id: conversation,
        step_index: 4,
        state: "DONE",
        step_type: "agent_response",
        usage: { input_tokens: 120, output_tokens: 4, total_tokens: 124 },
      },
    };
    expect(contentEventsOf("antigravity", usageOnly)).toEqual([]);
    const resultUsage = {
      event: "result",
      result: {
        status: "SUCCESS",
        response: "done",
        usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
      },
    };
    expect(contentEventsOf("antigravity", resultUsage)).toEqual([
      { kind: "message", role: "assistant", text: "done" },
    ]);
  });

  test("the records antigravity already decoded are untouched", () => {
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "WF235-MARK-02" },
      }),
    ).toEqual([{ kind: "token", text: "WF235-MARK-02" }]);
    expect(
      contentEventsOf("antigravity", {
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_info: { name: "read_file", parameters: { path: "a.txt" } },
        },
      }),
    ).toEqual([{ kind: "tool", name: "read_file", input: { path: "a.txt" } }]);
  });
});
