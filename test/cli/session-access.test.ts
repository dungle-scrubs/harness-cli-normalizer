import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

/** Issue #392: every permission dimension the common parser accepts but a
 * session never consumes - the eight probed flags from the issue plus the
 * positive --write/--shell spellings, which are the same dimensions as
 * their negations. */
const runOnlyPermissionFlags: ReadonlyArray<{
  readonly flags: readonly string[];
  readonly flag: string;
  readonly option: string;
}> = [
  { flags: ["--tools", "read"], flag: "--tools", option: "tools" },
  { flags: ["--exclude-tools", "shell"], flag: "--exclude-tools", option: "excludeTools" },
  { flags: ["--no-tools"], flag: "--no-tools", option: "discovery.tools" },
  { flags: ["--write"], flag: "--write", option: "write" },
  { flags: ["--no-write"], flag: "--no-write", option: "write" },
  { flags: ["--shell"], flag: "--shell", option: "shell" },
  { flags: ["--no-shell"], flag: "--no-shell", option: "shell" },
  { flags: ["--sandbox", "read-only"], flag: "--sandbox", option: "sandbox" },
  { flags: ["--autonomy"], flag: "--autonomy", option: "autonomy" },
  { flags: ["--no-autonomy"], flag: "--no-autonomy", option: "autonomy" },
];

function runSession(runtime: string, flags: string[]) {
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-session-access-"));
  const bin = join(root, "bin");
  const marker = join(root, "native-spawned");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(runtime, [cli, "session", "claude", "--json", ...flags], {
      cwd: root,
      env: {
        HOME: root,
        PATH: `${bin}:${dirname(runtime)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: root,
        XDG_STATE_HOME: root,
        HCN_CONFIG_DIR: join(root, "config"),
        HCN_STATE_DIR: join(root, "state"),
      },
      input: "",
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      stderr: result.stderr,
      spawned: existsSync(marker),
      events: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const runtime of runtimes) {
  for (const access of ["read", "write"]) {
    test(`${runtime}: session refuses --access ${access} before native spawn`, () => {
      const result = runSession(runtime, ["--access", access]);
      expect(result.status, `${result.stderr}\nnative spawned: ${result.spawned}`).toBe(2);
      expect(result.spawned).toBe(false);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toMatchObject({
        kind: "failure",
        class: "rejected",
        issue: "invalid-option-value",
        option: "access",
      });
      expect(result.events[1]).toMatchObject({ kind: "closed", cause: "failed", exitCode: null });
    });
  }

  test(`${runtime}: a session without --access still spawns and closes cleanly`, () => {
    const result = runSession(runtime, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.spawned).toBe(true);
    expect(result.events[0]).toMatchObject({ kind: "session", harness: "claude" });
    expect(result.events.at(-1)).toMatchObject({ kind: "closed", cause: "clean", exitCode: 0 });
  });

  for (const permission of runOnlyPermissionFlags) {
    test(`${runtime}: session refuses ${permission.flag} before native spawn`, () => {
      const result = runSession(runtime, [...permission.flags]);
      expect(result.status, `${result.stderr}\nnative spawned: ${result.spawned}`).toBe(2);
      expect(result.spawned).toBe(false);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toMatchObject({
        kind: "failure",
        class: "rejected",
        issue: "invalid-option-value",
        option: permission.option,
      });
      expect(result.stderr).toContain(
        `${permission.flag} is available only on hcn run, not hcn session`,
      );
      expect(result.events[1]).toMatchObject({ kind: "closed", cause: "failed", exitCode: null });
    });
  }
}
