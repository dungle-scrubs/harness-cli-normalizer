/**
 * RFC-05 Phase 3: cursor decoder wiring at the execution seam. The cursor
 * reader (Phase 2) reports denied calls as error events with a structured
 * `denial` payload; decode threads that payload onto the shared HarnessEvent
 * error (machine consumers branch on `denial !== undefined`, never prose)
 * and threads the opaque per-reader state across lines of one turn through
 * one generically-named DecodeState slot.
 */
import { describe, expect, test } from "vitest";
import { decodeParsed, freshDecodeState } from "../../src/execution/decode.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const rejectedCompletion = (callId: string): Record<string, unknown> => ({
  type: "tool_call",
  subtype: "completed",
  call_id: callId,
  tool_call: {
    webSearchToolCall: {
      args: { query: "hcn" },
      result: { rejected: { reason: "needs approval" } },
    },
  },
});

describe("decode cursor denials", () => {
  test("a rejected completion surfaces tool plus error with the denial payload", () => {
    const events = decodeParsed(cursorCli, rejectedCompletion("call-1"), freshDecodeState(), "");
    expect(events.map((e) => e.kind)).toEqual(["tool", "error"]);
    const error = events[1];
    if (error?.kind !== "error") throw new Error("expected an error event");
    expect(error.message).toBe("cursor denied webSearchToolCall: needs approval");
    expect(error.denial).toEqual({ tool: "webSearchToolCall", reason: "needs approval" });
  });

  test("started then completed for one call id emits one tool event, never two", () => {
    const state = freshDecodeState();
    const started: Record<string, unknown> = {
      type: "tool_call",
      subtype: "started",
      call_id: "call-9",
      tool_call: { shellToolCall: { args: { command: "ls" } } },
    };
    const completed: Record<string, unknown> = {
      type: "tool_call",
      subtype: "completed",
      call_id: "call-9",
      tool_call: { shellToolCall: { result: { rejected: { reason: "" } } } },
    };
    const first = decodeParsed(cursorCli, started, state, "");
    const second = decodeParsed(cursorCli, completed, state, "");
    expect(first.map((e) => e.kind)).toEqual(["tool"]);
    expect(second.map((e) => e.kind)).toEqual(["error"]);
    const denial = second[0];
    if (denial?.kind !== "error") throw new Error("expected an error event");
    expect(denial.message).toBe("cursor denied shellToolCall (no reason given)");
    expect(denial.denial).toEqual({ tool: "shellToolCall", reason: "" });
  });
});
