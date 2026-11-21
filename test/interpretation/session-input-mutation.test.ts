/**
 * Session-input edge inputs the mutation gate demands (the session-input
 * Stryker lane floors at 99). Every test here names a behavior at the
 * public interpretation seams - encoding without correlation options,
 * probes answered with unusable identity, receipts that correlate to
 * nothing, fallbacks when the native side answers with less than the
 * happy path - with literal expected values, never recomputed ones.
 */
import { describe, expect, test } from "vitest";
import {
  decodeSessionRecord,
  encodeIdentityProbe,
  encodeSessionInput,
  encodeSessionInterrupt,
  hasNativeReceipts,
  IDENTITY_PROBE_ID,
  readInputUuids,
  readInterruptAdvertisement,
  SEND_ID,
} from "../../src/interpretation/session-input.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";

const sessionlessClaude = { ...claudeCode, sessionMode: null } as HarnessDescriptor;
const probelessCodex = {
  ...codexCli,
  sessionMode: { ...codexCli.sessionMode, identityProbe: null },
} as unknown as HarnessDescriptor;
const probelessCursor = {
  ...cursorCli,
  sessionMode: { ...cursorCli.sessionMode, identityProbe: null },
} as unknown as HarnessDescriptor;

describe("bare sends with no correlation options", () => {
  test("a codex send without options starts a turn on an empty thread id", () => {
    expect(encodeSessionInput({ kind: "codex-jsonrpc" }, "hello")).toBe(
      '{"jsonrpc":"2.0","id":"hcn-send","method":"turn/start","params":{"threadId":"","input":[{"text":"hello","type":"text"}]}}\n',
    );
  });

  test("a cursor SDK send without options carries the bare send marker", () => {
    expect(encodeSessionInput({ kind: "cursor-sdk" }, "hello")).toBe(
      '{"hcn":"prompt","id":"hcn-send","message":"hello"}\n',
    );
  });
});

describe("identity probes", () => {
  test("a codex probe without a client version reports version 0 on the initialize handshake", () => {
    const [initialize, open] = (encodeIdentityProbe(codexCli) ?? "").trim().split("\n");
    expect(JSON.parse(initialize ?? "")).toEqual({
      jsonrpc: "2.0",
      id: "hcn-initialize",
      method: "initialize",
      params: { clientInfo: { name: "hcn", version: "0" } },
    });
    expect(JSON.parse(open ?? "")).toEqual({
      jsonrpc: "2.0",
      id: IDENTITY_PROBE_ID,
      method: "thread/start",
      params: {},
    });
  });

  test("a codex resume probe without a session id resumes an empty thread id", () => {
    const [, resume] = (encodeIdentityProbe(codexCli, { isResume: true }) ?? "").trim().split("\n");
    expect(resume).toBe(
      '{"jsonrpc":"2.0","id":"hcn-identity","method":"thread/resume","params":{"threadId":""}}',
    );
  });

  test("a cursor probe without options opens the agent at the SDK's native defaults", () => {
    for (const probe of [encodeIdentityProbe(cursorCli), encodeIdentityProbe(cursorCli, {})]) {
      expect(JSON.parse(probe ?? "")).toEqual({
        hcn: "open",
        id: "hcn-identity",
      });
    }
  });

  test("a cursor probe names a session to resume only when resuming", () => {
    const probe = JSON.parse(encodeIdentityProbe(cursorCli, { sessionId: "agent-1" }) ?? "{}");
    expect("resume" in probe).toBe(false);
  });
});

describe("protocol vocabulary facts", () => {
  test("only receipt-bearing kinds settle sends on native receipts", () => {
    expect(hasNativeReceipts("pi-rpc-prompt")).toBe(true);
    expect(hasNativeReceipts("codex-jsonrpc")).toBe(true);
    expect(hasNativeReceipts("cursor-sdk")).toBe(true);
    expect(hasNativeReceipts("claude-sdk-user-message")).toBe(false);
    expect(hasNativeReceipts("antigravity-stream-user")).toBe(false);
  });

  test("refusing an interrupt names the closed issue", () => {
    expect(() => encodeSessionInterrupt({ kind: "antigravity-stream-user" }, "1")).toThrowError(
      expect.objectContaining({ issue: "unsupported-interrupt" }),
    );
  });
});

describe("claude record reading", () => {
  test("a descriptor without a session mode says nothing about interrupt support", () => {
    expect(
      readInterruptAdvertisement(sessionlessClaude, {
        type: "system",
        subtype: "init",
        capabilities: ["interrupt_receipt_v1"],
      }),
    ).toBeNull();
  });

  test("only a system/init record can advertise interrupt support", () => {
    expect(
      readInterruptAdvertisement(claudeCode, {
        type: "result",
        subtype: "init",
        capabilities: ["interrupt_receipt_v1"],
      }),
    ).toBeNull();
  });

  test("a descriptor without a session mode names no input uuids", () => {
    expect(readInputUuids(sessionlessClaude, { user_message_uuids: ["a"] })).toEqual([]);
  });

  test("a uuid list keeps only its string entries", () => {
    expect(readInputUuids(claudeCode, { user_message_uuids: ["a", 42, null, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("codex session records", () => {
  test("a response without a usable id is ignored", () => {
    expect(decodeSessionRecord(codexCli, { jsonrpc: "2.0", result: {} })).toEqual({
      kind: "ignored",
    });
    expect(decodeSessionRecord(codexCli, { jsonrpc: "2.0", id: 42, result: {} })).toEqual({
      kind: "ignored",
    });
  });

  test("a turn-end notification without params ends the turn unerrored", () => {
    expect(decodeSessionRecord(codexCli, { method: "turn/completed" })).toEqual({
      kind: "turn-end",
      isError: false,
    });
  });

  test("a turn the harness itself calls interrupted ends errored", () => {
    expect(
      decodeSessionRecord(codexCli, {
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      }),
    ).toEqual({ kind: "turn-end", isError: true });
  });

  test("a failed request whose error message is not a string surfaces the whole error object", () => {
    expect(
      decodeSessionRecord(codexCli, { id: `${SEND_ID}:in`, error: { code: -32000, message: 42 } }),
    ).toStrictEqual({
      inputId: "in",
      kind: "command-failed",
      message: 'jsonrpc request failed: {"code":-32000,"message":42}',
    });
  });

  test("a failed request hcn cannot correlate surfaces without an input id", () => {
    expect(
      decodeSessionRecord(codexCli, { id: "other", error: { message: "nope" } }),
    ).toStrictEqual({
      kind: "command-failed",
      message: 'jsonrpc request failed: "other" - nope',
    });
  });

  test("the thread open answer must be a non-empty string id", () => {
    const probeFailed = {
      kind: "probe-failed",
      message: "thread open response carried no thread id",
    };
    expect(decodeSessionRecord(codexCli, { id: IDENTITY_PROBE_ID, result: {} })).toEqual(
      probeFailed,
    );
    expect(
      decodeSessionRecord(codexCli, { id: IDENTITY_PROBE_ID, result: { thread: { id: "" } } }),
    ).toEqual(probeFailed);
    expect(
      decodeSessionRecord(codexCli, { id: IDENTITY_PROBE_ID, result: { thread: { id: 42 } } }),
    ).toEqual(probeFailed);
  });

  test("a descriptor without an identity probe still decodes the answer as a failed probe", () => {
    expect(
      decodeSessionRecord(probelessCodex, {
        id: IDENTITY_PROBE_ID,
        result: { thread: { id: "t1" } },
      }),
    ).toEqual({
      kind: "probe-failed",
      message: "thread open response carried no thread id",
    });
  });

  test("a send receipt that names no turn is accepted without a native turn id", () => {
    expect(decodeSessionRecord(codexCli, { id: `${SEND_ID}:in` })).toStrictEqual({
      inputId: "in",
      kind: "command-accepted",
    });
  });
});

describe("cursor SDK worker records", () => {
  test("an opened line answers only the identity probe; any other id is content", () => {
    expect(decodeSessionRecord(cursorCli, { hcn: "opened", id: "other", agentId: "a1" })).toEqual({
      kind: "content",
    });
  });

  test("the agent id must be a non-empty string", () => {
    const probeFailed = {
      kind: "probe-failed",
      message: "cursor SDK worker announced no agent id",
    };
    expect(
      decodeSessionRecord(cursorCli, { hcn: "opened", id: IDENTITY_PROBE_ID, agentId: "" }),
    ).toEqual(probeFailed);
    expect(
      decodeSessionRecord(cursorCli, { hcn: "opened", id: IDENTITY_PROBE_ID, agentId: 42 }),
    ).toEqual(probeFailed);
    expect(decodeSessionRecord(cursorCli, { hcn: "opened", id: IDENTITY_PROBE_ID })).toEqual(
      probeFailed,
    );
  });

  test("a descriptor without an identity probe still decodes the opened line as a failed probe", () => {
    expect(
      decodeSessionRecord(probelessCursor, {
        hcn: "opened",
        id: IDENTITY_PROBE_ID,
        agentId: "a1",
      }),
    ).toEqual({
      kind: "probe-failed",
      message: "cursor SDK worker announced no agent id",
    });
  });

  test("an open failure without a usable message names its own fallback", () => {
    const fallback = { kind: "probe-failed", message: "cursor SDK agent failed to open" };
    expect(
      decodeSessionRecord(cursorCli, { hcn: "open-failed", id: IDENTITY_PROBE_ID, message: "" }),
    ).toEqual(fallback);
    expect(decodeSessionRecord(cursorCli, { hcn: "open-failed", id: IDENTITY_PROBE_ID })).toEqual(
      fallback,
    );
    expect(
      decodeSessionRecord(cursorCli, { hcn: "open-failed", id: IDENTITY_PROBE_ID, message: 42 }),
    ).toEqual(fallback);
  });

  test("an abort receipt on an unusable or foreign id settles nothing", () => {
    expect(
      decodeSessionRecord(cursorCli, { hcn: "abort-receipt", id: "other", accepted: true }),
    ).toEqual({ kind: "ignored" });
    expect(decodeSessionRecord(cursorCli, { hcn: "abort-receipt", id: 42 })).toEqual({
      kind: "content",
    });
  });

  test("a rejected abort receipt reports rejection", () => {
    expect(
      decodeSessionRecord(cursorCli, {
        hcn: "abort-receipt",
        id: "hcn-interrupt:9",
        accepted: false,
      }),
    ).toEqual({ kind: "interrupt-answered", token: "9", accepted: false });
  });

  test("cancellation of a deferred prompt is correlated without a native turn or failure", () => {
    expect(
      decodeSessionRecord(cursorCli, { hcn: "send-cancelled", id: "hcn-send:17" }),
    ).toStrictEqual({ kind: "command-cancelled", inputId: "17" });
    for (const id of ["other", 42, undefined]) {
      expect(decodeSessionRecord(cursorCli, { hcn: "send-cancelled", id })).toStrictEqual({
        kind: "ignored",
      });
    }
  });

  test("only an explicit boolean idle decline names the absence of a cancellation target", () => {
    expect(
      decodeSessionRecord(cursorCli, {
        hcn: "abort-receipt",
        id: "hcn-interrupt:17",
        accepted: false,
        idle: true,
      }),
    ).toStrictEqual({ kind: "interrupt-answered", token: "17", accepted: false, inactive: true });
    for (const idle of [false, "true", 1, undefined]) {
      expect(
        decodeSessionRecord(cursorCli, {
          hcn: "abort-receipt",
          id: "hcn-interrupt:17",
          accepted: false,
          idle,
        }),
      ).toStrictEqual({ kind: "interrupt-answered", token: "17", accepted: false });
    }
    expect(
      decodeSessionRecord(cursorCli, {
        hcn: "abort-receipt",
        id: "hcn-interrupt:17",
        accepted: true,
        idle: true,
      }),
    ).toStrictEqual({ kind: "interrupt-answered", token: "17", accepted: true });
  });

  test("a receipt correlates only by the send prefix", () => {
    expect(decodeSessionRecord(cursorCli, { hcn: "receipt", id: "other" })).toEqual({
      kind: "ignored",
    });
    expect(decodeSessionRecord(cursorCli, { hcn: "receipt", id: 42 })).toEqual({ kind: "ignored" });
  });

  test("a send failure without a usable message names its own fallback", () => {
    const fallback = { inputId: "5", kind: "command-failed", message: "cursor SDK send failed" };
    expect(
      decodeSessionRecord(cursorCli, { hcn: "send-failed", id: `${SEND_ID}:5`, message: "" }),
    ).toEqual(fallback);
    expect(decodeSessionRecord(cursorCli, { hcn: "send-failed", id: `${SEND_ID}:5` })).toEqual(
      fallback,
    );
    expect(
      decodeSessionRecord(cursorCli, { hcn: "send-failed", id: `${SEND_ID}:5`, message: 42 }),
    ).toEqual(fallback);
  });

  test("a send failure hcn cannot correlate surfaces without an input id", () => {
    expect(
      decodeSessionRecord(cursorCli, { hcn: "send-failed", id: "other", message: "x" }),
    ).toStrictEqual({ kind: "command-failed", message: "x" });
    expect(
      decodeSessionRecord(cursorCli, { hcn: "send-failed", id: 42, message: "x" }),
    ).toStrictEqual({ kind: "command-failed", message: "x" });
  });
});

describe("pi session records", () => {
  test("an interrupt marker on a command that is not abort answers no interrupt", () => {
    expect(
      decodeSessionRecord(piCli, {
        type: "response",
        command: "get_state",
        id: "hcn-interrupt:1",
        success: true,
      }),
    ).toEqual({ kind: "ignored" });
  });

  test("a prompt receipt without a disposition names none", () => {
    expect(
      decodeSessionRecord(piCli, {
        type: "response",
        command: "prompt",
        id: `${SEND_ID}:in`,
        success: true,
      }),
    ).toStrictEqual({ inputId: "in", kind: "command-accepted" });
  });

  test("a failed command hcn cannot correlate surfaces without an input id", () => {
    expect(
      decodeSessionRecord(piCli, {
        type: "response",
        command: "prompt",
        id: "other",
        error: "x",
        success: false,
      }),
    ).toStrictEqual({ kind: "command-failed", message: 'rpc command failed: "prompt" - "x"' });
  });
});

describe("claude control responses", () => {
  test("a control response with no response body is ignored", () => {
    expect(decodeSessionRecord(claudeCode, { type: "control_response" })).toEqual({
      kind: "ignored",
    });
  });

  test("a control response hcn did not write is ignored, not answered", () => {
    expect(
      decodeSessionRecord(claudeCode, {
        type: "control_response",
        response: { subtype: "success", request_id: "other-1" },
      }),
    ).toEqual({ kind: "ignored" });
  });
});

describe("turn-end flags are per-harness", () => {
  test("an antigravity turn-end never carries the pi abort flag", () => {
    expect(
      decodeSessionRecord(antigravityCli, {
        event: "result",
        result: { status: "SUCCESS" },
        aborted: true,
      }),
    ).toStrictEqual({ kind: "turn-end", isError: false });
  });
});
