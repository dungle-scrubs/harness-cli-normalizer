/**
 * Issue #443: the session preview. `hcn inspect <harness> --argv --mode
 * headless-session` previews the argv a SESSION would spawn - the same
 * builder the spawn uses - so the preview and the spawn agree by
 * construction. The preview names the session it previews: --resume
 * previews a resumed one, --session-id a fresh one, and neither previews
 * the stable placeholder id.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

const runInspect = (runtime: string, args: readonly string[]) => {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-inspect-session-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // The runtime report asks the installed harness for its version; the
  // fake answers so the preview can complete.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\n' '${claudeCode.verifiedAgainst}'\n`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(runtime, [cli, "inspect", ...args], {
      cwd: root,
      env: {
        HOME: root,
        PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: root,
        XDG_STATE_HOME: root,
        HCN_CONFIG_DIR: join(root, "config"),
        HCN_STATE_DIR: join(root, "state"),
      },
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const argvOf = (stdout: string): string[] => JSON.parse(stdout) as string[];
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

for (const runtime of runtimes) {
  test(`${runtime}: the session preview names the placeholder id when none is given`, () => {
    const result = runInspect(runtime, ["claude", "--argv", "--mode", "headless-session"]);
    expect(result.status, result.stderr).toBe(0);
    const argv = argvOf(result.stdout);
    expect(flagValue(argv, "--session-id")).toBe(PREVIEW_ID);
    expect(result.stderr).toContain("argv:");
  });

  test(`${runtime}: the session preview renders a permission dimension`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--tools",
      "read",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const argv = argvOf(result.stdout);
    expect(flagValue(argv, "--allowedTools")).toBe("Read");
  });

  test(`${runtime}: the session preview names a resumed session`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--resume",
      SESSION_ID,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const argv = argvOf(result.stdout);
    expect(flagValue(argv, "--resume")).toBe(SESSION_ID);
  });

  test(`${runtime}: the session preview names a fresh session`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--session-id",
      SESSION_ID,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const argv = argvOf(result.stdout);
    expect(flagValue(argv, "--session-id")).toBe(SESSION_ID);
  });

  test(`${runtime}: two answers to one question refuse`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--resume",
      SESSION_ID,
      "--session-id",
      SESSION_ID,
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("--resume or --session-id");
  });

  test(`${runtime}: runtime inspection also refuses conflicting session aliases`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--runtime",
      "--mode",
      "headless-session",
      "--resume",
      SESSION_ID,
      "--session-id",
      SESSION_ID,
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("--resume or --session-id");
  });

  test(`${runtime}: an unusable session id refuses`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--session-id",
      "bogus",
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("session id");
  });

  test(`${runtime}: a session grammar without the permission capability refuses`, () => {
    const result = runInspect(runtime, [
      "codex",
      "--argv",
      "--mode",
      "headless-session",
      "--tools",
      "read",
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("carries no permission dimension");
  });

  test(`${runtime}: an unsupported preview option refuses`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--isolation",
      "tool-free",
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Unsupported persistent session preview options");
  });

  test(`${runtime}: the runtime report keeps its own format`, () => {
    const result = runInspect(runtime, [
      "claude",
      "--runtime",
      "--mode",
      "headless-session",
      "--resume",
      SESSION_ID,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const facts = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(facts.argvKind).toBe("redacted-preview");
    expect(Array.isArray(facts.argv)).toBe(true);
    expect((facts.argv as string[]).indexOf("--resume")).toBeGreaterThan(-1);
  });
}
