/**
 * Issue #425, CLI boundary on the Cursor SDK backend (issue #440): the
 * worker's open-failure message carrying the captured locked-keychain
 * sentence must classify as an auth failure with kind credential-access,
 * preserving the native sentence. ANSI coloring around the sentence must
 * not break the match; an unrelated native startup error stays native
 * (nothing ran, so no work verdict). The captured CLI-stderr shape this
 * file drove before the SDK backend stays covered at the supervisor level
 * (test/execution/credential-access.test.ts); the stream-reported message
 * carries no native exit code, so the old nativeExitCode assertion is
 * retired with the CLI path that produced it.
 */
import { describe, expect, test } from "vitest";
import { ndjsonOf, runCliWithFakeSdk } from "./cursor-sdk-fixture.js";

const runOpenError = async (message: string, name = "Error") =>
  runCliWithFakeSdk({
    script: { openError: { name, message } },
    args: ["run", "cursor", "--access", "read", "--no-autonomy", "--json", "--prompt", "Reply OK"],
  });

const failureOf = (events: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => {
  const failure = events.find((e) => e.kind === "failure");
  expect(failure).toBeDefined();
  return failure as Record<string, unknown>;
};

describe("cursor locked-keychain at the built CLI boundary (issue #425, SDK backend)", () => {
  test("the captured sentence yields auth credential-access with the owner remedy", async () => {
    const run = await runOpenError(
      "Error: Your macOS login keychain is locked.\nRun security unlock-keychain and try again.",
    );
    try {
      expect(run.status, run.stderr).toBe(1);
      const events = ndjsonOf(run.stdout);
      const failure = failureOf(events);
      expect(failure).toMatchObject({
        class: "auth",
        authKind: "credential-access",
        retryable: true,
      });
      // The captured native sentence rides in the message, with the owner
      // remedy that names the actual execution context.
      expect(failure.message).toContain("Error: Your macOS login keychain is locked.");
      expect(failure.message).toMatch(/owner must restore cursor credential access/);
      expect(failure.message).toMatch(/never unlocks keychains or enters passwords/);
      const done = events.at(-1) as Record<string, unknown>;
      expect(done).toMatchObject({ kind: "done", cause: "failed" });
      const { kind: _kind, ...failureSummary } = failure;
      expect(done.failure).toEqual(failureSummary);
    } finally {
      run.cleanup();
    }
  });

  test("ANSI coloring around the native sentence still classifies", async () => {
    const run = await runOpenError(
      "\u001b[31mError:\u001b[0m Your macOS login keychain is locked.\nRun security unlock-keychain and try again.",
    );
    try {
      const failure = failureOf(ndjsonOf(run.stdout));
      expect(failure).toMatchObject({ class: "auth", authKind: "credential-access" });
    } finally {
      run.cleanup();
    }
  });

  test("an unrelated native startup error stays a native failure, never a work verdict", async () => {
    const run = await runOpenError("Some unrelated native failure", "UnknownAgentError");
    try {
      const events = ndjsonOf(run.stdout);
      const failure = failureOf(events);
      expect(failure).toMatchObject({ class: "native", retryable: false });
      // Native failures keep the crash classification, like the CLI path.
      expect(events.at(-1)).toMatchObject({ kind: "done", cause: "crash" });
    } finally {
      run.cleanup();
    }
  });
});
