import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const launchId = "cf548bfb-e24e-4bb0-ab3e-ad9c70ac04db";
const sessionId = "407feafe-e82b-4df4-91ba-4f1aeb987508";

interface CliOutput {
  readonly control: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function runCli(
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
): CliOutput {
  const executable = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  const output = execFileSync(
    "node",
    [resolve("test/cli/interactive-driver.ts"), JSON.stringify({ args, environment, executable })],
    { encoding: "utf8", timeout: 5000 },
  );
  return JSON.parse(output) as CliOutput;
}

test("interactive refuses prompt or model substitution through the separate control pipe", () => {
  const { control, exitCode, stderr, stdout } = runCli([
    "src/cli/index.ts",
    "interactive",
    "codex",
    "--interface",
    "codex-cli",
    "--launch-id",
    launchId,
    "--resume",
    sessionId,
    "--cwd",
    process.cwd(),
    "--control-fd",
    "3",
    "--model",
    "substituted-model",
  ]);
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(control.endsWith("\n")).toBe(true);
  expect(
    control
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    {
      evidence: "spawn-not-attempted",
      kind: "refused",
      launchId,
      operation: "interactive",
      reason: "invalid-request",
      v: 1,
    },
  ]);
});

function launchFixture(root: string, searchPath: string, extra: readonly string[] = []): CliOutput {
  return runCli(
    [
      resolve("src/cli/index.ts"),
      "interactive",
      "codex",
      "--interface",
      "codex-cli",
      "--launch-id",
      launchId,
      "--resume",
      sessionId,
      "--cwd",
      root,
      "--control-fd",
      "3",
      ...extra,
    ],
    {
      HOME: root,
      PATH: searchPath,
    },
  );
}

function codexFixture(): {
  readonly nativeDir: string;
  readonly rollout: string;
  readonly root: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hcn-interactive-")));
  const nativeDir = join(root, "bin");
  const sessions = join(root, ".codex", "sessions", "2026", "09", "12");
  mkdirSync(nativeDir);
  mkdirSync(sessions, { recursive: true });
  // Synthetic native store and executable boundary, not captured harness output.
  const rollout = join(sessions, `rollout-2026-09-12T00-00-00-${sessionId}.jsonl`);
  writeFileSync(
    rollout,
    `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: root } })}\n`,
  );
  symlinkSync(realpathSync(process.execPath), join(nativeDir, "codex"));
  return { nativeDir, rollout, root };
}

test("interactive resumes the exact saved Codex session and separates terminal bytes from lifecycle", () => {
  const { nativeDir, root } = codexFixture();
  writeFileSync(
    join(root, "resume"),
    `
    console.log("NATIVE:" + JSON.stringify(process.argv.slice(2)));
    console.error("NATIVE STDERR");
    process.stdin.once("data", () => process.exit(7));
    process.stdin.once("end", () => process.exit(70));
    process.stdin.resume();
  `,
  );
  const { control, exitCode, stderr, stdout } = launchFixture(root, nativeDir);
  try {
    expect(exitCode).toBe(7);
    expect(stdout).toBe(`NATIVE:${JSON.stringify([sessionId, "--cd", root])}\n`);
    expect(stderr).toBe("NATIVE STDERR\n");
    const records = control
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(["ready", "started", "closed"]);
    for (const record of records)
      expect(record).toMatchObject({ launchId, operation: "interactive", v: 1 });
    expect(records[1]).toMatchObject({
      cwd: root,
      interface: "codex-cli",
      sessionId,
      owner: { executable: realpathSync(process.execPath) },
    });
    expect(records[1].owner.pid).toBeGreaterThan(0);
    expect(records[2]).toMatchObject({ cleanupComplete: true, exitCode: 7 });
    expect(control).not.toContain("NATIVE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive refuses a PATH-selected wrapper rather than choosing a later executable", () => {
  const { nativeDir, root } = codexFixture();
  const wrapperDir = join(root, "wrapper");
  mkdirSync(wrapperDir);
  writeFileSync(join(wrapperDir, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const { control, exitCode, stderr, stdout } = launchFixture(root, `${wrapperDir}:${nativeDir}`);
  try {
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(
      control
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        evidence: "spawn-not-attempted",
        kind: "refused",
        launchId,
        operation: "interactive",
        reason: "executable-unavailable",
        v: 1,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive applies validated integration environment before checking the exact session", () => {
  const { nativeDir, root } = codexFixture();
  const { control, exitCode, stderr, stdout } = launchFixture(root, nativeDir, [
    "--env",
    `CODEX_HOME=${join(root, "absent-store")}`,
  ]);
  try {
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(
      control
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        evidence: "spawn-not-attempted",
        kind: "refused",
        launchId,
        operation: "interactive",
        reason: "resume-unavailable",
        v: 1,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict resume refuses mismatched saved identity or folder before creating a process", () => {
  const { nativeDir, rollout, root } = codexFixture();
  const anotherFolder = join(root, "another-project");
  mkdirSync(anotherFolder);
  try {
    for (const scenario of [
      { cwd: root, id: "a77a4107-460c-4ab6-8b1b-506a54b27d11", reason: "resume-unavailable" },
      { cwd: anotherFolder, id: sessionId, reason: "cwd-refused" },
    ]) {
      writeFileSync(
        rollout,
        `${JSON.stringify({ type: "session_meta", payload: { cwd: scenario.cwd, id: scenario.id } })}\n`,
      );
      const { control, exitCode, stderr, stdout } = launchFixture(root, nativeDir);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(
        control
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        {
          evidence: "spawn-not-attempted",
          kind: "refused",
          launchId,
          operation: "interactive",
          reason: scenario.reason,
          v: 1,
        },
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launch without a usable control address exits uncertain and emits no refusal record", () => {
  const result = runCli(["src/cli/index.ts", "interactive", "codex"]);
  expect(result.exitCode).toBe(1);
  expect(result.control).toBe("");
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("control fd >= 3");
});
