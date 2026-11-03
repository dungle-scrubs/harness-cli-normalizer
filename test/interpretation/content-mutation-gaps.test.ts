/**
 * Mutation-gap regressions for the content lane.
 *
 * Codex session echoes stay out of tool activity; app-server tool names
 * share the exec vocabulary. Muse results preserve commands, outcomes and
 * sparse diagnostic data. Expected output is literal.
 *
 * Input provenance, per the repo's evidence rules:
 * - "capture" records are verbatim notifications from the committed
 *   app-server session capture
 *   test/fixtures/codex-0.159.2/session/appserver-session.ndjson (cited by
 *   line) and the committed muse tool capture
 *   test/fixtures/harnesses/muse-tool.ndjson.
 * - "boundary" records are explicit malformed or reader-contract cases;
 *   each names the contract it pins. No expected value invents native
 *   capability: every assertion restates a decision the reader already
 *   makes (see the comments at the mutated lines in content.ts).
 */
import { describe, expect, test } from "vitest";
import { contentEventsOf } from "../../src/interpretation/content.js";

const THREAD = "01a0f0ff-99d4-77f1-940b-bdfd42b51e8a";
const TURN = "01a0f0ff-9d55-7343-b689-ff7ab2527d8a";

describe("codex app-server item notifications (0.159.2 capture shapes)", () => {
  test("the user's own message echo stays dropped on both item methods (capture lines 228-229)", () => {
    const userMessage = {
      type: "userMessage",
      id: "01a0f0ff-a74f-7451-9a74-9e5b287f27ca",
      clientId: null,
      content: [
        {
          type: "text",
          text: "Stop counting. Your next reply must be only the word BANJO.",
          text_elements: [],
        },
      ],
    };
    expect(
      contentEventsOf("codex", {
        method: "item/started",
        params: { item: userMessage, threadId: THREAD, turnId: TURN, startedAtMs: 1790749681492 },
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("codex", {
        method: "item/completed",
        params: {
          item: userMessage,
          threadId: THREAD,
          turnId: TURN,
          completedAtMs: 1790749681492,
        },
      }),
    ).toEqual([]);
  });

  test("reasoning items surface no tool activity on either method (capture lines 16, 206)", () => {
    // item.started: reasoning is in CODEX_NON_TOOL, so it is not a tool call.
    expect(
      contentEventsOf("codex", {
        method: "item/started",
        params: {
          item: { type: "reasoning", id: "rs_889889", summary: [], content: [] },
          threadId: THREAD,
          turnId: TURN,
          startedAtMs: 1790749679263,
        },
      }),
    ).toEqual([]);
    // item.completed for the same reasoning item (summary elided verbatim from
    // the capture): still no tool-result, no message.
    expect(
      contentEventsOf("codex", {
        method: "item/completed",
        params: {
          item: {
            type: "reasoning",
            id: "rs_889889",
            summary: [
              "Okay, let's see. The user wants me to count from 1 to 8, one number per line, then write DONE. First, I need to make sure I'm counting correctly. Starting at 1 and going up to 8, so numbers 1 through 8. Each number should be on a separate line. Then, after that, just write DONE.\n\nWait, but the user provided an environment context with some info about the workspace, but that's probably just context for the codex CLI and doesn't relate to the actual task. The main action here is to count numbers 1 to 8. I should just output those numbers line by line and then DONE.\n\nLet me check if there's any hidden instruction or other context that might affect this, but no, the problem seems straightforward. So the response is simple: list 1-8 each on their own line and end with DONE.\n",
            ],
            content: [],
          },
          threadId: THREAD,
          turnId: TURN,
          completedAtMs: 1790749681318,
        },
      }),
    ).toEqual([]);
  });

  test("a hookPrompt frame is dropped, not surfaced as tool activity (drop-set contract)", () => {
    // Boundary record: hookPrompt is named by CODEX_APPSERVER_DROP_ITEMS as a
    // harness-internal session echo; whatever else it carries, it reports
    // nothing. The frame id is minimal, the contract is the drop itself.
    expect(
      contentEventsOf("codex", {
        method: "item/started",
        params: { item: { type: "hookPrompt", id: "hp_1" }, threadId: THREAD, turnId: TURN },
      }),
    ).toEqual([]);
  });

  test("mcpToolCall completes as the mcp_tool_call vocabulary (map contract)", () => {
    // The camelCase ThreadItem types restate to the exec --json vocabulary
    // the reader is written against (verified 0.159.2). The item mirrors the
    // mcp_tool_call shape already exercised on the exec surface; the native
    // camelCase item rides along as the result, byte for byte.
    expect(
      contentEventsOf("codex", {
        method: "item/completed",
        params: {
          item: {
            type: "mcpToolCall",
            id: "mcp-1",
            status: "completed",
            result: { isError: false, content: [] },
          },
          threadId: THREAD,
          turnId: TURN,
        },
      }),
    ).toEqual([
      {
        kind: "tool-result",
        name: "mcp_tool_call",
        callId: "mcp-1",
        result: {
          type: "mcpToolCall",
          id: "mcp-1",
          status: "completed",
          result: { isError: false, content: [] },
        },
        isError: false,
      },
    ]);
  });

  test("todoList restates to todo_list, which is not tool activity (map contract)", () => {
    expect(
      contentEventsOf("codex", {
        method: "item/started",
        params: { item: { type: "todoList", id: "todo-1" }, threadId: THREAD, turnId: TURN },
      }),
    ).toEqual([]);
    expect(
      contentEventsOf("codex", {
        method: "item/completed",
        params: { item: { type: "todoList", id: "todo-1" }, threadId: THREAD, turnId: TURN },
      }),
    ).toEqual([]);
  });

  test("webSearch completes as the web_search vocabulary (map contract)", () => {
    expect(
      contentEventsOf("codex", {
        method: "item/completed",
        params: { item: { type: "webSearch", id: "ws-1" }, threadId: THREAD, turnId: TURN },
      }),
    ).toEqual([
      {
        kind: "tool-result",
        name: "web_search",
        callId: "ws-1",
        result: { type: "webSearch", id: "ws-1" },
      },
    ]);
  });

  test("turn/completed with no turn record reports nothing (boundary)", () => {
    // Boundary: params without a turn (asRecord answers null for absent,
    // null and non-object alike). A missing verdict is not a failed verdict.
    expect(
      contentEventsOf("codex", { method: "turn/completed", params: { threadId: THREAD } }),
    ).toEqual([]);
  });

  test("turn/completed surfaces only the FAILED verdict (failed-turn contract)", () => {
    // Capture line 434 verbatim: a completed turn carries no content news.
    expect(
      contentEventsOf("codex", {
        method: "turn/completed",
        params: {
          threadId: THREAD,
          turn: {
            id: TURN,
            items: [
              {
                type: "agentMessage",
                id: "msg_939825",
                text: "BANJO",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            ],
            itemsView: "summary",
            status: "completed",
            error: null,
            startedAt: 1790749678,
            completedAt: 1790749683,
            durationMs: 4654,
          },
        },
      }),
    ).toEqual([]);
    // The failed verdict restates to turn.failed with the terminal error
    // message (the app-server notification mirrors exec --json's turn.failed;
    // the same notification is decoded end-to-end in
    // session-input-codex.test.ts). Error message verbatim from the committed
    // exec capture test/fixtures/codex-0.160.0/effort-gpt-5.5-minimal.ndjson.
    expect(
      contentEventsOf("codex", {
        method: "turn/completed",
        params: {
          threadId: THREAD,
          turn: {
            id: TURN,
            items: [],
            itemsView: "summary",
            status: "failed",
            error: {
              message:
                "The following tools cannot be used with reasoning.effort 'minimal': web_search.",
            },
            startedAt: 1790749678,
            completedAt: 1790749683,
            durationMs: 4654,
          },
        },
      }),
    ).toEqual([
      {
        kind: "error",
        message: "The following tools cannot be used with reasoning.effort 'minimal': web_search.",
        terminal: true,
      },
    ]);
  });
});

describe("muse tool_result and run_terminal boundaries", () => {
  test("a real bash tool_result decodes literally (capture: harnesses/muse-tool.ndjson)", () => {
    const bashResult = {
      kind: "tool_result",
      command_id: "28a0aefa-9ef6-4170-88ed-567f0de93c19",
      run_stream: { kind: "run", id: "28a0aefa-9ef6-4170-88ed-567f0de93c19" },
      call_id: "call_019fee59fcad7133b98224aac3a6d1e0",
      text: '{\n  "chunk_id": "exec-1-1",\n  "command": "echo musetooltest2",\n  "description": "Echo test string",\n  "exit_code": 0,\n  "terminal_status": "completed",\n  "output": "musetooltest2\\n",\n  "original_output_bytes": 14,\n  "original_output_tokens": 4,\n  "truncated": false\n}',
      correlation_facts: { tool_name: "bash", outcome: "success" },
    };
    expect(contentEventsOf("muse", { payload: bashResult })).toEqual([
      {
        kind: "tool",
        name: "bash",
        input: "echo musetooltest2",
        callId: "call_019fee59fcad7133b98224aac3a6d1e0",
      },
      {
        kind: "tool-result",
        name: "bash",
        callId: "call_019fee59fcad7133b98224aac3a6d1e0",
        result: bashResult.text,
        isError: false,
      },
    ]);
  });

  test("a tool_result without correlation_facts still decodes, unnamed (boundary)", () => {
    // Boundary: correlation_facts absent (asRecord answers null). The tool
    // falls back to the generic name, no outcome is guessed, and prose text
    // (not JSON) leaves the command off - the read-tool prose is the real
    // capture text from harnesses/muse-readtool.ndjson.
    expect(
      contentEventsOf("muse", {
        payload: {
          kind: "tool_result",
          call_id: "call_9f2c",
          text: "Read text file `s.txt`.\n1|delta",
        },
      }),
    ).toEqual([
      { kind: "tool", name: "tool", callId: "call_9f2c" },
      {
        kind: "tool-result",
        name: "tool",
        callId: "call_9f2c",
        result: "Read text file `s.txt`.\n1|delta",
      },
    ]);
  });

  test("failed and rejected outcomes are errors (outcome vocabulary)", () => {
    // The reader maps muse's native outcome words to isError; "failure" and
    // "success" are pinned by observations.test.ts and the capture above.
    // These pin the other two words of the same closed vocabulary.
    for (const outcome of ["failed", "rejected"]) {
      expect(
        contentEventsOf("muse", {
          payload: {
            kind: "tool_result",
            call_id: "call_outcome",
            text: "exit 1",
            correlation_facts: { tool_name: "bash", outcome },
          },
        }),
      ).toEqual([
        { kind: "tool", name: "bash", callId: "call_outcome" },
        {
          kind: "tool-result",
          name: "bash",
          callId: "call_outcome",
          result: "exit 1",
          isError: true,
        },
      ]);
    }
  });

  test("terminal-shaped fields alone do not fire run_terminal handling (kind gate)", () => {
    // Boundary: a payload with no kind at all, carrying run_terminal-shaped
    // fields. Only payload.kind === "run_terminal" opens the terminal branch;
    // a stray completed verdict on another record reports nothing.
    expect(contentEventsOf("muse", { payload: { terminal: "completed", text: "BANJO" } })).toEqual(
      [],
    );
  });
});
