import { describe, expect, test } from "vitest";
import { encodeSessionInput as exportedEncodeSessionInput } from "../../src/interpretation/index.js";
import {
  encodeSessionInput,
  resolveSessionInput,
  SessionInputRefusalError,
} from "../../src/interpretation/session-input.js";
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
});
