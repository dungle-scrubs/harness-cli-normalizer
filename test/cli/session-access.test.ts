import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const cli = resolve("dist/cli.js");
const runtimes = ["node", "bun"].map((name) =>
  execFileSync("which", [name], { encoding: "utf8" }).trim(),
);

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
}
