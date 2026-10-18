import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTaskState, primaryWorktree } from "../scripts/task-state.ts";
import { cliFixtureTmpdir } from "./cli/fixture-tmpdir.ts";

const repo = resolve(import.meta.dirname, "..");
const script = join(repo, "scripts/check-task-state.ts");
const helpers = readFileSync(join(repo, "scripts/task-state.ts"), "utf8");
const cli = readFileSync(script, "utf8");
const packageScripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
const temp: string[] = [];
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Placement Test",
  GIT_AUTHOR_EMAIL: "placement@example.invalid",
  GIT_COMMITTER_NAME: "Placement Test",
  GIT_COMMITTER_EMAIL: "placement@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

function put(root: string, name: string, bytes = "test\n"): void {
  const path = join(root, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}

function fixture(separate = false, metadataName = "git data") {
  const base = mkdtempSync(join(cliFixtureTmpdir(), "placement-"));
  temp.push(base);
  const main = join(base, "primary space\n");
  const linked = join(base, "linked space\n");
  mkdirSync(main);
  git(
    main,
    "init",
    "-b",
    "main",
    ...(separate ? ["--separate-git-dir", join(base, metadataName)] : []),
  );
  if (separate) git(main, "config", "core.worktree", main);
  for (const name of ["src/seed.txt", "test/seed.txt", "scripts/seed.txt", "docs/seed.txt"])
    put(main, name);
  put(main, "package.json", '{"type":"module"}');
  put(main, ".gitignore", ".scratch/\n.test-tmp/\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "test: seed");
  git(main, "worktree", "add", "-b", "test-linked", linked);
  return { base, main, linked };
}

function run(cwd: string) {
  return spawnSync("node", [script], {
    cwd,
    env: { ...env, GIT_CEILING_DIRECTORIES: resolve(cwd, "..") },
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const root of temp.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task state ownership", () => {
  it("allows primary scratch and empty linked scratch, resolving from a nested cwd", () => {
    const { main, linked } = fixture();
    put(main, ".scratch/task/checkpoint.md");
    mkdirSync(join(linked, ".scratch"));
    expect(checkTaskState(main)).toEqual([]);
    expect(checkTaskState(join(linked, "src"))).toEqual([]);
    expect(run(linked).status).toBe(0);
  });

  it("rejects ignored linked scratch non-destructively with the actual primary destination", () => {
    const { main, linked } = fixture();
    const bytes = "durable task proof\n";
    put(linked, ".scratch/comment-cleanup/proof.mjs", bytes);
    const before = git(linked, "status", "--porcelain=v1", "--ignored", "-z");
    const result = run(linked);
    expect(result.status).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(
      "task-state: linked checkout contains .scratch state",
    );
    expect(result.stderr).toContain(JSON.stringify(join(main, ".scratch", "<task>")));
    expect(readFileSync(join(linked, ".scratch/comment-cleanup/proof.mjs"), "utf8")).toBe(bytes);
    expect(git(linked, "status", "--porcelain=v1", "--ignored", "-z")).toBe(before);
    expect(existsSync(join(main, ".scratch"))).toBe(false);
  });

  it("rejects scratch symlinks, including dangling links, without following them", () => {
    const { base, linked } = fixture();
    for (const target of [base, join(base, "missing")]) {
      symlinkSync(target, join(linked, ".scratch"));
      expect(checkTaskState(linked)[0]).toContain("linked checkout contains .scratch state");
      rmSync(join(linked, ".scratch"));
    }
  });

  it("rejects ad-hoc ignored or untracked roots and files, even after adding an ignore", () => {
    const { linked } = fixture();
    for (const name of [
      ".review-tests/output.json",
      "another-output/log.txt",
      "notes-for-next-agent.md",
    ])
      put(linked, name);
    put(
      linked,
      ".gitignore",
      ".scratch/\n.review-tests/\nanother-output/\nnotes-for-next-agent.md\n",
    );
    git(linked, "add", ".gitignore");
    const errors = checkTaskState(linked);
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
    const { linked } = fixture();
    for (const name of ["src/new.ts", "test/new.test.ts", "scripts/new.ts", "docs/new.md"])
      put(linked, name);
    expect(checkTaskState(linked)).toEqual([]);
    put(linked, "new-project.json");
    put(linked, "new-project-root/source.ts");
    expect(checkTaskState(linked)).toHaveLength(2);
    git(linked, "add", "new-project.json", "new-project-root/source.ts");
    expect(checkTaskState(linked)).toEqual([]);
  });

  it("allows owned generated outputs and local configuration without reading their contents", () => {
    const { linked } = fixture();
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
      put(linked, `${root}/output`);
    for (const name of [
      "AGENTS.local.md",
      "CLAUDE.local.md",
      ".DS_Store",
      "cache.tsbuildinfo",
      ".hcn/config.json",
      ".lucid/review/run/output",
    ])
      put(linked, name);
    expect(checkTaskState(linked)).toEqual([]);
    put(linked, ".hcn/task-notes.md");
    put(linked, ".lucid/review/task-notes.md");
    expect(checkTaskState(linked)).toHaveLength(2);
  });

  it("resolves separate Git directories and newline paths without branch-name assumptions", () => {
    for (const name of ["git data", ".git"]) {
      const { main, linked } = fixture(true, name);
      put(linked, ".scratch/task/checkpoint.md");
      expect(checkTaskState(main)).toEqual([]);
      expect(checkTaskState(linked)).toEqual([
        `task-state: linked checkout contains .scratch state\nMove task artifacts to ${JSON.stringify(join(main, ".scratch", "<task>"))}. Stage only intended project-history files, never private local configuration.`,
      ]);
    }
  });

  it("fails closed with an actionable limitation for a missing primary or non-repository", () => {
    const { base, main, linked } = fixture(true);
    renameSync(main, join(base, "moved-primary"));
    for (const cwd of [linked, base]) {
      const result = run(cwd);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("task-state: cannot resolve a primary checkout\n");
      expect(result.stderr).toContain("accessible non-bare primary worktree");
    }
  });

  it("fails closed when a separate metadata directory has no explicit primary owner", () => {
    const { main, linked } = fixture(true);
    git(main, "config", "--unset", "core.worktree");
    expect(run(linked).status).toBe(1);
    expect(run(linked).stderr).toContain("task-state: cannot resolve a primary checkout");
  });

  it("never selects a linked checkout when the primary is bare", () => {
    const { base, main } = fixture();
    const bare = join(base, "bare.git");
    git(base, "clone", "--bare", main, bare);
    const linked = join(base, "bare-linked");
    git(bare, "worktree", "add", "-b", "bare-linked", linked);
    expect(run(linked).status).toBe(1);
    expect(run(linked).stderr).toContain("task-state: cannot resolve a primary checkout");
  });

  it("parses NUL records and rejects malformed/bare primary records", () => {
    expect(primaryWorktree("worktree /primary\n path\0HEAD abc\0\0worktree /linked\0\0")).toBe(
      "/primary\n path",
    );
    for (const text of [
      "",
      "HEAD abc\0\0",
      "worktree \0\0",
      "worktree relative\0\0",
      "worktree /bare\0bare\0\0worktree /linked\0\0",
      "worktree /unterminated",
    ]) {
      expect(() => primaryWorktree(text)).toThrow("no usable primary checkout");
    }
  });

  it("keeps the disposable fixture boundary checkout-local, CommonJS and Git-discovery isolated", () => {
    expect(cliFixtureTmpdir()).toBe(join(repo, ".test-tmp", "cli-fixtures"));
    expect(JSON.parse(readFileSync(join(cliFixtureTmpdir(), "package.json"), "utf8"))).toEqual({
      type: "commonjs",
    });
    expect(readdirSync(join(cliFixtureTmpdir(), ".git"))).toEqual([]);
  });
});

describe("placement gate wiring", () => {
  it("matches local check ordering to the explicit CI mirror and runs unconditionally at precommit", () => {
    expect(packageScripts["check:task-state"]).toBe("node scripts/check-task-state.ts");
    const gates = packageScripts.check.split(" && ");
    expect(gates[0]).toBe("pnpm check:task-state");
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
    const mirror = [
      ...ci.matchAll(
        /^ {6}- run: (pnpm (?:check:task-state|lint|typecheck|build|test|test:bun|check:skill|check:package))$/gm,
      ),
    ].map((match) => match[1]);
    expect(mirror).toEqual(gates);
    const hooks = readFileSync(join(repo, "lefthook.yml"), "utf8");
    expect(hooks).toMatch(
      /^pre-commit:\n {2}jobs:\n {4}- name: task-state\n {6}run: node scripts\/check-task-state\.ts\n {4}- name:/,
    );
    const { linked } = fixture();
    put(linked, ".review-tests/output.json");
    const hookCommand = hooks.match(/- name: task-state\n {6}run: (.+)/)?.[1];
    expect(hookCommand).toBeDefined();
    put(linked, "scripts/check-task-state.ts", cli);
    put(linked, "scripts/task-state.ts", helpers);
    const result = spawnSync("sh", ["-c", hookCommand as string], {
      cwd: linked,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-state: unowned top-level path ".review-tests"');
  });

  it("the real pnpm check entry stops on placement before any subsequent gate", () => {
    const { base, linked } = fixture();
    put(linked, "scripts/check-task-state.ts", cli);
    put(linked, "scripts/task-state.ts", helpers);
    put(linked, "package.json", JSON.stringify({ type: "module", scripts: packageScripts }));
    git(linked, "add", "package.json");
    put(linked, ".review-tests/output.json");
    const bin = join(base, "bin");
    mkdirSync(bin);
    const pnpm = execFileSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();
    const sentinel = join(base, "unexpected-gate");
    put(
      bin,
      "pnpm",
      `#!/bin/sh\nif [ "$1" = check:task-state ]; then exec node scripts/check-task-state.ts; fi\nprintf '%s' "$1" > '${sentinel.replaceAll("'", "'\\''")}'\nexit 91\n`,
    );
    execFileSync("chmod", ["+x", join(bin, "pnpm")]);
    const result = spawnSync(pnpm, ["run", "check"], {
      cwd: linked,
      env: { ...env, PATH: `${bin}:${env.PATH}` },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-state: unowned top-level path ".review-tests"');
    expect(existsSync(sentinel)).toBe(false);
  });
});
