/**
 * Issue #446: the user-config `claudeConfigDir` launch setting.
 *
 * Automated callers ran `hcn run claude` without CLAUDE_CONFIG_DIR and hit
 * auth failures even though an interactive login existed, because a login
 * performed against the default directory never reached the spawned CLI in
 * an environment that stripped the variable. The ratified fix is a
 * persistent user-level fallback: `claudeConfigDir` in the hcn user config
 * selects a CLAUDE_CONFIG_DIR for Claude run and session launches only.
 *
 * Precedence, settled in the task spec:
 *   per-run --env CLAUDE_CONFIG_DIR (including the empty delete)
 *     > inherited variable (including an empty inherited value)
 *     > the user-config setting (a fallback, never an override)
 *     > native behavior (no variable added).
 *
 * These are synthetic processes: the fake peers capture ONLY the synthetic
 * CLAUDE_CONFIG_DIR they were handed, which proves hcn's launch wiring and
 * never reads a credential, account state or real configuration directory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

/** Records only the synthetic CLAUDE_CONFIG_DIR the peer was spawned with
 * (null when absent - an inherited empty string stays "" and is distinct
 * from absent), then behaves like the harness the command expects: a
 * one-shot stream-json turn for run, a stdin-quiet process for session. */
const CAPTURE = `require("node:fs").writeFileSync(
  process.env.HCN_TEST_ENV_CAPTURE,
  JSON.stringify({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR === undefined ? null : process.env.CLAUDE_CONFIG_DIR }),
);`;

const RUN_RECORDS = [
  { type: "system", subtype: "init", session_id: SESSION_ID },
  { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } },
  { type: "result", subtype: "success", is_error: false },
]
  .map((record) => JSON.stringify(record))
  .join("\\n");

const FAKE_CLAUDE_RUN = `#!${process.execPath}
${CAPTURE}
process.stdout.write(${JSON.stringify(`${RUN_RECORDS}\\n`)});
`;

const FAKE_CLAUDE_SESSION = `#!${process.execPath}
${CAPTURE}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

const FAKE_PI = `#!${process.execPath}
${CAPTURE}
`;

interface DriveOptions {
  /** The user config JSON written under HCN_CONFIG_DIR. */
  readonly config?: string;
  /** The project config JSON written at <root>/.hcn/config.json. */
  readonly projectConfig?: string;
  /** Extra inherited environment entries (e.g. CLAUDE_CONFIG_DIR). */
  readonly inherited?: Readonly<Record<string, string>>;
  /** File the claude store fixture for a session resume. */
  readonly store?: boolean;
}

interface DriveResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawned: boolean;
  /** The captured synthetic CLAUDE_CONFIG_DIR: string, "" for present but
   * empty, null when the variable was absent. */
  readonly captured: string | null;
}

const drive = (
  runtime: string,
  command: "run" | "session",
  harness: string,
  args: readonly string[],
  options: DriveOptions = {},
): DriveResult => {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-claude-env-"));
  const bin = join(root, "bin");
  const configDir = join(root, "config");
  const capture = join(root, "env.json");
  mkdirSync(bin);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(bin, "claude"), command === "run" ? FAKE_CLAUDE_RUN : FAKE_CLAUDE_SESSION, {
    mode: 0o755,
  });
  writeFileSync(join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  if (options.config !== undefined) {
    writeFileSync(join(configDir, "config.json"), options.config);
  }
  if (options.projectConfig !== undefined) {
    mkdirSync(join(root, ".hcn"));
    writeFileSync(join(root, ".hcn", "config.json"), options.projectConfig);
  }
  if (options.store === true) {
    // Claude files a session at <home>/.claude/projects/<cwd slug>/<id>.jsonl;
    // the session resume guard resolves the store the same way.
    const slug = realpathSync(root).replace(/[/.]/g, "-");
    const claudeStore = join(root, ".claude", "projects", slug);
    mkdirSync(claudeStore, { recursive: true });
    writeFileSync(join(claudeStore, `${SESSION_ID}.jsonl`), "{}\n");
  }
  try {
    const result = spawnSync(
      runtime,
      [
        cli,
        command,
        harness,
        "--json",
        ...(command === "run" ? ["--prompt", "fixture"] : []),
        ...args,
      ],
      {
        cwd: root,
        input: command === "session" ? "" : undefined,
        env: {
          HOME: root,
          PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          XDG_STATE_HOME: root,
          HCN_CONFIG_DIR: configDir,
          HCN_STATE_DIR: join(root, "state"),
          PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
          HCN_TEST_ENV_CAPTURE: capture,
          ...(options.inherited ?? {}),
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    const spawned = existsSync(capture);
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawned,
      captured: spawned
        ? (
            JSON.parse(readFileSync(capture, "utf8") as string) as {
              CLAUDE_CONFIG_DIR: string | null;
            }
          ).CLAUDE_CONFIG_DIR
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const USER_CONFIG = (dir: string): string => JSON.stringify({ version: 1, claudeConfigDir: dir });

for (const runtime of runtimes) {
  test(`${runtime}: run adds no CLAUDE_CONFIG_DIR without the setting`, () => {
    const result = drive(runtime, "run", "claude", []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.spawned).toBe(true);
    expect(result.captured).toBeNull();
    expect(result.stderr).not.toContain("claudeConfigDir");
  });

  test(`${runtime}: a configured claudeConfigDir rides a fresh run`, () => {
    const result = drive(runtime, "run", "claude", [], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.spawned).toBe(true);
    expect(result.captured).toBe("/synthetic/claude-home");
    expect(result.stderr).toContain(
      'provenance: claudeConfigDir = "/synthetic/claude-home" (user-config)',
    );
  });

  test(`${runtime}: a configured claudeConfigDir rides a named resume`, () => {
    const result = drive(runtime, "run", "claude", ["--resume", SESSION_ID], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/claude-home");
  });

  test(`${runtime}: a configured claudeConfigDir rides a resume-last turn`, () => {
    const result = drive(runtime, "run", "claude", ["--resume-last"], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/claude-home");
  });

  test(`${runtime}: an inherited CLAUDE_CONFIG_DIR outranks the setting`, () => {
    const result = drive(runtime, "run", "claude", [], {
      config: USER_CONFIG("/synthetic/claude-home"),
      inherited: { CLAUDE_CONFIG_DIR: "/synthetic/inherited" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/inherited");
  });

  test(`${runtime}: an inherited empty CLAUDE_CONFIG_DIR still outranks the setting`, () => {
    const result = drive(runtime, "run", "claude", [], {
      config: USER_CONFIG("/synthetic/claude-home"),
      inherited: { CLAUDE_CONFIG_DIR: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("");
    expect(result.stderr).not.toContain("provenance: claudeConfigDir");
  });

  test(`${runtime}: a per-run --env CLAUDE_CONFIG_DIR outranks the setting`, () => {
    const result = drive(
      runtime,
      "run",
      "claude",
      ["--env", "CLAUDE_CONFIG_DIR=/synthetic/per-call"],
      {
        config: USER_CONFIG("/synthetic/claude-home"),
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/per-call");
  });

  test(`${runtime}: a per-run --env empty delete drops the variable despite the setting`, () => {
    const result = drive(runtime, "run", "claude", ["--env", "CLAUDE_CONFIG_DIR="], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBeNull();
  });

  test(`${runtime}: the setting leaves another harness untouched`, () => {
    const result = drive(runtime, "run", "pi", [], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.spawned).toBe(true);
    expect(result.status, result.stderr).not.toBe(2);
    expect(result.captured).toBeNull();
  });

  test(`${runtime}: an invalid claudeConfigDir value refuses before spawn`, () => {
    const result = drive(runtime, "run", "claude", [], {
      config: JSON.stringify({ version: 1, claudeConfigDir: "relative/path" }),
    });
    expect(result.status).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.stderr).toContain("config error");
    expect(result.stderr).toContain("must be a non-empty absolute path");
  });

  test(`${runtime}: the project config cannot set claudeConfigDir`, () => {
    const result = drive(runtime, "run", "claude", [], {
      projectConfig: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.stderr).toContain("config error");
    expect(result.stderr).toContain("user-level");
  });

  test(`${runtime}: the project-config rejection fires for another harness too`, () => {
    const result = drive(runtime, "run", "pi", [], {
      projectConfig: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.stderr).toContain("config error");
  });

  test(`${runtime}: a session adds no CLAUDE_CONFIG_DIR without the setting`, () => {
    const result = drive(runtime, "session", "claude", ["--session-id", SESSION_ID]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.spawned).toBe(true);
    expect(result.captured).toBeNull();
  });

  test(`${runtime}: a configured claudeConfigDir rides a fresh session`, () => {
    const result = drive(runtime, "session", "claude", ["--session-id", SESSION_ID], {
      config: USER_CONFIG("/synthetic/claude-home"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/claude-home");
    expect(result.stderr).toContain(
      'provenance: claudeConfigDir = "/synthetic/claude-home" (user-config)',
    );
  });

  test(`${runtime}: a configured claudeConfigDir rides a resumed session`, () => {
    const result = drive(runtime, "session", "claude", ["--resume", SESSION_ID], {
      config: USER_CONFIG("/synthetic/claude-home"),
      store: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/claude-home");
  });

  test(`${runtime}: an inherited CLAUDE_CONFIG_DIR outranks the setting on a session`, () => {
    const result = drive(runtime, "session", "claude", ["--session-id", SESSION_ID], {
      config: USER_CONFIG("/synthetic/claude-home"),
      inherited: { CLAUDE_CONFIG_DIR: "/synthetic/inherited" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("/synthetic/inherited");
  });

  test(`${runtime}: an inherited empty CLAUDE_CONFIG_DIR still outranks the setting on a session`, () => {
    const result = drive(runtime, "session", "claude", ["--session-id", SESSION_ID], {
      config: USER_CONFIG("/synthetic/claude-home"),
      inherited: { CLAUDE_CONFIG_DIR: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.captured).toBe("");
  });
}
