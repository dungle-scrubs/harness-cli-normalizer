import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { resumeStore } from "../../src/cli/resume-guard.js";
import { piCli } from "../../src/knowledge/pi.js";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";

const id = "11111111-1111-4111-8111-111111111111";

test("a verified pi resume emits no unknown-id diagnostic; a missing id never spawns", () => {
  const root = realpathSync(mkdtempSync(join(cliFixtureTmpdir(), "hcn-resume-warning-")));
  try {
    const bin = join(root, "bin");
    const marker = join(root, "spawned");
    mkdirSync(bin);
    const env = {
      HOME: root,
      HCN_CONFIG_DIR: join(root, "hcn-config"),
      PI_CODING_AGENT_DIR: join(root, "pi-config"),
      PATH: bin,
    };
    const check = resumeStore(piCli, { home: root, cwd: root, sessionId: id, env });
    if (check.path === null) throw new Error("pi store path must be checkable");
    mkdirSync(check.path, { recursive: true });
    writeFileSync(join(check.path, `fixture_${id}.jsonl`), "");
    writeFileSync(
      join(bin, "pi"),
      `#!${process.execPath}\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nconsole.log(JSON.stringify({type:"session",id:${JSON.stringify(id)}}));\n`,
      { mode: 0o700 },
    );
    const run = (sessionId: string) =>
      spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "run",
          "pi",
          "hi",
          "--resume",
          sessionId,
          "--cwd",
          root,
          "--questions",
          "none",
          "--json",
        ],
        { env, encoding: "utf8", timeout: 15000 },
      );
    const resumed = run(id);
    expect(resumed.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const events = resumed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.kind === "error" || e.kind === "warning")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    rmSync(marker);
    const missing = run("22222222-2222-4222-8222-222222222222");
    expect(missing.status).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(missing.stdout.split("\n")[0] ?? "")).toMatchObject({
      kind: "failure",
      class: "rejected",
      issue: "invalid-option-value",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
