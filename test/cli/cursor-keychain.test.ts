/**
 * Issue #425, CLI boundary: a synthetic `agent` first on PATH prints the
 * captured locked-keychain stderr and exits 1; the built CLI must classify
 * the turn as an auth failure with kind credential-access, preserving the
 * native sentence and nativeExitCode in both the failure event and
 * done.failure. ANSI coloring around the sentence must not break the
 * match; an unrelated native error stays native; cursor's existing auth
 * wall keeps its immediate classification. Disposable roots only - no real
 * cursor, credentials, or Keychain access anywhere in this file.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureDist } from "./stub-dist.js";

const VERSION = "2026.10.01-e373342";

/** A stub `agent` that answers the version probe, then prints the given
 * stderr lines and exits 1. */
const stubScript = (stderrLines: string[]): string =>
  `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log(${JSON.stringify(VERSION)}); process.exit(0); }\nprocess.stderr.write(${JSON.stringify(`${stderrLines.join("\n")}\n`)});\nprocess.exitCode = 1;\n`;

interface RunResult {
  readonly status: number | null;
  readonly error: NodeJS.ErrnoException | undefined;
  readonly events: Array<Record<string, unknown>>;
}

/** Drive the built CLI against a stub `agent` in fully disposable roots. */
const runStub = (stderrLines: string[]): RunResult => {
  const cli = ensureDist();
  const root = mkdtempSync(join(tmpdir(), "hcn-keychain-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "cwd"), { recursive: true });
    const stub = join(root, "bin", "agent");
    writeFileSync(stub, stubScript(stderrLines), { mode: 0o755 });
    chmodSync(stub, 0o755);
    const nodeDir = dirname(process.execPath);
    const result = spawnSync(
      "node",
      [cli, "run", "cursor", "--access", "read", "--no-autonomy", "--json", "--prompt", "Reply OK"],
      {
        cwd: join(root, "cwd"),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          // The stub dir stays first so `agent` resolves to it; the
          // inherited PATH is kept so `node` stays visible on the bun lane.
          PATH: `${join(root, "bin")}:${nodeDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: root,
          TMPDIR: root,
          LANG: "C",
          XDG_CONFIG_HOME: join(root, "config"),
          HCN_CONFIG_DIR: join(root, "hcn"),
          CURSOR_CONFIG_DIR: join(root, "cursor"),
          HCN_STATE_DIR: process.env.HCN_STATE_DIR,
        },
      },
    );
    const events = String(result.stdout)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { status: result.status, error: result.error, events };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const failureOf = (events: Array<Record<string, unknown>>): Record<string, unknown> => {
  const failure = events.find((e) => e.kind === "failure");
  expect(failure).toBeDefined();
  return failure as Record<string, unknown>;
};

const doneOf = (events: Array<Record<string, unknown>>): Record<string, unknown> => {
  const done = events.at(-1);
  expect(done?.kind).toBe("done");
  return done as Record<string, unknown>;
};

describe("cursor locked-keychain stderr at the built CLI boundary (issue #425)", () => {
  test("the captured stderr yields auth credential-access with sentence, code and hint", () => {
    const run = runStub([
      "Error: Your macOS login keychain is locked.",
      "Run security unlock-keychain and try again.",
    ]);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    const failure = failureOf(run.events);
    expect(failure).toMatchObject({
      class: "auth",
      authKind: "credential-access",
      retryable: true,
      nativeExitCode: 1,
    });
    // The captured native sentence rides in the message, with the owner
    // remedy that names the actual execution context.
    expect(failure.message).toContain("Error: Your macOS login keychain is locked.");
    expect(failure.message).toMatch(/owner must restore cursor credential access/);
    expect(failure.message).toMatch(/never unlocks keychains or enters passwords/);
    const done = doneOf(run.events);
    expect(done).toMatchObject({ exitCode: 1, cause: "failed" });
    const { kind: _kind, ...failureSummary } = failure;
    expect(done.failure).toEqual(failureSummary);
  });

  test("ANSI coloring around the native sentence still classifies", () => {
    const run = runStub([
      "\u001b[31mError:\u001b[0m Your macOS login keychain is locked.",
      "Run security unlock-keychain and try again.",
    ]);
    expect(run.error).toBeUndefined();
    const failure = failureOf(run.events);
    expect(failure).toMatchObject({
      class: "auth",
      authKind: "credential-access",
      nativeExitCode: 1,
    });
    expect(failure.message).toContain("Your macOS login keychain is locked.");
    const { kind: _kind, ...failureSummary } = failure;
    expect(doneOf(run.events).failure).toEqual(failureSummary);
  });

  test("an unrelated native error stays a native failure", () => {
    const run = runStub(["Error: the model backend exploded", "at some/frame.ts:1:1"]);
    expect(run.error).toBeUndefined();
    const failure = failureOf(run.events);
    expect(failure).toMatchObject({ class: "native", nativeExitCode: 1 });
    expect(failure.authKind).toBeUndefined();
    expect(doneOf(run.events).failure).toMatchObject({ class: "native" });
  });

  test.each([
    ["Authentication required. Please run 'agent login' first", "not-logged-in"],
    ["The provided API key is invalid", "invalid-key"],
  ])("cursor's existing auth wall retains its classification: %s", (line, authKind) => {
    const run = runStub([line]);
    expect(run.error).toBeUndefined();
    const failure = failureOf(run.events);
    expect(failure).toMatchObject({ class: "auth", authKind });
    expect(failure.nativeExitCode).toBeUndefined();
    expect(doneOf(run.events).failure).toMatchObject({ class: "auth" });
  });
});
