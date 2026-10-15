import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DROPPABLE_KINDS } from "../../src/execution/events.js";
import {
  contentEventsOf,
  contentEventsWithState,
  freshCursorReaderState,
} from "../../src/interpretation/content.js";
import { usageEventsOf } from "../../src/interpretation/usage.js";
import type { HarnessName } from "../../src/knowledge/descriptor.js";

const fixture = (file: string) =>
  readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const results = (harness: HarnessName, records: unknown[]) =>
  records.flatMap((r) => contentEventsOf(harness, r)).filter((e) => e.kind === "tool-result");

describe("native tool result observations", () => {
  test("Pi preserves extension details and explicit errors without interpreting their status", () => {
    const result = {
      content: [{ type: "text", text: "aborted\n" }],
      details: { runId: "run-1", status: "aborted", agents: [{ error: "provider failed" }] },
    };
    for (const isError of [false, true]) {
      expect(
        results("pi", [
          {
            type: "tool_execution_end",
            toolName: "workflow",
            toolCallId: "call-1",
            result,
            isError,
          },
        ]),
      ).toEqual([{ kind: "tool-result", name: "workflow", callId: "call-1", result, isError }]);
    }
    expect(
      results("pi", [
        { type: "tool_execution_update", partialResult: result },
        { type: "message_end", message: { role: "toolResult", ...result } },
        { type: "agent_end", messages: [result] },
      ]),
    ).toEqual([]);
    expect(contentEventsOf("pi", { type: "tool_execution_end" })).toEqual([]);
    expect(
      results("pi", [{ type: "tool_execution_end", toolCallId: "unknown", result: null }]),
    ).toEqual([{ kind: "tool-result", callId: "unknown", result: null }]);
  });

  test("Claude emits only tool-result blocks from user records and retains the native call id", () => {
    const content = [
      { type: "text", text: "shell failed" },
      { type: "image", data: "fixture", mimeType: "image/png" },
    ];
    expect(
      contentEventsOf("claude", {
        type: "user",
        message: {
          content: [
            { type: "text", text: "echo" },
            { type: "tool_result", tool_use_id: "tool-1", content, is_error: true },
          ],
        },
      }),
    ).toEqual([{ kind: "tool-result", callId: "tool-1", result: content, isError: true }]);
    expect(
      contentEventsOf("claude", {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "false" } }],
        },
      }),
    ).toEqual([{ kind: "tool", name: "Bash", callId: "tool-1", input: { command: "false" } }]);
  });

  test("Codex exec and app-server preserve completed command output, exit code and errors", () => {
    const item = {
      id: "item-1",
      type: "command_execution",
      command: "false",
      aggregated_output: "failure output",
      exit_code: 1,
      status: "completed",
    };
    expect(results("codex", [{ type: "item.completed", item }])).toEqual([
      { kind: "tool-result", name: "shell", callId: "item-1", result: item, isError: true },
    ]);
    const nativeItem = {
      id: "item-2",
      type: "commandExecution",
      command: "false",
      aggregatedOutput: "failure output",
      exitCode: 1,
      status: "completed",
    };
    expect(
      results("codex", [{ method: "item/completed", params: { item: nativeItem } }])[0],
    ).toEqual({
      kind: "tool-result",
      name: "shell",
      callId: "item-2",
      result: nativeItem,
      isError: true,
    });
    for (const exit_code of [null, undefined, "0", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        results("codex", [
          {
            type: "item.completed",
            item: { type: "command_execution", status: "completed", exit_code },
          },
        ])[0],
      ).not.toHaveProperty("isError");
    }
    expect(
      results("codex", [
        {
          type: "item.completed",
          item: {
            id: "mcp-1",
            type: "mcp_tool_call",
            status: "completed",
            result: { isError: true, content: [] },
          },
        },
      ])[0]?.isError,
    ).toBe(true);
    expect(
      results("codex", [
        {
          type: "item.completed",
          item: { type: "web_search", action: { url: "https://example.com" } },
        },
      ])[0],
    ).not.toHaveProperty("isError");
    expect(
      results("codex", [{ type: "item.completed", item: { type: "agent_message", text: "hi" } }]),
    ).toEqual([]);
  });

  test("Muse carries the real result text, call id, and native outcome", () => {
    const r = fixture("harnesses/muse-tool.ndjson").find((r) => r.payload?.kind === "tool_result");
    expect(results("muse", [r])).toEqual([
      {
        kind: "tool-result",
        name: "bash",
        callId: r.payload.call_id,
        result: r.payload.text,
        isError: false,
      },
    ]);
    expect(
      results("muse", [
        {
          payload: {
            kind: "tool_result",
            text: "failed",
            correlation_facts: { tool_name: "bash", outcome: "failure" },
          },
        },
      ])[0]?.isError,
    ).toBe(true);
    expect(
      results("muse", [
        {
          payload: {
            kind: "tool_result",
            text: "unknown",
            correlation_facts: { tool_name: "bash" },
          },
        },
      ])[0],
    ).not.toHaveProperty("isError");
  });

  test("Cursor emits errors and nonzero shell exits, including native future result arms", () => {
    for (const [result, error] of [
      [{ error: { errorMessage: "not found" } }, true],
      [{ success: { exitCode: 2, stdout: "failed" } }, true],
      [{ success: { exitCode: 0 } }, false],
      [{ success: {} }, undefined],
      [{ success: { exitCode: null } }, undefined],
      [{ future: { payload: [1, 2] } }, undefined],
    ] as const) {
      const raw = {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { shellToolCall: { result } },
      };
      const first = contentEventsWithState("cursor", raw, freshCursorReaderState());
      expect(first.events.filter((e) => e.kind === "tool-result")).toEqual([
        {
          kind: "tool-result",
          name: "shellToolCall",
          callId: "c1",
          result,
          ...(error === undefined ? {} : { isError: error }),
        },
      ]);
      expect(contentEventsWithState("cursor", raw, first.state).events).toEqual([]);
    }
  });

  test("real Pi and Codex captures yield one result per recorded invocation", () => {
    const pi = fixture("harnesses/pi-tool.ndjson");
    const nativePi = pi.find((r) => r.type === "tool_execution_end");
    expect(results("pi", pi)).toEqual([
      {
        kind: "tool-result",
        name: "bash",
        callId: nativePi.toolCallId,
        result: nativePi.result,
        isError: false,
      },
    ]);
    const codex = fixture("harnesses/codex-tool.ndjson");
    const command = codex.find(
      (r) => r.type === "item.completed" && r.item.type === "command_execution",
    ).item;
    expect(results("codex", codex)).toEqual([
      { kind: "tool-result", name: "shell", callId: command.id, result: command, isError: false },
    ]);
  });

  test("Antigravity explicit tool error state is distinct from a DONE output with unknown exit", () => {
    const native = fixture("antigravity-1.2.7/sandbox-boundary.ndjson")[0];
    for (const state of ["ERROR", "DONE"]) {
      const [result] = results("antigravity", [
        { ...native, step_update: { ...native.step_update, state } },
      ]);
      expect(result).toEqual({
        kind: "tool-result",
        name: "run_command",
        result: native.step_update.tool_info.output,
        ...(state === "ERROR" ? { isError: true } : {}),
      });
    }
  });

  test("tool results and usage stay lossless", () => {
    expect(DROPPABLE_KINDS.has("tool-result")).toBe(false);
    expect(DROPPABLE_KINDS.has("usage")).toBe(false);
  });
});

describe("native token usage observations", () => {
  test("Pi emits final message, nested-tool and compaction counts, never cumulative streaming echoes", () => {
    const usage = {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      reasoning: 5,
      totalTokens: 180,
      cost: { total: 0.02 },
    };
    const fields = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      totalTokens: 180,
      costUsd: 0.02,
      inputIncludesCache: false,
    };
    expect(
      usageEventsOf("pi", { type: "message_end", message: { role: "assistant", usage } }),
    ).toEqual([{ kind: "usage", scope: "message", ...fields }]);
    expect(
      usageEventsOf("pi", {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "t1", usage },
      }),
    ).toEqual([{ kind: "usage", scope: "tool", callId: "t1", ...fields }]);
    expect(usageEventsOf("pi", { type: "compaction_end", result: { usage } })).toEqual([
      { kind: "usage", scope: "compaction", ...fields },
    ]);
    for (const type of ["message_update", "message_start", "turn_end", "agent_end"])
      expect(
        usageEventsOf("pi", {
          type,
          usage,
          message: { role: "assistant", usage },
          messages: [{ usage }],
        }),
      ).toEqual([]);
  });

  test("Claude keeps turn main-loop tokens separate from cumulative session and per-model costs", () => {
    expect(
      usageEventsOf("claude", {
        type: "result",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
        total_cost_usd: 0.25,
        modelUsage: {
          opus: {
            inputTokens: 5,
            outputTokens: 6,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 8,
            costUSD: 0.2,
          },
        },
      }),
    ).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        inputIncludesCache: false,
      },
      { kind: "usage", scope: "session", costUsd: 0.25 },
      {
        kind: "usage",
        scope: "session",
        model: "opus",
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 7,
        cacheWriteTokens: 8,
        costUsd: 0.2,
        inputIncludesCache: false,
      },
    ]);
    expect(
      usageEventsOf("claude", { type: "assistant", message: { usage: { output_tokens: 1 } } }),
    ).toEqual([]);
  });

  test("Codex caches overlap input; exec and app-server session totals are not invented turn deltas", () => {
    expect(
      usageEventsOf("codex", {
        type: "turn.completed",
        usage: {
          input_tokens: 20,
          cached_input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      }),
    ).toEqual([
      {
        kind: "usage",
        scope: "session",
        inputTokens: 20,
        cacheReadTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        inputIncludesCache: true,
      },
    ]);
    expect(
      usageEventsOf("codex", {
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { inputTokens: 40, cachedInputTokens: 20, outputTokens: 10, totalTokens: 50 },
            last: { inputTokens: 20, outputTokens: 5 },
          },
        },
      }),
    ).toEqual([
      {
        kind: "usage",
        scope: "session",
        inputTokens: 40,
        cacheReadTokens: 20,
        outputTokens: 10,
        totalTokens: 50,
        inputIncludesCache: true,
      },
    ]);
  });

  test("Cursor and Antigravity expose the real capture's usage", () => {
    const cursor = fixture("cursor-2026.09.15-d2fe57e/probe-43.ndjson").find(
      (r) => r.type === "result",
    );
    expect(usageEventsOf("cursor", cursor)).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: cursor.usage.inputTokens,
        outputTokens: cursor.usage.outputTokens,
        cacheReadTokens: cursor.usage.cacheReadTokens,
        cacheWriteTokens: cursor.usage.cacheWriteTokens,
        inputIncludesCache: false,
      },
    ]);
    const agy = fixture("antigravity-1.2.7/success.ndjson").find((r) => r.event === "result");
    expect(usageEventsOf("antigravity", agy)).toEqual([
      {
        kind: "usage",
        scope: "session",
        inputTokens: 12023,
        outputTokens: 61,
        reasoningTokens: 60,
        cacheReadTokens: 0,
        totalTokens: 12084,
      },
    ]);
  });

  test("invalid counts are omitted, zero remains real, and no totals or prices are synthesized", () => {
    expect(
      usageEventsOf("pi", {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: -1,
            output: "20",
            cacheRead: Number.NaN,
            cacheWrite: Number.POSITIVE_INFINITY,
            totalTokens: 1.5,
            reasoning: Number.MAX_SAFE_INTEGER + 1,
            cost: { total: -0.2 },
          },
        },
      }),
    ).toEqual([]);
    expect(
      usageEventsOf("pi", {
        type: "message_end",
        message: { role: "assistant", usage: { input: 0, output: 0 } },
      }),
    ).toEqual([
      {
        kind: "usage",
        scope: "message",
        inputTokens: 0,
        outputTokens: 0,
        inputIncludesCache: false,
      },
    ]);
    for (const harness of [
      "pi",
      "claude",
      "codex",
      "cursor",
      "antigravity",
      "muse",
      "popeye",
    ] as const)
      expect(usageEventsOf(harness, { type: "unknown", usage: { input: 1 } })).toEqual([]);
  });
});
