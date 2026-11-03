/**
 * Issue #443: the permission dimensions a session spawn accepts.
 *
 * The CLI surface: --tools/--exclude-tools, --no-tools, --autonomy/
 * --no-autonomy and --access reach the session spawn through the same
 * owners a one-shot turn uses, and the flags ride the ONE process, so the
 * narrowing holds for every turn of the session. What the session still
 * refuses is everything the session grammar cannot carry: a dimension
 * this harness cannot express (pi has no unattended-run flag, claude has
 * no tools-discovery toggle), a combination that has no meaning (an
 * access preset against a tool list), and the dimensions that stay
 * run-only (write, shell, sandbox).
 *
 * These are synthetic processes: they prove the argv and the lifecycle,
 * never that the native harness enforces the permission it was given.
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

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** A fake native peer: it records the argv it was spawned with and then
 * behaves like a session harness - claude stays quiet until its stdin
 * closes, pi answers the identity probe with the session id hcn named. */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.HCN_TEST_ARGV_CAPTURE, JSON.stringify(process.argv));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

const FAKE_PI = `#!${process.execPath}
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

interface SessionRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly events: Record<string, unknown>[];
  /** The argv the fake native peer was spawned with, null when it never
   * started. */
  readonly argv: string[] | null;
  readonly spawned: boolean;
}

const runSession = (
  runtime: string,
  harness: string,
  flags: readonly string[],
  options: { readonly store?: boolean; readonly config?: string } = {},
): SessionRun => {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-permission-"));
  const bin = join(root, "bin");
  const capture = join(root, "argv.json");
  const configDir = join(root, "config");
  mkdirSync(bin);
  mkdirSync(configDir, { recursive: true });
  for (const name of ["claude", "codex", "antigravity", "popeye"]) {
    writeFileSync(join(bin, name), FAKE_CLAUDE, { mode: 0o755 });
  }
  writeFileSync(join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  if (options.config !== undefined) {
    writeFileSync(join(configDir, "config.json"), options.config);
  }
  if (options.store === true) {
    // The native store fixture, resolved the way this repository resolves
    // it: claude files a session at <home>/.claude/projects/<cwd slug>/
    // <id>.jsonl, pi files one flat under PI_CODING_AGENT_SESSION_DIR.
    const slug = realpathSync(root).replace(/[/.]/g, "-");
    const claudeStore = join(root, ".claude", "projects", slug);
    mkdirSync(claudeStore, { recursive: true });
    writeFileSync(join(claudeStore, `${SESSION_ID}.jsonl`), "{}\n");
    const piStore = join(root, "pi-sessions");
    mkdirSync(piStore, { recursive: true });
    writeFileSync(join(piStore, `${SESSION_ID}.jsonl`), "{}\n");
  }
  try {
    const result = spawnSync(runtime, [cli, "session", harness, "--json", ...flags], {
      cwd: root,
      env: {
        HOME: root,
        PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_STATE_HOME: root,
        HCN_CONFIG_DIR: configDir,
        HCN_STATE_DIR: join(root, "state"),
        PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
        HCN_TEST_ARGV_CAPTURE: capture,
      },
      input: "",
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.error).toBeUndefined();
    const spawned = existsSync(capture);
    return {
      status: result.status,
      stderr: result.stderr,
      spawned,
      argv: spawned ? (JSON.parse(readFileSync(capture, "utf8")) as string[]) : null,
      events: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** The value that follows a flag in a captured argv. */
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
};

for (const runtime of runtimes) {
  test(`${runtime}: a claude session carries the tool grant on its spawn argv`, () => {
    const result = runSession(runtime, "claude", ["--tools", "read", "--session-id", SESSION_ID]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.spawned).toBe(true);
    const argv = result.argv ?? [];
    expect(flagValue(argv, "--session-id")).toBe(SESSION_ID);
    expect(flagValue(argv, "--allowedTools")).toBe("Read");
    // claude's include flag grants without restricting, so the complement
    // rides beside it - the same shape a one-shot turn renders.
    expect(flagValue(argv, "--disallowedTools")).toContain("Bash");
    expect(result.events[0]).toMatchObject({ kind: "session", harness: "claude" });
    expect(result.events.at(-1)).toMatchObject({ kind: "closed", cause: "clean", exitCode: 0 });
  });

  test(`${runtime}: a resumed claude session carries the same grant`, () => {
    const result = runSession(runtime, "claude", ["--tools", "read", "--resume", SESSION_ID], {
      store: true,
    });
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    expect(flagValue(argv, "--resume")).toBe(SESSION_ID);
    expect(flagValue(argv, "--allowedTools")).toBe("Read");
  });

  test(`${runtime}: a pi session carries the tool grant on its spawn argv`, () => {
    const result = runSession(runtime, "pi", ["--tools", "read", "--session-id", SESSION_ID]);
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    expect(argv).toContain("--mode");
    expect(argv).toContain("rpc");
    expect(flagValue(argv, "--session-id")).toBe(SESSION_ID);
    expect(flagValue(argv, "--tools")).toBe("read");
  });

  test(`${runtime}: a resumed pi session carries the same grant`, () => {
    const result = runSession(runtime, "pi", ["--tools", "read", "--resume", SESSION_ID], {
      store: true,
    });
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    expect(flagValue(argv, "--session-id")).toBe(SESSION_ID);
    expect(flagValue(argv, "--tools")).toBe("read");
  });

  for (const selection of [
    {
      harness: "claude",
      flags: ["--exclude-tools", "shell"],
      flag: "--disallowedTools",
      value: "Bash",
    },
    {
      harness: "pi",
      flags: ["--exclude-tools", "shell"],
      flag: "--tools",
      value: "read,edit,write,grep,find,ls",
    },
    { harness: "pi", flags: ["--no-tools"], flag: "-nt" },
    { harness: "pi", flags: ["--access", "read"], flag: "--tools", value: "read,grep,find,ls" },
    {
      harness: "claude",
      flags: ["--access", "write"],
      flag: "--permission-mode",
      value: "acceptEdits",
    },
    { harness: "pi", flags: ["--access", "write"] },
    { harness: "claude", flags: ["--no-autonomy"] },
    { harness: "pi", flags: ["--no-autonomy"] },
  ]) {
    test(`${runtime}: ${selection.harness} applies ${selection.flags.join(" ")} at spawn`, () => {
      const result = runSession(runtime, selection.harness, selection.flags);
      expect(result.status, result.stderr).toBe(0);
      expect(result.spawned).toBe(true);
      if (selection.flag !== undefined) {
        expect(result.argv).toContain(selection.flag);
        if (selection.value !== undefined) {
          expect(flagValue(result.argv ?? [], selection.flag)).toBe(selection.value);
        }
      }
      expect(result.argv).not.toContain("--dangerously-skip-permissions");
    });
  }

  for (const harness of ["codex", "antigravity", "popeye"]) {
    for (const flags of [
      ["--tools", "read"],
      ["--exclude-tools", "shell"],
      ["--no-tools"],
      ["--autonomy"],
      ["--no-autonomy"],
      ["--access", "read"],
      ["--access", "write"],
    ]) {
      test(`${runtime}: ${harness} refuses ${flags.join(" ")} before native spawn`, () => {
        const result = runSession(runtime, harness, flags);
        expect(result.status, result.stderr).toBe(2);
        expect(result.spawned).toBe(false);
        expect(result.events).toHaveLength(2);
        expect(result.events[0]).toMatchObject({
          kind: "failure",
          class: "rejected",
          issue: "unsupported-option",
        });
        expect(result.events[1]).toMatchObject({ kind: "closed", cause: "failed" });
      });
    }
  }

  test(`${runtime}: a bare session renders no permission dimension at all`, () => {
    const result = runSession(runtime, "claude", ["--session-id", SESSION_ID]);
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    for (const flag of [
      "--allowedTools",
      "--disallowedTools",
      "--tools",
      "--permission-mode",
      "--dangerously-skip-permissions",
      "-nt",
    ]) {
      expect(argv, `bare session must not render ${flag}`).not.toContain(flag);
    }
  });

  test(`${runtime}: the access preset rides the session spawn`, () => {
    const result = runSession(runtime, "claude", ["--access", "read", "--session-id", SESSION_ID]);
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    expect(flagValue(argv, "--tools")).toBe("Read,Grep,Glob,WebFetch,WebSearch");
    expect(argv).toContain("--permission-mode");
    expect(flagValue(argv, "--permission-mode")).toBe("dontAsk");
  });

  test(`${runtime}: tool lists and an access preset refuse before the spawn`, () => {
    const result = runSession(runtime, "claude", ["--access", "read", "--tools", "read"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "mutually-exclusive-options",
    });
    expect(result.events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
  });

  test(`${runtime}: an include list and an exclude list refuse before the spawn`, () => {
    const result = runSession(runtime, "claude", ["--tools", "read", "--exclude-tools", "shell"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "mutually-exclusive-options",
    });
  });

  test(`${runtime}: an unknown tool name refuses before the spawn`, () => {
    const result = runSession(runtime, "claude", ["--tools", "bogus"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "unknown-tool-name",
    });
  });

  test(`${runtime}: isolation stays refused on a session`, () => {
    const result = runSession(runtime, "claude", ["--isolation", "tool-free"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({ kind: "failure", issue: "invalid-option-value" });
  });

  test(`${runtime}: a harness whose session carries no permission dimension refuses`, () => {
    const result = runSession(runtime, "codex", ["--tools", "read"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "unsupported-option",
      option: "tools",
    });
  });

  test(`${runtime}: pi has no unattended-run flag, so --autonomy refuses`, () => {
    const result = runSession(runtime, "pi", ["--autonomy"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "no-autonomy-mode",
    });
  });

  test(`${runtime}: invalid permissions refuse before an extension probe can spawn`, () => {
    const result = runSession(runtime, "pi", ["--agent", "dev-agent", "--autonomy"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      issue: "no-autonomy-mode",
    });
  });

  test(`${runtime}: claude has no tools-discovery toggle, so --no-tools refuses`, () => {
    const result = runSession(runtime, "claude", ["--no-tools"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.spawned).toBe(false);
    expect(result.events[0]).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "unsupported-option-facet",
    });
  });

  test(`${runtime}: the config toolMap names the native tool on the session spawn`, () => {
    const result = runSession(runtime, "claude", ["--tools", "read", "--session-id", SESSION_ID], {
      config: JSON.stringify({ version: 1, toolMap: { claude: { read: "MyRead" } } }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(flagValue(result.argv ?? [], "--allowedTools")).toBe("MyRead");
  });

  for (const { flags, option } of [
    { flags: ["--write"], option: "write" },
    { flags: ["--no-write"], option: "write" },
    { flags: ["--shell"], option: "shell" },
    { flags: ["--no-shell"], option: "shell" },
    { flags: ["--sandbox", "read-only"], option: "sandbox" },
  ]) {
    test(`${runtime}: ${flags[0]} stays run-only`, () => {
      const result = runSession(runtime, "claude", flags);
      expect(result.status, result.stderr).toBe(2);
      expect(result.spawned).toBe(false);
      expect(result.events[0]).toMatchObject({
        kind: "failure",
        class: "rejected",
        issue: "invalid-option-value",
        option,
      });
      expect(result.stderr).toContain(`${flags[0]} is available only on hcn run, not hcn session`);
    });
  }

  test(`${runtime}: a config permission default never rides a bare session`, () => {
    const result = runSession(runtime, "claude", ["--session-id", SESSION_ID], {
      config: JSON.stringify({ version: 1, tools: ["read"] }),
    });
    expect(result.status, result.stderr).toBe(0);
    const argv = result.argv ?? [];
    expect(argv).not.toContain("--allowedTools");
    expect(argv).not.toContain("--disallowedTools");
  });
}
