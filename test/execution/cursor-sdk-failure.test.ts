import { describe, expect, test } from "vitest";
import { failureFromCursorSdkRecord } from "../../src/execution/cursor-sdk-failure.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { FakeClock } from "./fakes.js";

describe("SDK authentication evidence", () => {
  for (const [message, authKind] of [
    ["Invalid API key. Please check your Cursor API key and try again.", "invalid-key"],
    ["Your macOS login keychain is locked.", "credential-access"],
  ] as const) {
    test(`typed authentication retains the observed ${authKind} subtype`, () => {
      const failure = failureFromCursorSdkRecord(
        cursorCli,
        { hcn: "open-failed", errorKind: "auth", message },
        new FakeClock(),
      );
      expect(failure).toMatchObject({ class: "auth", authKind, retryable: true });
      if (authKind === "credential-access") {
        expect(failure?.message).toContain("owner must restore");
        expect(failure?.message).not.toContain("re-authenticate");
      }
    });
  }
});
