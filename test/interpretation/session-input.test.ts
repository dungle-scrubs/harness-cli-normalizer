import { describe, expect, test } from "vitest";
import { encodeSessionInput as exportedEncodeSessionInput } from "../../src/interpretation/index.js";
import {
  decodeSessionRecord,
  encodeSessionInput,
  IDENTITY_PROBE_ID,
  resolveSessionInput,
  SEND_ID,
  SessionInputRefusalError,
} from "../../src/interpretation/session-input.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

describe("session input encoding", () => {
  test("encodes one exact Claude SDK user-message record for arbitrary user text", () => {
    const text = 'quote " slash \\ line\ncontrol\u0001';
    const expected = `${String.raw`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"quote \" slash \\ line\ncontrol\u0001"}]}}`}\n`;

    expect(encodeSessionInput({ kind: "claude-sdk-user-message" }, text)).toBe(expected);
  });

  test("Claude declares the session input contract as descriptor data", () => {
    expect(claudeCode.sessionMode?.input).toEqual({ kind: "claude-sdk-user-message" });
  });

  test("encodes one exact Antigravity stream user record", () => {
    expect(encodeSessionInput({ kind: "antigravity-stream-user" }, 'say "hello"\nnext')).toBe(
      '{"event":"user","message":{"content":"say \\"hello\\"\\nnext"}}\n',
    );
    expect(antigravityCli.sessionMode?.input).toEqual({ kind: "antigravity-stream-user" });
  });

  test("encodes correlated Pi prompts and uses native steer only while busy", () => {
    expect(encodeSessionInput({ kind: "pi-rpc-prompt" }, "legacy")).toBe(
      '{"id":"hcn-send","message":"legacy","type":"prompt"}\n',
    );
    expect(encodeSessionInput({ kind: "pi-rpc-prompt" }, "idle", { busy: false, id: "in-1" })).toBe(
      '{"id":"hcn-send:in-1","message":"idle","type":"prompt"}\n',
    );
    expect(encodeSessionInput({ kind: "pi-rpc-prompt" }, "busy", { busy: true, id: "in-2" })).toBe(
      '{"id":"hcn-send:in-2","message":"busy","streamingBehavior":"steer","type":"prompt"}\n',
    );
  });

  test("correlates accepted and rejected Pi prompt responses to their input ids", () => {
    expect(
      decodeSessionRecord(piCli, {
        command: "prompt",
        id: "hcn-send:in-1",
        success: true,
        type: "response",
      }),
    ).toEqual({ inputId: "in-1", kind: "command-accepted" });
    expect(
      decodeSessionRecord(piCli, {
        command: "prompt",
        error: "busy",
        id: "hcn-send:in-2",
        success: false,
        type: "response",
      }),
    ).toEqual({
      inputId: "in-2",
      kind: "command-failed",
      message: 'rpc command failed: "prompt" - "busy"',
    });
    expect(
      decodeSessionRecord(piCli, {
        command: "prompt",
        id: "other",
        success: true,
        type: "response",
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      decodeSessionRecord(piCli, {
        command: "get_state",
        id: "hcn-send:in-3",
        success: true,
        type: "response",
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      decodeSessionRecord(piCli, {
        command: "prompt",
        error: "uncorrelated",
        id: "other",
        success: false,
        type: "response",
      }),
    ).toEqual({
      kind: "command-failed",
      message: 'rpc command failed: "prompt" - "uncorrelated"',
    });
  });

  test("uses Antigravity result status as the persistent-session turn verdict", () => {
    expect(
      decodeSessionRecord(antigravityCli, {
        event: "result",
        result: { status: "SUCCESS", response: "done" },
      }),
    ).toEqual({ kind: "turn-end", isError: false });
    expect(
      decodeSessionRecord(antigravityCli, {
        event: "result",
        result: { status: "ERROR", error: "bad input" },
      }),
    ).toEqual({ kind: "turn-end", isError: true });
  });

  test("refuses a direct session descriptor with no input contract", () => {
    const malformed = {
      ...claudeCode,
      sessionMode: {
        flags: claudeCode.sessionMode?.flags ?? [],
        idFlag: claudeCode.sessionMode?.idFlag ?? "--session-id",
      },
    } as unknown as HarnessDescriptor;

    expect(() => resolveSessionInput(malformed)).toThrowError(SessionInputRefusalError);
    expect(() => resolveSessionInput(malformed)).toThrowError(
      expect.objectContaining({
        issue: "missing-session-input-contract",
      }),
    );
  });

  test("refuses a direct session descriptor with an unsupported input kind", () => {
    const malformed = {
      ...claudeCode,
      sessionMode: {
        ...claudeCode.sessionMode,
        input: { kind: "other-wire-shape" },
      },
    } as unknown as HarnessDescriptor;

    expect(() => resolveSessionInput(malformed)).toThrowError(SessionInputRefusalError);
    expect(() => resolveSessionInput(malformed)).toThrowError(
      expect.objectContaining({
        issue: "unsupported-session-input-kind",
      }),
    );
  });

  test("exports session input interpretation from the public layer entry point", () => {
    expect(exportedEncodeSessionInput).toBe(encodeSessionInput);
  });

  test("keeps protocol marker ids and refusal metadata stable", () => {
    expect(IDENTITY_PROBE_ID).toBe("hcn-identity");
    expect(SEND_ID).toBe("hcn-send");

    const error = new SessionInputRefusalError("missing-session-input-contract");
    expect(error.message).toBe("session input refused: missing-session-input-contract");
    expect(error.name).toBe("SessionInputRefusalError");
  });

  test("turns a descriptor without session mode into the typed missing-contract refusal", () => {
    const withoutSession = { ...claudeCode, sessionMode: null } as HarnessDescriptor;

    expect(() => resolveSessionInput(withoutSession)).toThrowError(
      expect.objectContaining({
        issue: "missing-session-input-contract",
        message: "session input refused: missing-session-input-contract",
        name: "SessionInputRefusalError",
      }),
    );
  });
});

describe("popeye session records", () => {
  test("encodes the popeye prompt frame with the minted session id", () => {
    expect(
      encodeSessionInput({ kind: "popeye-rpc-prompt" }, "hello", {
        busy: false,
        id: "s1",
        sessionId: "sess01",
      }),
    ).toBe('{"_tag":"prompt","content":"hello","id":"hcn-send:s1","sessionId":"sess01"}\n');
  });

  test("the create response announces harness-minted identity", () => {
    expect(
      decodeSessionRecord(popeyeCli, {
        id: IDENTITY_PROBE_ID,
        result: { _tag: "snapshot", sessionId: "sess01" },
      }),
    ).toEqual({ kind: "identity", sessionId: "sess01" });
  });

  test("a prompt snapshot ends the turn", () => {
    expect(
      decodeSessionRecord(popeyeCli, {
        id: `${SEND_ID}:s1`,
        result: { _tag: "snapshot", sessionId: "sess01" },
      }),
    ).toEqual({ kind: "turn-end", isError: false });
  });

  test("a failed command surfaces with its input id", () => {
    expect(
      decodeSessionRecord(popeyeCli, {
        error: { code: "session_not_found" },
        id: `${SEND_ID}:s1`,
      }),
    ).toMatchObject({ inputId: "s1", kind: "command-failed" });
  });
});

test("a prompt snapshot with a failed assistant entry ends the turn failed", () => {
  expect(
    decodeSessionRecord(popeyeCli, {
      id: `${SEND_ID}:s1`,
      result: {
        _tag: "snapshot",
        entries: [
          { kind: "message", payload: { content: "x", role: "assistant", stopReason: "error" } },
        ],
        sessionId: "sess01",
      },
    }),
  ).toEqual({ kind: "turn-end", isError: true });
});
