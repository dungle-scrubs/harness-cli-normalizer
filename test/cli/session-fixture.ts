/**
 * The shared CLI invocation fixture for session-surface tests (review
 * round 1, F12): fake native peers on PATH, an isolated HOME/XDG/state
 * environment, an argv capture, and a temp directory that is always
 * removed in `finally`. The child environment is built from
 * `...process.env` - so a mutation run's activation variables propagate
 * to the CLI child - minus the operator's own hcn configuration and
 * observers, the same way the older CLI fixtures isolate (F11).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

export const cli = resolve("dist/cli.js");
export const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

/** A fake native peer: it records the argv it was spawned with and then
 * behaves like a session harness - claude stays quiet until its stdin
 * closes, pi answers the identity probe with the session id hcn named. */
export const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.HCN_TEST_ARGV_CAPTURE, JSON.stringify(process.argv));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

export const FAKE_PI = `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.HCN_TEST_ARGV_CAPTURE, JSON.stringify(process.argv));
const at = process.argv.indexOf("--session-id");
const id = at >= 0 ? process.argv[at + 1] : "hcn-preview";
let answered = false;
process.stdin.on("data", (chunk) => {
  if (answered) return;
  if (!String(chunk).includes("get_state")) return;
  answered = true;
  process.stdout.write(
    JSON.stringify({
      type: "response",
      id: "hcn-identity",
      command: "get_state",
      success: true,
      data: { sessionId: id },
    }) + "\\n",
  );
});
process.stdin.on("end", () => process.exit(0));
`;

export interface CliFixtureOptions {
  /** stdin for the CLI child (default: empty, immediate EOF). */
  readonly input?: string;
  /** Fake peers to install (default claude and pi). */
  readonly binaries?: readonly string[];
  /** Extra files under the temp root (store fixtures, config). */
  readonly setup?: (root: string) => void;
  /** Additional env overrides, applied after the isolation defaults. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliFixtureRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly events: Record<string, unknown>[];
  /** The argv the fake peer was spawned with, null when none started. */
  readonly argv: string[] | null;
  readonly spawned: boolean;
}

export const runCliFixture = (
  runtime: string,
  args: readonly string[],
  options: CliFixtureOptions = {},
): CliFixtureRun => {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-cli-session-"));
  try {
    const bin = join(root, "bin");
    const capture = join(root, "argv.json");
    mkdirSync(bin);
    for (const name of options.binaries ?? ["claude", "pi"]) {
      writeFileSync(join(bin, name), name === "pi" ? FAKE_PI : FAKE_CLAUDE, { mode: 0o755 });
    }
    options.setup?.(root);
    // Built from ...process.env so a mutation run's sandbox activation
    // reaches the CLI child, minus the operator's own configuration.
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_STATE_HOME: root,
      HCN_STATE_DIR: join(root, "state"),
      PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
      HCN_TEST_ARGV_CAPTURE: capture,
    };
    delete env.HCN_OBSERVER;
    delete env.HCN_INVOCATION_ID;
    delete env.HCN_CONFIG_DIR;
    // The harness-home overrides the fixture owns: leaking the
    // operator's real stores into the child would break the store-path
    // isolation the fresh-env fixtures established (HOME-based stores).
    delete env.CLAUDE_CONFIG_DIR;
    delete env.PI_CODING_AGENT_DIR;
    delete env.CODEX_HOME;
    Object.assign(env, options.env ?? {});
    const result = spawnSync(runtime, [cli, ...args], {
      cwd: root,
      env,
      input: options.input ?? "",
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error).toBeUndefined();
    const spawned = existsSync(capture);
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      events: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      argv: spawned ? (JSON.parse(readFileSync(capture, "utf8")) as string[]) : null,
      spawned,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
