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
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { ensureDist } from "./stub-dist.js";

const VERSION = "2026.10.01-e373342";

interface StubOutput {
  /** Cursor stream-json records written to stdout before the stderr. */
  readonly stdout?: readonly Record<string, unknown>[];
  /** The native exit status; 1 is what the captured run exited with. */
  readonly exitCode?: number;
}

/** A stub `agent` that answers the version probe, then prints the given
 * stdout records and stderr lines and exits with the given status. */
const stubScript = (stderrLines: string[], output: StubOutput = {}): string => {
  const stdout = (output.stdout ?? []).map((record) => `${JSON.stringify(record)}\n`).join("");
  return `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log(${JSON.stringify(VERSION)}); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(`${stderrLines.join("\n")}\n`)});\nprocess.exitCode = ${output.exitCode ?? 1};\n`;
};

interface RunResult {
  readonly status: number | null;
  readonly error: NodeJS.ErrnoException | undefined;
  readonly events: Array<Record<string, unknown>>;
}

/** Drive the built CLI against a stub `agent` in fully disposable roots. */
const runStub = (stderrLines: string[], output: StubOutput = {}): RunResult => {
  const cli = ensureDist();
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-keychain-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "cwd"), { recursive: true });
    const stub = join(root, "bin", "agent");
    writeFileSync(stub, stubScript(stderrLines, output), { mode: 0o755 });
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

/** The two captured native lines (ticket #425). */
const KEYCHAIN_LINE = "Error: Your macOS login keychain is locked.";
const UNLOCK_LINE = "Run security unlock-keychain and try again.";
/** More stderr after the wall than the rolling tail keeps (20 lines). */
const LONG_TAIL = Array.from(
  { length: 30 },
  (_, i) => `    at syntheticFrame${i} (synthetic.js:1:1)`,
);

const failuresOf = (events: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  events.filter((e) => e.kind === "failure");

/** The one auth failure event, checked against done.failure field for field. */
const credentialFailureOf = (
  events: Array<Record<string, unknown>>,
  exitCode: number,
): Record<string, unknown> => {
  const failure = failuresOf(events).find((e) => e.class === "auth");
  expect(failure).toMatchObject({
    class: "auth",
    authKind: "credential-access",
    retryable: true,
    nativeExitCode: exitCode,
  });
  const done = doneOf(events);
  expect(done).toMatchObject({ exitCode, cause: "failed" });
  const { kind: _kind, ...summary } = failure as Record<string, unknown>;
  expect(done.failure).toEqual(summary);
  return failure as Record<string, unknown>;
};

describe("cursor credential-access diagnostic survives the turn (issue #425 review)", () => {
  test("the full captured diagnostic keeps both native sentences", () => {
    const run = runStub([KEYCHAIN_LINE, UNLOCK_LINE]);
    expect(run.error).toBeUndefined();
    const failure = credentialFailureOf(run.events, 1);
    expect(failure.message).toContain(KEYCHAIN_LINE);
    expect(failure.message).toContain(UNLOCK_LINE);
    expect(failure.message).toMatch(/owner must restore cursor credential access/);
  });

  test.each([
    ["colored", "\u001b[31mError:\u001b[0m Your macOS login keychain is locked."],
    ["bare", "Your macOS login keychain is locked."],
  ])("a %s credential line followed by a long stderr tail still classifies", (_shape, first) => {
    const run = runStub([first, UNLOCK_LINE, ...LONG_TAIL]);
    expect(run.error).toBeUndefined();
    expect(failuresOf(run.events).map((e) => e.class)).toEqual(["auth"]);
    const failure = credentialFailureOf(run.events, 1);
    expect(failure.message).toContain("Your macOS login keychain is locked.");
    expect(failure.message).toContain(UNLOCK_LINE);
  });

  test("the actual nonzero exit code is preserved in failure and done", () => {
    const run = runStub([KEYCHAIN_LINE, UNLOCK_LINE], { exitCode: 3 });
    expect(run.error).toBeUndefined();
    expect(failuresOf(run.events)).toHaveLength(1);
    credentialFailureOf(run.events, 3);
  });

  test("a native success result does not hide the credential observation", () => {
    const run = runStub([KEYCHAIN_LINE, UNLOCK_LINE], {
      stdout: [{ type: "result", subtype: "success", is_error: false, result: "" }],
    });
    expect(run.error).toBeUndefined();
    expect(failuresOf(run.events).map((e) => e.class)).toEqual(["auth"]);
    credentialFailureOf(run.events, 1);
    // A failed turn never claims native-terminal completion.
    expect(doneOf(run.events).completion).not.toBe("native-terminal");
  });

  test("a lower-precedence stdout failure does not suppress the credential observation", () => {
    const run = runStub([KEYCHAIN_LINE, UNLOCK_LINE], {
      stdout: [{ type: "result", subtype: "error_during_execution", is_error: true }],
    });
    expect(run.error).toBeUndefined();
    expect(failuresOf(run.events).map((e) => e.class)).toEqual(["task", "auth"]);
    const failure = credentialFailureOf(run.events, 1);
    expect(failure.message).toContain(UNLOCK_LINE);
  });
});
