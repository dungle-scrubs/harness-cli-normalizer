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
