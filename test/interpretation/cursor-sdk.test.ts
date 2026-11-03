/**
 * Pure-module tests for the Cursor SDK backend (issue #440): the private
 * worker wire encoders, the session-record classification of worker
 * output, the SDK content mapping (tokens once, complete messages per
 * step, #438 boundaries), model resolution against the native catalog as
 * data, and the access restriction mapping.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { contentEventsWithState, freshReaderState } from "../../src/interpretation/content.js";
import {
  CURSOR_SDK_TURN_END,
  type CursorSdkModelCatalog,
  CursorSdkSelectionError,
  cursorSdkAccessRestriction,
  cursorSdkContentEvents,
  cursorSdkErrorKindOf,
  cursorSdkTurnEndOf,
  cursorSdkWireKindOf,
  encodeCursorSdkAbort,
  encodeCursorSdkAbortReceipt,
  encodeCursorSdkEvent,
  encodeCursorSdkOpen,
  encodeCursorSdkOpened,
  encodeCursorSdkOpenFailed,
  encodeCursorSdkPrompt,
  encodeCursorSdkReceipt,
  encodeCursorSdkSendFailed,
  encodeCursorSdkTurnEnd,
  freshCursorSdkReaderState,
  resolveCursorSdkModel,
} from "../../src/interpretation/cursor-sdk.js";
import {
  decodeSessionRecord,
  encodeCursorSdkIdentityProbe,
  encodeIdentityProbe,
  encodeSessionInput,
  encodeSessionInterrupt,
} from "../../src/interpretation/session-input.js";
import { successfulTurnEnd } from "../../src/interpretation/turn-completion.js";
import { usageEventsOf } from "../../src/interpretation/usage.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

test("a supported SDK base model retains curated session capabilities", () => {
  expect(capabilitiesOf(cursorCli, "grok-4.7", "headless-session")).toMatchObject({
    source: "curated",
    session: true,
    streaming: "token",
  });
});

const agentId = "agent-da354f73-06a8-4bb8-8c6f-e88da9f95eb1";

/** The grok-4.7 catalog entry as the account probe captured it (zero-width
 * display-name characters included), plus synthetic entries for the
 * resolution rules the probe could not cover. */
const CATALOG: CursorSdkModelCatalog = [
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [
          { value: "256k", displayName: "256K" },
          { value: "500k", displayName: "500K" },
        ],
      },
      {
        id: "reasoning_effort",
        displayName: "Effort",
        values: [
          { value: "low", displayName: "Low" },
          { value: "medium", displayName: "Medium" },
          { value: "high", displayName: "High" },
          { value: "xhigh", displayName: "Extra High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast\u200b\u200b" }],
      },
    ],
    variants: [
      {
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "low" },
          { id: "fast", value: "false" },
        ],
        displayName: "Grok 4.7  Low",
      },
      {
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "medium" },
          { id: "fast", value: "false" },
        ],
        displayName: "Grok 4.7  Medium",
      },
      {
        params: [
          { id: "context", value: "500k" },
          { id: "reasoning_effort", value: "high" },
          { id: "fast", value: "true" },
        ],
        displayName: "Grok 4.7  High Fast\u200b\u200b",
        isDefault: true,
        isMaxMode: true,
      },
    ],
  },
  {
    // An older-model shape: the effort parameter is named `effort`, not
    // `reasoning_effort` - the resolution must never hardcode one id.
    id: "old-model",
    displayName: "Old Model",
    parameters: [
      {
        id: "effort",
        values: [{ value: "low" }, { value: "high" }],
      },
    ],
    variants: [
      {
        params: [{ id: "effort", value: "low" }],
        displayName: "Old Model Low",
      },
    ],
  },
];

/** The account's actual public catalog capture (48 entries, SDK 1.0.38),
 * byte-for-byte under test/fixtures - tests select entries by id so no
 * shape is transcribed into test code. */
const FULL_CATALOG = JSON.parse(
  readFileSync(
    new URL("../fixtures/cursor-sdk-1.0.38/models.full.snapshot.json", import.meta.url),
    "utf8",
  ),
) as CursorSdkModelCatalog;
const catalogOf = (...ids: string[]): CursorSdkModelCatalog =>
  FULL_CATALOG.filter((entry) => ids.includes(entry.id));

/** The error a throwing call raised, for asserting on its shape. */
const resolveFailing = (call: () => unknown): Error => {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the resolution to fail");
};

describe("worker wire encoders", () => {
  test("open carries resume, model and the access restriction; nothing else rides argv", () => {
    expect(
      encodeCursorSdkOpen({
        id: "hcn-identity",
        resume: agentId,
        model: "grok-4.7-high",
        tools: ["read"],
        disallowedTools: ["task", "mcp"],
        sandbox: false,
      }),
    ).toBe(
      `${JSON.stringify({
        hcn: "open",
        id: "hcn-identity",
        resume: agentId,
        model: "grok-4.7-high",
        tools: ["read"],
        disallowedTools: ["task", "mcp"],
        sandbox: false,
      })}\n`,
    );
    expect(encodeCursorSdkOpen({ id: "hcn-identity" })).toBe(
      `${JSON.stringify({ hcn: "open", id: "hcn-identity" })}\n`,
    );
  });

  test("open carries an explicit effort word beside the model slug", () => {
    expect(
      encodeCursorSdkOpen({ id: "hcn-identity", model: "gpt-5.3-codex", effort: "medium" }),
    ).toBe(
      `${JSON.stringify({ hcn: "open", id: "hcn-identity", model: "gpt-5.3-codex", effort: "medium" })}\n`,
    );
  });

  test("prompt and abort are correlated by id", () => {
    expect(encodeCursorSdkPrompt("hcn-send:1", "hello")).toBe(
      `${JSON.stringify({ hcn: "prompt", id: "hcn-send:1", message: "hello" })}\n`,
    );
    expect(encodeCursorSdkAbort("hcn-interrupt:2")).toBe(
      `${JSON.stringify({ hcn: "abort", id: "hcn-interrupt:2" })}\n`,
    );
  });

  test("opened announces identity in the dual-purpose shape", () => {
    const line = encodeCursorSdkOpened("hcn-identity", agentId);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.agentId).toBe(agentId);
    expect(parsed.session_id).toBe(agentId);
    expect(parsed.type).toBe("system");
    expect(parsed.subtype).toBe("init");
    expect(cursorSdkWireKindOf(parsed)).toBe("opened");
  });

  test("the identity probe the session runner writes is the open line", () => {
    expect(
      encodeIdentityProbe(cursorCli, {
        sessionId: agentId,
        isResume: true,
        model: "grok-4.7-high",
      }),
    ).toBe(
      encodeCursorSdkOpen({
        id: "hcn-identity",
        resume: agentId,
        model: "grok-4.7-high",
      }),
    );
    // A fresh session names no resume id and adds no hcn tool restriction:
    // the SDK's native defaults own a bare session too.
    const fresh = JSON.parse(encodeIdentityProbe(cursorCli, {}) ?? "{}") as Record<string, unknown>;
    expect(fresh.resume).toBeUndefined();
    expect(fresh.tools).toBeUndefined();
    expect(fresh.disallowedTools).toBeUndefined();
  });

  test("the session identity probe forwards an explicit effort word", () => {
    expect(
      encodeIdentityProbe(cursorCli, {
        sessionId: agentId,
        isResume: true,
        model: "gpt-5.3-codex",
        effort: "medium",
      }),
    ).toBe(
      encodeCursorSdkOpen({
        id: "hcn-identity",
        resume: agentId,
        model: "gpt-5.3-codex",
        effort: "medium",
      }),
    );
    expect(encodeCursorSdkIdentityProbe({ model: "gpt-5.3-codex", effort: "medium" })).toBe(
      encodeCursorSdkOpen({
        id: "hcn-identity",
        model: "gpt-5.3-codex",
        effort: "medium",
      }),
    );
    // Without an effort word the probe carries none.
    const bare = JSON.parse(encodeCursorSdkIdentityProbe({}) ?? "{}") as Record<string, unknown>;
    expect(bare.effort).toBeUndefined();
  });

  test("session input encodes as a correlated prompt and refuses explicit delivery", () => {
    expect(encodeSessionInput({ kind: "cursor-sdk" }, "hi", { busy: false, id: "7" })).toBe(
      `${JSON.stringify({ hcn: "prompt", id: "hcn-send:7", message: "hi" })}\n`,
    );
    expect(() =>
      encodeSessionInput({ kind: "cursor-sdk" }, "hi", { busy: false, id: "7", delivery: "queue" }),
    ).toThrow(/unsupported-delivery/);
    expect(() =>
      encodeSessionInput({ kind: "cursor-sdk" }, "hi", { busy: false, id: "7", delivery: "steer" }),
    ).toThrow(/unsupported-delivery/);
    expect(encodeSessionInterrupt({ kind: "cursor-sdk" }, "3")).toBe(
      `${JSON.stringify({ hcn: "abort", id: "hcn-interrupt:3" })}\n`,
    );
  });
});

describe("worker record classification (decodeSessionRecord, cursor descriptor)", () => {
  const classify = (line: string) =>
    decodeSessionRecord(cursorCli, JSON.parse(line) as Record<string, unknown>);

  test("opened answers the identity probe with the agent id", () => {
    expect(classify(encodeCursorSdkOpened("hcn-identity", agentId))).toEqual({
      kind: "identity",
      sessionId: agentId,
    });
  });

  test("open-failed is a probe failure carrying the native message", () => {
    expect(classify(encodeCursorSdkOpenFailed("hcn-identity", "Invalid API key", "auth"))).toEqual({
      kind: "probe-failed",
      message: "Invalid API key",
    });
  });

  test("receipt settles a correlated send as started", () => {
    expect(classify(encodeCursorSdkReceipt("hcn-send:4"))).toEqual({
      inputId: "4",
      kind: "command-accepted",
      nativeDisposition: "started",
    });
  });

  test("send-failed names the send it refused", () => {
    expect(
      classify(
        encodeCursorSdkSendFailed("hcn-send:5", "Agent agent-x already has active run", "native"),
      ),
    ).toEqual({
      inputId: "5",
      kind: "command-failed",
      message: "Agent agent-x already has active run",
    });
  });

  test("abort receipts settle interrupts; the terminal record settles the turn", () => {
    expect(classify(encodeCursorSdkAbortReceipt("hcn-interrupt:2", true))).toEqual({
      kind: "interrupt-answered",
      token: "2",
      accepted: true,
    });
    expect(classify(encodeCursorSdkTurnEnd({ status: "cancelled" }))).toEqual({
      kind: "turn-end",
      isError: false,
      aborted: true,
    });
    expect(classify(encodeCursorSdkTurnEnd({ status: "error", message: "boom" }))).toEqual({
      kind: "turn-end",
      isError: true,
    });
    expect(classify(encodeCursorSdkTurnEnd({ status: "finished" }))).toEqual({
      kind: "turn-end",
      isError: false,
    });
    expect(CURSOR_SDK_TURN_END).toEqual({ hcn: "turn-end" });
  });

  test("event envelopes are content; foreign and malformed lines are ignored", () => {
    expect(classify(encodeCursorSdkEvent({ delta: { type: "text-delta", text: "H" } }))).toEqual({
      kind: "content",
    });
    expect(classify('{"hcn":"nonsense"}')).toEqual({ kind: "ignored" });
    // A record with no `hcn` discriminator is foreign to the worker wire -
    // legacy CLI shapes never ride it (issue #440 keeps those for the
    // transcript corpus).
    expect(classify('{"type":"assistant","message":{"role":"assistant","content":[]}}')).toEqual({
      kind: "ignored",
    });
  });
});

describe("SDK content mapping", () => {
  const decode = (line: string) =>
    contentEventsWithState("cursor", JSON.parse(line), freshReaderState("cursor"));

  test("text deltas are tokens; the complete onStep message is a separate message event", () => {
    const tokens = [
      decode(encodeCursorSdkEvent({ delta: { type: "text-delta", text: "H" } })),
      decode(encodeCursorSdkEvent({ delta: { type: "text-delta", text: "CN" } })),
    ];
    expect(tokens.map((step) => step.events)).toEqual([
      [{ kind: "token", text: "H" }],
      [{ kind: "token", text: "CN" }],
    ]);
    const message = decode(
      encodeCursorSdkEvent({
        event: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "HCN_CURSOR_SDK_OK" }] },
        },
      }),
    );
    expect(message.events).toEqual([
      { kind: "message", role: "assistant", text: "HCN_CURSOR_SDK_OK" },
    ]);
  });

  test("#438: task-separated messages never concatenate - each onStep record is its own message", () => {
    const first = decode(
      encodeCursorSdkEvent({
        event: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "before" }] },
        },
      }),
    );
    const boundary = decode(
      encodeCursorSdkEvent({ event: { type: "task", status: "queuedFollowUp" } }),
    );
    const second = decode(
      encodeCursorSdkEvent({
        event: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "after" }] },
        },
      }),
    );
    expect(first.events.map((event) => event.kind)).toEqual(["message"]);
    expect(boundary.events).toEqual([{ kind: "progress", label: "queuedFollowUp" }]);
    expect(second.events).toEqual([{ kind: "message", role: "assistant", text: "after" }]);
  });

  test("tool_call running emits one tool; completed/error emits one tool-result; duplicates never re-emit", () => {
    let state = freshCursorSdkReaderState();
    const step = (line: string) => {
      const out = cursorSdkContentEvents(JSON.parse(line) as Record<string, unknown>, state);
      state = out.state;
      return out.events;
    };
    const running = encodeCursorSdkEvent({
      event: {
        type: "tool_call",
        call_id: "c1",
        name: "read",
        status: "running",
        args: { path: "a" },
      },
    });
    expect(step(running)).toEqual([
      { kind: "tool", name: "read", callId: "c1", input: { path: "a" } },
    ]);
    const completed = encodeCursorSdkEvent({
      event: {
        type: "tool_call",
        call_id: "c1",
        name: "read",
        status: "completed",
        result: { content: "x" },
      },
    });
    expect(step(completed)).toEqual([
      { kind: "tool-result", name: "read", callId: "c1", result: { content: "x" } },
    ]);
    expect(step(completed)).toEqual([]);
    const errored = encodeCursorSdkEvent({
      event: {
        type: "tool_call",
        call_id: "c2",
        name: "shell",
        status: "error",
        result: { exitCode: 1 },
      },
    });
    expect(step(errored)).toEqual([
      { kind: "tool", name: "shell", callId: "c2" },
      { kind: "tool-result", name: "shell", callId: "c2", result: { exitCode: 1 }, isError: true },
    ]);
  });

  test("a usage message is one turn-scoped observation, never two", () => {
    const line = encodeCursorSdkEvent({
      event: {
        type: "usage",
        usage: {
          inputTokens: 5249,
          outputTokens: 46,
          cacheReadTokens: 2560,
          cacheWriteTokens: 0,
          totalTokens: 7855,
          reasoningTokens: 38,
        },
      },
    });
    expect(usageEventsOf("cursor", JSON.parse(line) as Record<string, unknown>)).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 5249,
        outputTokens: 46,
        cacheReadTokens: 2560,
        cacheWriteTokens: 0,
        reasoningTokens: 38,
        totalTokens: 7855,
        inputIncludesCache: false,
      },
    ]);
    expect(decode(line).events).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 5249,
        outputTokens: 46,
        cacheReadTokens: 2560,
        cacheWriteTokens: 0,
        reasoningTokens: 38,
        totalTokens: 7855,
        inputIncludesCache: false,
      },
    ]);
  });

  test("a native request the SDK cannot answer is a surfaced error, never a fabricated reply", () => {
    const events = decode(
      encodeCursorSdkEvent({ event: { type: "request", request_id: "req-1" } }),
    ).events;
    expect(events).toEqual([
      {
        kind: "error",
        message:
          "cursor SDK raised a native request req-1 that hcn cannot answer: the SDK exposes no reply API; answer it through native hooks or the hcn question protocol",
      },
    ]);
  });

  test("the terminal record's error arm is a terminal error; open-failed too; malformed envelopes decode to nothing", () => {
    expect(
      decode(encodeCursorSdkTurnEnd({ status: "error", message: "usage capped" })).events,
    ).toEqual([{ kind: "error", message: "usage capped", terminal: true }]);
    expect(decode(encodeCursorSdkTurnEnd({ status: "cancelled" })).events).toEqual([]);
    expect(
      decode(encodeCursorSdkOpenFailed("hcn-identity", "Invalid API key", "auth")).events,
    ).toEqual([{ kind: "error", message: "Invalid API key", terminal: true }]);
    expect(decode('{"hcn":"event"}').events).toEqual([]);
    expect(decode('{"hcn":"event","event":"not-a-record"}').events).toEqual([]);
    expect(decode('{"hcn":"turn-end","status":"weird"}').events).toEqual([]);
  });

  test("a finished terminal record is the native success delimiter", () => {
    expect(
      successfulTurnEnd("cursor", JSON.parse(encodeCursorSdkTurnEnd({ status: "finished" }))),
    ).toBe(true);
    expect(
      successfulTurnEnd("cursor", JSON.parse(encodeCursorSdkTurnEnd({ status: "error" }))),
    ).toBe(false);
  });
});

describe("SDK native tool normalization (repeated running, wrapper results)", () => {
  // SDK 1.0.38 maps native shell success and failure onto {status:'success',
  // value:{exitCode,...}}, so a nonzero exitCode is the only failure
  // signal, and rejection/timeout/spawn errors all become a
  // {status:'error', error:{message}} wrapper - the reason text survives
  // in error.message, the rejection category does not.
  const shellWrapper = (exitCode: number) => ({
    status: "success",
    value: { exitCode, signal: "", stdout: "", stderr: "", executionTime: 1 },
  });

  test("a repeated running record for one native call emits one tool invocation, first data kept", () => {
    let state = freshCursorSdkReaderState();
    const step = (line: string) => {
      const out = cursorSdkContentEvents(JSON.parse(line) as Record<string, unknown>, state);
      state = out.state;
      return out.events;
    };
    const running = encodeCursorSdkEvent({
      event: {
        type: "tool_call",
        call_id: "call-r",
        name: "task",
        status: "running",
        args: { description: "Sleep ten seconds" },
      },
    });
    expect(step(running)).toEqual([
      { kind: "tool", name: "task", callId: "call-r", input: { description: "Sleep ten seconds" } },
    ]);
    // The captured duplicate running record carries identical args; the
    // first invocation's data is the one preserved.
    expect(step(running)).toEqual([]);
    // Even after completion, a late repeated running never re-emits.
    expect(
      step(
        encodeCursorSdkEvent({
          event: {
            type: "tool_call",
            call_id: "call-r",
            name: "task",
            status: "completed",
            args: { description: "Sleep ten seconds" },
            result: { status: "success", value: { isBackground: false } },
          },
        }),
      ).map((event) => event.kind),
    ).toEqual(["tool-result"]);
    expect(step(running)).toEqual([]);
  });

  test("the real SDK shell wrapper with a nonzero exitCode is an error result; zero is not", () => {
    let state = freshCursorSdkReaderState();
    const step = (line: string) => {
      const out = cursorSdkContentEvents(JSON.parse(line) as Record<string, unknown>, state);
      state = out.state;
      return out.events;
    };
    const completed = (callId: string, result: unknown) =>
      encodeCursorSdkEvent({
        event: {
          type: "tool_call",
          call_id: callId,
          name: "shell",
          status: "completed",
          args: { command: "sleep 10" },
          result,
        },
      });
    // The exitCode:7 reproduction: status success, tool status completed,
    // yet the command failed.
    expect(step(completed("exit-seven", shellWrapper(7)))).toEqual([
      { kind: "tool", name: "shell", callId: "exit-seven", input: { command: "sleep 10" } },
      {
        kind: "tool-result",
        name: "shell",
        callId: "exit-seven",
        result: shellWrapper(7),
        isError: true,
      },
    ]);
    expect(
      step(completed("exit-zero", shellWrapper(0)))
        .filter((event) => event.kind === "tool-result")
        .map((event) => (event as { isError?: boolean }).isError),
    ).toEqual([false]);
  });

  test("an SDK status:error completion - timeout or rejection-looking - is an error result, never a denial", () => {
    let state = freshCursorSdkReaderState();
    const step = (line: string) => {
      const out = cursorSdkContentEvents(JSON.parse(line) as Record<string, unknown>, state);
      state = out.state;
      return out.events;
    };
    // The actual wrappers the SDK produces for timeout and rejected shell
    // calls (installed @cursor/sdk 1.0.38): identical shape, reason text
    // in error.message, category destroyed. Neither may surface a denial.
    const rejectedLooking = {
      status: "error",
      error: { message: "sandbox denied the command", command: "rm -rf /", workingDirectory: "/w" },
    };
    const timedOut = {
      status: "error",
      error: { message: "Command timed out after 5ms", command: "slow", workingDirectory: "/w" },
    };
    for (const [callId, result] of [
      ["call-d", rejectedLooking],
      ["call-e", timedOut],
    ] as const) {
      const events = step(
        encodeCursorSdkEvent({
          event: {
            type: "tool_call",
            call_id: callId,
            name: "shell",
            status: "running",
            args: { command: "x" },
          },
        }),
      );
      expect(events).toHaveLength(1);
      const settled = step(
        encodeCursorSdkEvent({
          event: {
            type: "tool_call",
            call_id: callId,
            name: "shell",
            status: "completed",
            args: { command: "x" },
            result,
          },
        }),
      );
      // The raw wrapper forwards unchanged and is flagged isError; no
      // error event, no denial metadata, is invented from the message.
      expect(settled).toEqual([
        {
          kind: "tool-result",
          name: "shell",
          callId,
          result,
          isError: true,
        },
      ]);
    }
    // A repeated completion of the rejection-looking call adds nothing:
    // without an explicit rejected payload there is no denial to re-report.
    expect(
      step(
        encodeCursorSdkEvent({
          event: {
            type: "tool_call",
            call_id: "call-d",
            name: "shell",
            status: "completed",
            result: rejectedLooking,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("native task-steps capture replay (SDK 1.0.38)", () => {
  // The promoted real capture (task-steps.provenance.json): one Task-tool
  // call the SDK reported as two running + one completed stream record,
  // three complete onStep assistant messages, one usage record. The
  // worker already wrapped onStep; this replays the captured wire bytes
  // through the shared reader.
  const capture = readFileSync(
    new URL("../fixtures/cursor-sdk-1.0.38/task-steps.ndjson", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim() !== "");

  test("the repeated running records yield one tool invocation; three messages stay distinct", () => {
    let state = freshCursorSdkReaderState();
    const events = [];
    for (const line of capture) {
      const record = JSON.parse(line) as Record<string, unknown>;
      const out = cursorSdkContentEvents(record, state);
      events.push(...out.events, ...usageEventsOf("cursor", record));
      state = out.state;
    }
    const tools = events.filter((event) => event.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: "tool", name: "task" });
    const results = events.filter((event) => event.kind === "tool-result");
    expect(results).toHaveLength(1);
    // The task result is the SDK wrapper (status success, isBackground
    // false); a task tool has no exitCode, so it is not an error.
    expect((results[0] as { isError?: boolean }).isError).toBe(false);
    const messages = events.filter((event) => event.kind === "message");
    expect(messages.map((message) => (message as { text: string }).text)).toEqual([
      "I'll start one background worker that sleeps, then print the verdict while it is still running.",
      "The Task schema is in place. Starting the worker in the background now.",
      "BACKGROUND_DONE",
    ]);
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 54026,
      outputTokens: 2805,
      cacheReadTokens: 39808,
      cacheWriteTokens: 0,
      totalTokens: 96639,
      reasoningTokens: 2620,
    });
  });
});

describe("model resolution against the native catalog", () => {
  test("grok-4.7-high pins reasoning_effort high with the non-max defaults", () => {
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7-high")).toEqual({
      id: "grok-4.7",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "context", value: "256k" },
        { id: "fast", value: "false" },
      ],
    });
  });

  test("the -fast suffix pins fast true by value, not by a global effort parameter", () => {
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7-high-fast")).toEqual({
      id: "grok-4.7",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "context", value: "256k" },
      ],
    });
    // The account's isDefault variant is a 500k MAX-MODE one; a plain slug
    // still means the base 256k tier, never silent max mode.
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7-low")).toMatchObject({
      id: "grok-4.7",
      params: expect.arrayContaining([
        { id: "reasoning_effort", value: "low" },
        { id: "context", value: "256k" },
        { id: "fast", value: "false" },
      ]),
    });
  });

  test("xhigh resolves through the Extra High display name; an older model's `effort` parameter works the same", () => {
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7-xhigh")).toMatchObject({
      id: "grok-4.7",
      params: expect.arrayContaining([{ id: "reasoning_effort", value: "xhigh" }]),
    });
    expect(resolveCursorSdkModel(CATALOG, "old-model-high")).toEqual({
      id: "old-model",
      params: [{ id: "effort", value: "high" }],
    });
  });

  test("an exact catalog id runs with native defaults; an unresolvable slug passes through for the SDK to answer", () => {
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7")).toEqual({ id: "grok-4.7" });
    expect(resolveCursorSdkModel(CATALOG, "composer-2.5")).toEqual({ id: "composer-2.5" });
    expect(resolveCursorSdkModel(CATALOG, "no-such-model")).toEqual({ id: "no-such-model" });
    expect(resolveCursorSdkModel(CATALOG, "grok-4.7-bogus-word")).toEqual({
      id: "grok-4.7-bogus-word",
    });
  });

  test("an absent model resolves to auto when the catalog lists it, else the first entry; an empty catalog degrades to pass-through", () => {
    expect(resolveCursorSdkModel(CATALOG, undefined)).toEqual({ id: "grok-4.7" });
    expect(resolveCursorSdkModel([{ id: "auto" }, ...CATALOG], undefined)).toEqual({ id: "auto" });
    expect(resolveCursorSdkModel([], undefined)).toEqual({ id: "auto" });
    expect(resolveCursorSdkModel([], "grok-4.7-high")).toEqual({ id: "grok-4.7-high" });
  });
});

describe("model compatibility against the captured account catalog", () => {
  test("native aliases resolve to the entry's actual id; exact auto is the default entry", () => {
    const catalog = catalogOf("default", "gpt-5.3-codex");
    expect(resolveCursorSdkModel(catalog, "auto")).toEqual({ id: "default" });
    expect(resolveCursorSdkModel(catalog, undefined)).toEqual({ id: "default" });
    // An alias decomposes exactly like an id: the codex alias names the
    // gpt-5.3-codex entry, and the selection returns its actual id.
    expect(resolveCursorSdkModel(catalog, "codex-high")).toEqual({
      id: "gpt-5.3-codex",
      params: [
        { id: "reasoning", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
  });

  test("xhigh and extra-high canonicalize for matching; the catalog's own wire value is sent", () => {
    const catalog = catalogOf("grok-4.7", "gpt-5.3-codex", "gpt-5.5");
    // gpt-5.3-codex wires the top tier as extra-high; the hcn slug says xhigh.
    expect(resolveCursorSdkModel(catalog, "gpt-5.3-codex-xhigh")).toEqual({
      id: "gpt-5.3-codex",
      params: [
        { id: "reasoning", value: "extra-high" },
        { id: "fast", value: "false" },
      ],
    });
    // The join spelling keeps resolving against the xhigh-spelling catalog.
    expect(resolveCursorSdkModel(catalog, "grok-4.7-extra-high")).toMatchObject({
      id: "grok-4.7",
      params: expect.arrayContaining([{ id: "reasoning_effort", value: "xhigh" }]),
    });
    // Existing extra-high slugs keep resolving against the extra-high catalog.
    expect(resolveCursorSdkModel(catalog, "gpt-5.5-extra-high")).toMatchObject({
      id: "gpt-5.5",
      params: expect.arrayContaining([{ id: "reasoning", value: "extra-high" }]),
    });
  });

  test("a modifier naming a boolean parameter selects its allowed true value", () => {
    expect(
      resolveCursorSdkModel(catalogOf("claude-opus-5"), "claude-opus-5-thinking-high"),
    ).toEqual({
      id: "claude-opus-5",
      params: [
        { id: "thinking", value: "true" },
        { id: "effort", value: "high" },
        { id: "context", value: "300k" },
        { id: "fast", value: "false" },
      ],
    });
    // The rule needs no displayName on the true value (the capture's fast
    // values all carry one, so this shape is synthetic), and no true is
    // ever inferred for a nonboolean parameter id.
    const bare: CursorSdkModelCatalog = [
      {
        id: "bare-boolean",
        parameters: [
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
          { id: "effort", values: [{ value: "low" }, { value: "high" }] },
        ],
        variants: [
          {
            params: [
              { id: "fast", value: "false" },
              { id: "effort", value: "low" },
            ],
            displayName: "Bare",
          },
        ],
      },
    ];
    expect(resolveCursorSdkModel(bare, "bare-boolean-high-fast")).toEqual({
      id: "bare-boolean",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    expect(resolveCursorSdkModel(catalogOf("grok-4.7"), "grok-4.7-context")).toEqual({
      id: "grok-4.7-context",
    });
  });

  test("historical cursor-prefixed slugs map onto the catalog id before lookup; nothing else is rewritten", () => {
    const catalog = catalogOf("grok-4.5", "grok-4.6");
    expect(resolveCursorSdkModel(catalog, "cursor-grok-4.6")).toEqual({ id: "grok-4.6" });
    expect(resolveCursorSdkModel(catalog, "cursor-grok-4.5-high")).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
    expect(resolveCursorSdkModel(catalog, "cursor-grok-4.6-high-fast")).toEqual({
      id: "grok-4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    // No arbitrary cursor- stripping and no rewrite of unknown models:
    // the original slug passes through for the SDK to answer.
    expect(resolveCursorSdkModel(catalog, "cursor-grok-4.7-high")).toEqual({
      id: "cursor-grok-4.7-high",
    });
    expect(resolveCursorSdkModel(catalog, "cursor-grok-4.5-nonsense")).toEqual({
      id: "cursor-grok-4.5-nonsense",
    });
  });
});

describe("explicit effort through the captured account catalog", () => {
  // The CLI grammar folds medium onto the bare slug for this family
  // (effortSlugs: gpt-5.3-codex medium = gpt-5.3-codex), so the slug alone
  // cannot carry the caller's choice: the native entry's own default is
  // reasoning high, fast true. The explicit effort word rides the open
  // line and pins the parameter here.
  const codex = catalogOf("gpt-5.3-codex");
  const pinnedMedium = {
    id: "gpt-5.3-codex",
    params: [
      { id: "reasoning", value: "medium" },
      { id: "fast", value: "false" },
    ],
  };

  test("exact gpt-5.3-codex plus explicit medium pins reasoning medium, fast false; without effort the native defaults stand", () => {
    expect(resolveCursorSdkModel(codex, "gpt-5.3-codex", "medium")).toEqual(pinnedMedium);
    // The same base without an explicit effort keeps today's contract:
    // the exact id runs with the catalog's own default variant (reasoning
    // high, fast true - the isDefault variant), never a pinned param.
    expect(resolveCursorSdkModel(codex, "gpt-5.3-codex")).toEqual({ id: "gpt-5.3-codex" });
  });

  test("explicit xhigh sends the catalog's own extra-high wire spelling", () => {
    expect(resolveCursorSdkModel(codex, "gpt-5.3-codex", "xhigh")).toEqual({
      id: "gpt-5.3-codex",
      params: [
        { id: "reasoning", value: "extra-high" },
        { id: "fast", value: "false" },
      ],
    });
  });

  test("--effort high on Grok selects the same params as the encoded grok-4.7-high slug", () => {
    expect(resolveCursorSdkModel(catalogOf("grok-4.7"), "grok-4.7", "high")).toEqual(
      resolveCursorSdkModel(catalogOf("grok-4.7"), "grok-4.7-high"),
    );
  });

  test("other explicit slug modifiers survive; explicit effort overrides the effort the slug pinned", () => {
    expect(resolveCursorSdkModel(codex, "gpt-5.3-codex-fast", "medium")).toEqual({
      id: "gpt-5.3-codex",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning", value: "medium" },
      ],
    });
    expect(resolveCursorSdkModel(codex, "gpt-5.3-codex-high", "medium")).toEqual(pinnedMedium);
  });

  test("an unmatchable explicit effort is a configuration failure, never a silent native default", () => {
    // "max" names no value the entry's parameters allow.
    expect(() => resolveCursorSdkModel(codex, "gpt-5.3-codex", "max")).toThrow(
      CursorSdkSelectionError,
    );
    // A slug with no catalog entry cannot pin an effort either, and an
    // empty catalog is not degraded to pass-through when effort is
    // explicit - both would silently run at native defaults.
    expect(() => resolveCursorSdkModel(codex, "no-such-model", "medium")).toThrow(
      CursorSdkSelectionError,
    );
    expect(() => resolveCursorSdkModel([], "gpt-5.3-codex", "medium")).toThrow(
      CursorSdkSelectionError,
    );
    // The error is configuration-styled: the worker's existing class
    // mapping reports it as kind "config" on the private wire.
    const error = resolveFailing(() => resolveCursorSdkModel(codex, "gpt-5.3-codex", "max"));
    expect(error.name).toBe("ConfigurationError");
    expect(error.message).toContain('"max"');
  });
});

describe("access restriction mapping", () => {
  test("explicit read selects the strict allowlist with task and mcp denied, even with autonomy", () => {
    const read = {
      tools: ["read", "grep", "glob", "ls", "webFetch", "webSearch"],
      disallowedTools: ["task", "mcp"],
    };
    expect(cursorSdkAccessRestriction({ access: "read" })).toEqual(read);
    expect(cursorSdkAccessRestriction({ access: "read", autonomy: true })).toEqual(read);
  });

  test("a bare call sets no restriction - the SDK's native toolset and sandbox defaults apply", () => {
    expect(cursorSdkAccessRestriction({})).toEqual({});
  });

  test("write and autonomy run the native toolset explicitly unconfined", () => {
    expect(cursorSdkAccessRestriction({ access: "write" })).toEqual({ sandbox: false });
    expect(cursorSdkAccessRestriction({ autonomy: true })).toEqual({ sandbox: false });
  });
});

describe("error kind vocabulary", () => {
  test("SDK error classes map onto closed kinds", () => {
    expect(cursorSdkErrorKindOf("AuthenticationError")).toBe("auth");
    expect(cursorSdkErrorKindOf("RateLimitError")).toBe("rate-limit");
    expect(cursorSdkErrorKindOf("AgentNotFoundError")).toBe("not-found");
    expect(cursorSdkErrorKindOf("ConfigurationError")).toBe("config");
    expect(cursorSdkErrorKindOf("NetworkError")).toBe("transport");
    expect(cursorSdkErrorKindOf("UnknownAgentError")).toBe("native");
  });

  test("terminal records carry their kind and status through cursorSdkTurnEndOf", () => {
    expect(
      cursorSdkTurnEndOf(
        JSON.parse(encodeCursorSdkTurnEnd({ status: "error", errorKind: "auth" })),
      ),
    ).toEqual({
      status: "error",
      errorKind: "auth",
    });
    expect(cursorSdkTurnEndOf(JSON.parse(encodeCursorSdkTurnEnd({ status: "finished" })))).toEqual({
      status: "finished",
    });
    expect(cursorSdkTurnEndOf({ hcn: "event" })).toBeNull();
  });
});
