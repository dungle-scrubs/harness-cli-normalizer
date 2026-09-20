/**
 * RFC-02 change 4: pi's rpc wire protocol lives in interpretation. The
 * session-input module encodes the identity probe and decodes every
 * parsed session record into a closed kind; the runner branches on the
 * kind and holds no harness field names (ADR 0005).
 */
import { describe, expect, test } from "vitest";
import {
  decodeSessionRecord,
  encodeIdentityProbe,
  IDENTITY_PROBE_ID,
} from "../../src/interpretation/session-input.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("identity probe encoding", () => {
  test("pi: one rpc command record carrying the marker id and the descriptor's command", () => {
    expect(encodeIdentityProbe(piCli)).toBe(`{"id":"${IDENTITY_PROBE_ID}","type":"get_state"}\n`);
    expect(piCli.sessionMode?.identityProbe).toEqual({
      command: "get_state",
      responseIdField: "data.sessionId",
    });
  });

  test("claude: no probe, identity arrives on the stream", () => {
    expect(encodeIdentityProbe(claudeCode)).toBeNull();
    expect(encodeIdentityProbe(antigravityCli)).toBeNull();
    expect(
      encodeIdentityProbe({ ...claudeCode, sessionMode: null } as HarnessDescriptor),
    ).toBeNull();
  });

  test("a prompt-wire descriptor with no identity probe stays probe-free", () => {
    const withoutProbe = {
      ...piCli,
      sessionMode: { ...piCli.sessionMode, identityProbe: null },
    } as HarnessDescriptor;

    expect(encodeIdentityProbe(withoutProbe)).toBeNull();
    expect(
      decodeSessionRecord(withoutProbe, {
        type: "response",
        id: IDENTITY_PROBE_ID,
        command: "get_state",
        success: true,
      }),
    ).toEqual({ kind: "ignored" });
  });
});

describe("session record decoding", () => {
  test("pi: the probe response announces identity through the descriptor's id path", () => {
    const record = decodeSessionRecord(piCli, {
      type: "response",
      id: IDENTITY_PROBE_ID,
      command: "get_state",
      success: true,
      data: { sessionId: "01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa" },
    });
    expect(record).toEqual({ kind: "identity", sessionId: "01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa" });
  });

  test("pi: a probe response with no id is a probe failure, never silence", () => {
    const record = decodeSessionRecord(piCli, {
      type: "response",
      id: IDENTITY_PROBE_ID,
      command: "get_state",
      success: true,
      data: {},
    });
    expect(record).toEqual({
      kind: "probe-failed",
      message: "identity probe response carried no sessionId",
    });
  });

  test("pi: every identity marker field must match before a response announces identity", () => {
    const base = {
      type: "response",
      id: IDENTITY_PROBE_ID,
      command: "get_state",
      success: true,
      data: { sessionId: "01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa" },
    };

    expect(decodeSessionRecord(piCli, { ...base, id: "other" })).toEqual({ kind: "ignored" });
    expect(decodeSessionRecord(piCli, { ...base, command: "prompt" })).toEqual({
      kind: "ignored",
    });
    expect(decodeSessionRecord(piCli, { ...base, success: undefined })).toEqual({
      kind: "ignored",
    });
  });

  test("pi: a failed command response surfaces with its command and error", () => {
    const record = decodeSessionRecord(piCli, {
      type: "response",
      id: "x",
      command: "prompt",
      success: false,
      error: "busy",
    });
    expect(record).toMatchObject({ kind: "command-failed" });
    expect((record as { message: string }).message).toContain("prompt");
    expect((record as { message: string }).message).toContain("busy");
  });

  test("pi: any other response is protocol bookkeeping with nothing to surface", () => {
    expect(decodeSessionRecord(piCli, { type: "response", success: true })).toEqual({
      kind: "ignored",
    });
  });

  test("pi: a failed command with no native detail uses the bounded fallback", () => {
    expect(
      decodeSessionRecord(piCli, {
        type: "response",
        id: "x",
        command: "prompt",
        success: false,
      }),
    ).toEqual({
      kind: "command-failed",
      message: 'rpc command failed: "prompt" - "unknown error"',
    });
  });

  test("pi: agent_settled ends the turn; anything else is content", () => {
    expect(decodeSessionRecord(piCli, { type: "agent_settled" })).toEqual({
      kind: "turn-end",
      isError: false,
    });
    expect(decodeSessionRecord(piCli, { type: "message_update" })).toEqual({ kind: "content" });
  });

  test("claude: the result record ends the turn and carries its error flag", () => {
    expect(decodeSessionRecord(claudeCode, { type: "result", is_error: true })).toEqual({
      kind: "turn-end",
      isError: true,
    });
    expect(decodeSessionRecord(claudeCode, { type: "result" })).toEqual({
      kind: "turn-end",
      isError: false,
    });
    expect(decodeSessionRecord(claudeCode, { type: "assistant" })).toEqual({ kind: "content" });
    expect(decodeSessionRecord(claudeCode, { type: "response", success: true })).toEqual({
      kind: "content",
    });
  });

  test("a descriptor with no session mode treats every record as content", () => {
    const withoutSession = { ...claudeCode, sessionMode: null } as HarnessDescriptor;
    expect(decodeSessionRecord(withoutSession, { type: "result", is_error: true })).toEqual({
      kind: "content",
    });
  });

  test("turn-end matching requires every descriptor field", () => {
    const twoFieldTurnEnd = {
      ...claudeCode,
      sessionMode: {
        ...claudeCode.sessionMode,
        turnEnd: { type: "result", subtype: "complete" },
      },
    } as HarnessDescriptor;

    expect(decodeSessionRecord(twoFieldTurnEnd, { type: "result" })).toEqual({ kind: "content" });
    expect(decodeSessionRecord(twoFieldTurnEnd, { type: "result", subtype: "complete" })).toEqual({
      kind: "turn-end",
      isError: false,
    });
  });

  test("Antigravity result status alone determines the session verdict", () => {
    expect(
      decodeSessionRecord(antigravityCli, {
        event: "result",
        is_error: true,
        result: { status: "SUCCESS" },
      }),
    ).toEqual({ kind: "turn-end", isError: false });
    expect(
      decodeSessionRecord(antigravityCli, {
        event: "result",
        is_error: false,
        result: { status: "ERROR" },
      }),
    ).toEqual({ kind: "turn-end", isError: true });
  });
});
