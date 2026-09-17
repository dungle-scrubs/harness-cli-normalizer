/**
 * RFC-05 Phase 2: the cursor stream-json reader. Inputs are minimal
 * test-local records transcribed from the spike captures (probes 11, 11b,
 * 13, 15, 20, 43, 51, 52); Phase 4 does the full normalized fixture
 * capture. Session ids and paths here are fake and path-free.
 */
import { describe, expect, test } from "vitest";
import {
  contentEventsOf,
  contentEventsWithState,
  freshCursorReaderState,
} from "../../src/interpretation/content.js";

const sid = "11111111-2222-4333-8444-555555555555";

const assistant = (text: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  session_id: sid,
  ...extra,
});

describe("cursor non-text records", () => {
  test("user echo, thinking, and init emit nothing; liveness noise is progress", () => {
    expect(
      contentEventsOf("cursor", {
        type: "user",
        message: { role: "user", content: [] },
        session_id: sid,
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("cursor", {
        type: "thinking",
        subtype: "delta",
        text: "hmm",
        session_id: sid,
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("cursor", { type: "thinking", subtype: "completed", session_id: sid }),
    ).toEqual([]);
    expect(
      contentEventsOf("cursor", {
        type: "system",
        subtype: "init",
        session_id: sid,
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("cursor", { type: "retry", subtype: "attempt", session_id: sid }),
    ).toEqual([{ kind: "progress", label: "attempt" }]);
    expect(
      contentEventsOf("cursor", { type: "system", subtype: "task_notification", session_id: sid }),
    ).toEqual([{ kind: "progress", label: "task_notification" }]);
    expect(
      contentEventsOf("cursor", { type: "wobble", subtype: "unknown", session_id: sid }),
    ).toEqual([]);
  });
});

describe("cursor tool calls", () => {
  const started = (callId: string): Record<string, unknown> => ({
    type: "tool_call",
    subtype: "started",
    call_id: callId,
    tool_call: {
      readToolCall: { args: { path: "/tmp/ws/notes.txt" } },
      toolCallId: callId,
    },
    session_id: sid,
  });

  const completed = (callId: string, result: unknown): Record<string, unknown> => ({
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    tool_call: {
      readToolCall: { args: { path: "/tmp/ws/notes.txt" }, result },
      toolCallId: callId,
    },
    session_id: sid,
  });

  test("started emits one tool event and success completion emits nothing", () => {
    const first = contentEventsWithState("cursor", started("tool-1"), freshCursorReaderState());
    expect(first.events).toEqual([
      { kind: "tool", name: "readToolCall", input: { path: "/tmp/ws/notes.txt" } },
    ]);
    const second = contentEventsWithState(
      "cursor",
      completed("tool-1", { success: { content: "alpha" } }),
      first.state,
    );
    expect(second.events).toEqual([]);
  });

  test("rejected completion emits a denial error with the specified message", () => {
    const first = contentEventsWithState("cursor", started("tool-1"), freshCursorReaderState());
    const second = contentEventsWithState(
      "cursor",
      completed("tool-1", { rejected: { reason: "User Rejected" } }),
      first.state,
    );
    expect(second.events).toEqual([
      {
        kind: "error",
        message: "cursor denied readToolCall: User Rejected",
        denial: { tool: "readToolCall", reason: "User Rejected" },
      },
    ]);
  });

  test("an empty denial reason names itself", () => {
    const first = contentEventsWithState("cursor", started("tool-2"), freshCursorReaderState());
    const second = contentEventsWithState(
      "cursor",
      completed("tool-2", { rejected: { reason: "" } }),
      first.state,
    );
    expect(second.events).toEqual([
      {
        kind: "error",
        message: "cursor denied readToolCall (no reason given)",
        denial: { tool: "readToolCall", reason: "" },
      },
    ]);
  });
});

describe("cursor interaction queries", () => {
  // Probe 15 shape: toolCallId inside args for web tools.
  const webQuery = {
    type: "interaction_query",
    subtype: "request",
    query_type: "webSearchRequestQuery",
    query: {
      id: 1,
      webSearchRequestQuery: {
        args: { searchTerm: "example.com page title", toolCallId: "tool-9" },
      },
    },
    session_id: sid,
  };

  // Probe 20 shape: toolCallId as a sibling of args for ask/createPlan.
  const askQuery = {
    type: "interaction_query",
    subtype: "request",
    query_type: "askQuestionInteractionQuery",
    query: {
      id: 0,
      askQuestionInteractionQuery: {
        args: { title: "Which file?" },
        toolCallId: "tool-7",
      },
    },
    session_id: sid,
  };

  const unknownCompleted = (callId: string): Record<string, unknown> => ({
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    tool_call: {
      webSearchToolCall: { result: { rejected: { reason: "User Rejected" } } },
      toolCallId: callId,
    },
    session_id: sid,
  });

  test("query pairs emit nothing but feed unknown completions, both toolCallId paths", () => {
    const first = contentEventsWithState("cursor", webQuery, freshCursorReaderState());
    expect(first.events).toEqual([]);
    const second = contentEventsWithState("cursor", unknownCompleted("tool-9"), first.state);
    expect(second.events).toEqual([
      {
        kind: "tool",
        name: "webSearchToolCall",
        input: { searchTerm: "example.com page title", toolCallId: "tool-9" },
      },
      {
        kind: "error",
        message: "cursor denied webSearchToolCall: User Rejected",
        denial: { tool: "webSearchToolCall", reason: "User Rejected" },
      },
    ]);
    const askFirst = contentEventsWithState("cursor", askQuery, freshCursorReaderState());
    expect(askFirst.events).toEqual([]);
    if (askFirst.state === null) throw new Error("expected cursor reader state");
    expect(askFirst.state.queryArgs).toEqual([
      { toolCallId: "tool-7", args: { title: "Which file?" } },
    ]);
  });

  test("an unknown success completion emits the tool event only, with empty input", () => {
    const done = contentEventsWithState(
      "cursor",
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "tool-new",
        tool_call: {
          shellToolCall: { result: { success: { exitCode: 0 } } },
          toolCallId: "tool-new",
        },
        session_id: sid,
      },
      freshCursorReaderState(),
    );
    expect(done.events).toEqual([{ kind: "tool", name: "shellToolCall" }]);
  });
});

describe("cursor reader state", () => {
  const okCompleted = (callId: string): Record<string, unknown> => ({
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    tool_call: {
      shellToolCall: { result: { success: { exitCode: 0 } } },
      toolCallId: callId,
    },
    session_id: sid,
  });

  test("tombstoned ids never re-emit a tool event", () => {
    const start = contentEventsWithState(
      "cursor",
      {
        type: "tool_call",
        subtype: "started",
        call_id: "tool-t",
        tool_call: { shellToolCall: { args: { command: "ls" } }, toolCallId: "tool-t" },
        session_id: sid,
      },
      freshCursorReaderState(),
    );
    const done = contentEventsWithState("cursor", okCompleted("tool-t"), start.state);
    expect(done.events).toEqual([]);
    // A duplicate completion for the settled id emits nothing on success...
    const dup = contentEventsWithState("cursor", okCompleted("tool-t"), done.state);
    expect(dup.events).toEqual([]);
    // ...and the denial error alone on rejection, never a second tool event.
    const denied = contentEventsWithState(
      "cursor",
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "tool-t",
        tool_call: {
          shellToolCall: { result: { rejected: { reason: "User Rejected" } } },
          toolCallId: "tool-t",
        },
        session_id: sid,
      },
      done.state,
    );
    expect(denied.events).toEqual([
      {
        kind: "error",
        message: "cursor denied shellToolCall: User Rejected",
        denial: { tool: "shellToolCall", reason: "User Rejected" },
      },
    ]);
  });

  test("completing 128 calls never evicts the tombstoned id: no second tool event", () => {
    // L1: start 129 calls so c0 is evicted into the tombstones, complete
    // c1..c128, then complete c0. Completions must not push the evicted
    // id out, or c0's completion emits a second tool event.
    const started = (callId: string): Record<string, unknown> => ({
      type: "tool_call",
      subtype: "started",
      call_id: callId,
      tool_call: { shellToolCall: { args: {} }, toolCallId: callId },
      session_id: sid,
    });
    let state = freshCursorReaderState();
    for (let i = 0; i < 129; i++) {
      const out = contentEventsWithState("cursor", started(`c${i}`), state);
      if (out.state === null) throw new Error("expected cursor reader state");
      state = out.state;
    }
    for (let i = 1; i < 129; i++) {
      const out = contentEventsWithState("cursor", okCompleted(`c${i}`), state);
      if (out.state === null) throw new Error("expected cursor reader state");
      expect(out.events).toEqual([]);
      state = out.state;
    }
    const late = contentEventsWithState("cursor", okCompleted("c0"), state);
    expect(late.events).toEqual([]);
  });

  test("pending and tombstones hold 128 entries with drop-oldest into tombstones", () => {
    let state = freshCursorReaderState();
    for (let i = 0; i < 130; i++) {
      const out = contentEventsWithState(
        "cursor",
        {
          type: "tool_call",
          subtype: "started",
          call_id: `tool-${i}`,
          tool_call: { shellToolCall: { args: {} }, toolCallId: `tool-${i}` },
          session_id: sid,
        },
        state,
      );
      if (out.state === null) throw new Error("expected cursor reader state");
      state = out.state;
    }
    expect(state.pending).toHaveLength(128);
    expect(state.pending).not.toContain("tool-0");
    expect(state.tombstones).toContain("tool-0");
    expect(state.tombstones).toContain("tool-1");
  });
});

describe("cursor result records", () => {
  test("success ends the turn with no event; failures are terminal errors", () => {
    expect(
      contentEventsOf("cursor", {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: sid,
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("cursor", {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "boom",
        session_id: sid,
      }),
    ).toEqual([{ kind: "error", message: "cursor turn failed: success", terminal: true }]);
    expect(
      contentEventsOf("cursor", {
        type: "result",
        subtype: "tool_denied",
        is_error: false,
        session_id: sid,
      }),
    ).toEqual([{ kind: "error", message: "cursor turn failed: tool_denied", terminal: true }]);
  });

  test("a completion with neither success nor rejected is ignored", () => {
    expect(
      contentEventsOf("cursor", {
        type: "tool_call",
        subtype: "completed",
        call_id: "tool-x",
        tool_call: { shellToolCall: { result: {} }, toolCallId: "tool-x" },
        session_id: sid,
      }),
    ).toEqual([]);
  });
});

describe("cursor assistant records", () => {
  test("timestamp without model_call_id is a token; with it, or without timestamp, a message", () => {
    expect(contentEventsOf("cursor", assistant(" runs", { timestamp_ms: 1 }))).toEqual([
      { kind: "token", text: " runs" },
    ]);
    expect(
      contentEventsOf("cursor", assistant("pre-tool", { model_call_id: "m", timestamp_ms: 1 })),
    ).toEqual([{ kind: "message", role: "assistant", text: "pre-tool" }]);
    expect(contentEventsOf("cursor", assistant("flush"))).toEqual([
      { kind: "message", role: "assistant", text: "flush" },
    ]);
  });
});
