import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTaskState } from "../scripts/task-state.ts";
import { cliFixtureTmpdir } from "./cli/fixture-tmpdir.ts";
import {
  cleanupFixtures,
  type Fixture,
  type FixtureOptions,
  fixture as gitFixture,
  node,
  pnpmEnv,
  put,
  repo,
  runScript,
  runSetup,
} from "./hook-fixture.ts";

const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const packageScripts: Record<string, string> & { check: string } = packageJson.scripts;

/** Records the owner as setup:hooks does: core.worktree relative to the common directory. */
function register(f: Fixture): void {
  f.git(f.main, "--git-dir", f.common, "config", "core.worktree", relative(f.common, f.main));
}

function fixture(options: FixtureOptions = {}) {
  const f = gitFixture(options);
  register(f);
  return f;
}

function run(f: Fixture, cwd: string, extra = {}) {
  return runScript(f, cwd, "check-task-state.ts", extra);
}

function move(f: Fixture) {
  return `Move task artifacts to ${JSON.stringify(join(f.main, ".scratch", "<task>"))}. Stage only intended project-history files, never private local configuration.`;
}

afterEach(cleanupFixtures);

describe("task state ownership", () => {
  it("allows primary scratch and empty linked scratch, resolving from a nested cwd", () => {
    const f = fixture();
    put(f.main, ".scratch/task/checkpoint.md");
    mkdirSync(join(f.linked, ".scratch"));
    expect(checkTaskState(f.main)).toEqual([]);
    expect(checkTaskState(join(f.linked, "src"))).toEqual([]);
    expect(run(f, f.linked).status).toBe(0);
  });

  it("rejects ignored linked scratch non-destructively with the registered primary destination", () => {
    const f = fixture();
    const bytes = "durable task proof\n";
    put(f.linked, ".scratch/comment-cleanup/proof.mjs", bytes);
    const before = f.git(f.linked, "status", "--porcelain=v1", "--ignored", "-z");
    const result = run(f, f.linked);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(
      "task-state: linked checkout contains .scratch state",
    );
    expect(result.stderr).toContain(JSON.stringify(join(f.main, ".scratch", "<task>")));
    expect(readFileSync(join(f.linked, ".scratch/comment-cleanup/proof.mjs"), "utf8")).toBe(bytes);
    expect(f.git(f.linked, "status", "--porcelain=v1", "--ignored", "-z")).toBe(before);
    expect(existsSync(join(f.main, ".scratch"))).toBe(false);
  });

  it("rejects scratch symlinks, including dangling links, without following them", () => {
    const f = fixture();
    for (const target of [f.base, join(f.base, "missing")]) {
      symlinkSync(target, join(f.linked, ".scratch"));
      expect(checkTaskState(f.linked)[0]).toContain("linked checkout contains .scratch state");
      rmSync(join(f.linked, ".scratch"));
    }
  });

  it("rejects ad-hoc ignored or untracked roots and files, even after adding an ignore", () => {
    const f = fixture();
    for (const name of [
      ".review-tests/output.json",
      "another-output/log.txt",
      "notes-for-next-agent.md",
    ])
      put(f.linked, name);
    put(
      f.linked,
      ".gitignore",
      ".scratch/\n.review-tests/\nanother-output/\nnotes-for-next-agent.md\n",
    );
    f.git(f.linked, "add", ".gitignore");
    const errors = checkTaskState(f.linked);
    expect(errors).toHaveLength(3);
    for (const name of [".review-tests", "another-output", "notes-for-next-agent.md"]) {
      expect(
        errors.some((error) =>
          error.startsWith(`task-state: unowned top-level path ${JSON.stringify(name)}\n`),
        ),
      ).toBe(true);
    }
    expect(
      errors.every((error) => error.includes("Stage only intended project-history files")),
    ).toBe(true);
  });

  it("allows new files under indexed roots and deliberately staged new history", () => {
    const f = fixture();
    for (const name of ["src/new.ts", "test/new.test.ts", "scripts/new.ts", "docs/new.md"])
      put(f.linked, name);
    expect(checkTaskState(f.linked)).toEqual([]);
    put(f.linked, "new-project.json");
    put(f.linked, "new-project-root/source.ts");
    expect(checkTaskState(f.linked)).toHaveLength(2);
    f.git(f.linked, "add", "new-project.json", "new-project-root/source.ts");
    expect(checkTaskState(f.linked)).toEqual([]);
  });

  it("reads the committing checkout's partial index (GIT_INDEX_FILE) as Git hooks pass it", () => {
    const f = fixture();
    put(f.linked, "new-project.json");
    const gitDir = f.git(f.linked, "rev-parse", "--path-format=absolute", "--git-dir").trim();
    const partial = join(f.base, "partial-index");
    copyFileSync(join(gitDir, "index"), partial);
    const env = { GIT_INDEX_FILE: partial };
    expect(
      spawnSync("git", ["add", "new-project.json"], { cwd: f.linked, env: { ...f.env, ...env } })
        .status,
    ).toBe(0);
    expect(run(f, f.linked).status).toBe(1);
    expect(run(f, f.linked, env).status).toBe(0);
    put(f.linked, ".scratch/task/state.md");
    expect(run(f, f.linked, env).stderr).toContain(move(f));
  });

  it("allows owned generated outputs and local configuration without reading their contents", () => {
    const f = fixture();
    for (const root of [
      "node_modules",
      "dist",
      ".native-artifacts",
      "coverage",
      "reports",
      ".test-tmp",
      ".lefthook-local",
      ".smoke",
      ".e2e",
    ])
      put(f.linked, `${root}/output`);
    for (const name of [
      "AGENTS.local.md",
      "CLAUDE.local.md",
      ".DS_Store",
      "cache.tsbuildinfo",
      ".hcn/config.json",
      ".lucid/review/run/output",
    ])
      put(f.linked, name);
    expect(checkTaskState(f.linked)).toEqual([]);
    put(f.linked, ".hcn/task-notes.md");
    put(f.linked, ".lucid/review/task-notes.md");
    expect(checkTaskState(f.linked)).toHaveLength(2);
  });

  it("rejects a .hcn/config.json directory without changing its bytes", () => {
    const f = fixture();
    const bytes = Buffer.from("hidden task state\0not configuration\n");
    put(f.linked, ".hcn/config.json/notes.bin", bytes);
    const result = run(f, f.linked);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe('task-state: unowned top-level path ".hcn"');
    expect(readFileSync(join(f.linked, ".hcn/config.json/notes.bin"))).toEqual(bytes);
    expect(readdirSync(join(f.linked, ".hcn/config.json"))).toEqual(["notes.bin"]);
  });

  it("resolves registered separate Git directories and newline paths without branch-name assumptions", () => {
    for (const name of ["git data", ".git"]) {
      const f = fixture({ separate: true, metadataName: name });
      expect(f.git(f.main, "--git-dir", f.common, "config", "--get", "core.worktree")).toBe(
        "../primary space\n\n",
      );
      put(f.linked, ".scratch/task/checkpoint.md");
      expect(checkTaskState(f.main)).toEqual([]);
      expect(checkTaskState(f.linked)).toEqual([
        `task-state: linked checkout contains .scratch state\n${move(f)}`,
      ]);
    }
  });

  it("fails with setup guidance when no primary is registered, for every metadata layout", () => {
    for (const options of [
      {},
      { separate: true, metadataName: "git data" },
      { separate: true, metadataName: ".git" },
    ]) {
      const f = gitFixture(options);
      put(f.linked, ".scratch/task/checkpoint.md");
      for (const cwd of [f.main, f.linked]) {
        const result = run(f, cwd);
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(
          "task-state: no registered primary checkout\nThe primary checkout cannot be inferred from Git metadata. From the primary checkout root, run `pnpm setup:hooks` to register it.\n",
        );
      }
    }
  });

  it("fails closed for a moved primary, a linked owner, or a non-repository", () => {
    const f = fixture({ separate: true });
    renameSync(f.main, join(f.base, "moved-primary"));
    const moved = run(f, f.linked);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("task-state: registered primary checkout is invalid:");
    expect(moved.stderr).toContain("does not exist");
    const g = gitFixture();
    g.git(g.main, "config", "core.worktree", g.linked);
    expect(run(g, g.linked).stderr).toContain("is not a primary checkout of");
    const outside = join(f.base, "outside");
    mkdirSync(outside);
    const none = spawnSync(node, [join(g.linked, "scripts/check-task-state.ts")], {
      cwd: outside,
      env: f.env,
      encoding: "utf8",
    });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("task-state: cannot resolve a primary checkout\n");
  });

  it("never selects a linked checkout when the primary is bare", () => {
    const f = fixture();
    const bare = join(f.base, "bare.git");
    f.git(f.base, "clone", "-q", "--bare", f.main, bare);
    const linked = join(f.base, "bare-linked");
    f.git(bare, "worktree", "add", "-q", "-b", "bare-linked", linked);
    const result = run(f, linked);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("task-state: no registered primary checkout");
  });

  it("keeps the disposable fixture boundary checkout-local, CommonJS and Git-discovery isolated", () => {
    expect(cliFixtureTmpdir()).toBe(join(repo, ".test-tmp", "cli-fixtures"));
    expect(JSON.parse(readFileSync(join(cliFixtureTmpdir(), "package.json"), "utf8"))).toEqual({
      type: "commonjs",
    });
    expect(readdirSync(join(cliFixtureTmpdir(), ".git"))).toEqual([]);
  });
});

const laterGates = packageScripts.check
  .split(" && ")
  .map((gate) => gate.replace(/^pnpm /, ""))
  .filter((gate) => gate !== "check:setup" && gate !== "check:task-state");

describe("placement gate wiring", () => {
  it("matches local check ordering to the explicit CI mirror and runs unconditionally at precommit", () => {
    expect(packageScripts["check:task-state"]).toBe("node scripts/check-task-state.ts");
    const gates = packageScripts.check.split(" && ");
    expect(gates.slice(0, 2)).toEqual(["pnpm check:setup", "pnpm check:task-state"]);
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
    const mirror = [
      ...ci.matchAll(
        /^ {6}- run: (pnpm (?:check:setup|check:task-state|lint|typecheck|build|test|test:bun|check:skill|check:package))$/gm,
      ),
    ].map((match) => match[1]);
    expect(mirror).toEqual(gates);
    const hooks = readFileSync(join(repo, "lefthook.yml"), "utf8");
    expect(hooks).toMatch(
      /^pre-commit:\n {2}jobs:\n {4}- name: task-state\n {6}run: node scripts\/check-task-state\.ts\n {4}- name:/m,
    );
    const f = fixture();
    put(f.linked, ".review-tests/output.json");
    const hookCommand = hooks.match(/- name: task-state\n {6}run: (.+)/)?.[1];
    expect(hookCommand).toBeDefined();
    const result = spawnSync("sh", ["-c", hookCommand as string], {
      cwd: f.linked,
      env: f.env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-state: unowned top-level path ".review-tests"');
  });

  it("the real pnpm check entry gates readiness, then placement, before every later gate", () => {
    // The actual check pipeline and gate scripts; only later gate bodies become sentinels.
    const scripts = Object.fromEntries(
      Object.entries(packageScripts).map(([name, body]) => [
        name,
        ["check", "check:setup", "check:task-state"].includes(name)
          ? body
          : `printf '%s\\n' ${name} >> "$HCN_GATE_SENTINEL"`,
      ]),
    );
    const f = gitFixture({
      lefthook: true,
      files: {
        "package.json": JSON.stringify({
          type: "module",
          packageManager: packageJson.packageManager,
          scripts,
        }),
        // Own workspace boundary, so the enclosing checkout's workspace is never read.
        "pnpm-workspace.yaml": readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"),
      },
    });
    const { pnpm, env } = pnpmEnv(f);
    const sentinel = join(f.base, "later-gates");
    const check = () => {
      const result = spawnSync(pnpm, ["run", "check"], {
        cwd: f.linked,
        env: { ...env, HCN_GATE_SENTINEL: sentinel },
        encoding: "utf8",
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    };

    const unready = check();
    expect(unready.status).toBe(1);
    expect(unready.stderr).toContain("hook-setup: no registered primary checkout");
    expect(unready.stderr).not.toContain("task-state:");
    expect(existsSync(sentinel)).toBe(false);

    expect(runSetup(f, f.main).status).toBe(0);
    put(f.linked, ".review-tests/output.json");
    const misplaced = check();
    expect(misplaced.status).toBe(1);
    expect(misplaced.stderr).toContain('task-state: unowned top-level path ".review-tests"');
    expect(existsSync(sentinel)).toBe(false);
    rmSync(join(f.linked, ".review-tests"), { recursive: true });

    const bytes = Buffer.from("operator bytes\0kept\n");
    put(f.linked, ".hcn/config.json/state.bin", bytes);
    const directory = check();
    expect(directory.status).toBe(1);
    expect(directory.stderr).toContain('task-state: unowned top-level path ".hcn"');
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(f.linked, ".hcn/config.json/state.bin"))).toEqual(bytes);
    rmSync(join(f.linked, ".hcn"), { recursive: true });

    const clean = check();
    expect(clean.stderr).not.toContain("task-state:");
    expect(clean.status).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe(`${laterGates.join("\n")}\n`);
  }, 60_000);
});
