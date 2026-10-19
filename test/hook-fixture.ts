import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cliFixtureTmpdir } from "./cli/fixture-tmpdir.ts";

// Synthetic primary/linked Git repositories for the hook-setup and placement gates.
// Nothing here reads or writes the real repository's Git metadata.

export const repo = resolve(import.meta.dirname, "..");
export const pnpmVersion = JSON.parse(
  readFileSync(join(repo, "package.json"), "utf8"),
).packageManager.replace(/^pnpm@/, "");

export const setupScripts = [
  "install-hooks.ts",
  "git-context.ts",
  "hook-state.ts",
  "hook-dispatch.ts",
  "check-hook-setup.ts",
  "task-state.ts",
  "check-task-state.ts",
];

/** Real Node >= 24. Under Bun, process.execPath is Bun, so ask the `node` on PATH. */
export const node = (() => {
  const path = process.versions.bun
    ? execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim()
    : process.execPath;
  const version = execFileSync(path, ["-p", "process.versions.node"], { encoding: "utf8" });
  if (Number(version.split(".")[0]) < 24)
    throw new Error(`prerequisite: Node >= 24, got ${version}`);
  return realpathSync(path);
})();

const gitBin = dirname(
  realpathSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()),
);

export function baseEnv(base: string): NodeJS.ProcessEnv {
  const temp = join(base, "tmp");
  mkdirSync(temp, { recursive: true });
  return {
    PATH: `${dirname(node)}:${gitBin}:/usr/bin:/bin`,
    HOME: join(base, "home"),
    TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Hook Test",
    GIT_AUTHOR_EMAIL: "hooks@example.invalid",
    GIT_COMMITTER_NAME: "Hook Test",
    GIT_COMMITTER_EMAIL: "hooks@example.invalid",
  };
}

const temp: string[] = [];

export function cleanupFixtures(): void {
  for (const root of temp.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function put(root: string, name: string, bytes: string | Buffer = "test\n"): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export interface FixtureOptions {
  separate?: boolean;
  metadataName?: string;
  primaryName?: string;
  linkedName?: string;
  /** lefthook.yml committed in the fixture; defaults to the repository's own. */
  config?: string;
  /** Copy the installed Lefthook package into the primary's node_modules. */
  lefthook?: boolean;
  files?: Record<string, string>;
}

export interface Fixture {
  base: string;
  main: string;
  linked: string;
  common: string;
  env: NodeJS.ProcessEnv;
  git: (cwd: string, ...args: string[]) => string;
}

/** An owned, empty fixture directory with its isolated base environment. */
export function scratch(): { base: string; env: NodeJS.ProcessEnv } {
  const base = realpathSync(mkdtempSync(join(cliFixtureTmpdir(), "hooks-")));
  temp.push(base);
  const env = baseEnv(base);
  mkdirSync(env.HOME as string);
  return { base, env };
}

export function fixture(options: FixtureOptions = {}): Fixture {
  const { base, env } = scratch();
  const main = join(base, options.primaryName ?? "primary space\n");
  const linked = join(base, options.linkedName ?? "linked space\n");
  const metadata = join(base, options.metadataName ?? "git data");
  // Seeding commits must not run hooks; the hook tests commit through Git explicitly.
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
  mkdirSync(main);
  git(
    main,
    "init",
    "-q",
    "-b",
    "main",
    ...(options.separate ? ["--separate-git-dir", metadata] : []),
  );
  for (const name of ["src/seed.txt", "test/seed.txt", "docs/seed.txt"]) put(main, name);
  for (const name of setupScripts)
    put(main, `scripts/${name}`, readFileSync(join(repo, "scripts", name)));
  put(main, "lefthook.yml", options.config ?? readFileSync(join(repo, "lefthook.yml"), "utf8"));
  put(main, "package.json", '{"type":"module"}\n');
  put(main, ".gitignore", ".scratch/\n.test-tmp/\nnode_modules/\n");
  for (const [name, bytes] of Object.entries(options.files ?? {})) put(main, name, bytes);
  git(main, "add", ".");
  git(main, "commit", "-qm", "test: seed");
  git(main, "worktree", "add", "-q", "-b", "test-linked", linked);
  if (options.lefthook) installLefthook(main);
  const common = realpathSync(options.separate ? metadata : join(main, ".git"));
  return { base, main, linked, common, env, git };
}

/** Copies (never links) the installed Lefthook wrapper and native package into a fixture. */
export function installLefthook(root: string): void {
  const wrapper = realpathSync(join(repo, "node_modules", "lefthook"));
  const platform = `lefthook-${process.platform}-${process.arch}`;
  for (const [from, name] of [
    [wrapper, "lefthook"],
    [join(dirname(wrapper), platform), platform],
  ] as const) {
    cpSync(realpathSync(from), join(root, "node_modules", name), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }
}

/** Runs `source`'s setup script (default: the checkout at cwd) with cwd as the actor. */
export function runSetup(f: Fixture, cwd: string, args: string[] = [], extra = {}, source = cwd) {
  return spawnSync(node, [join(source, "scripts/install-hooks.ts"), ...args], {
    cwd,
    env: { ...f.env, ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
}

export function runScript(f: Fixture, cwd: string, script: string, extra = {}) {
  return spawnSync(node, [join("scripts", script)], {
    cwd,
    env: { ...f.env, ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
}

/** core.worktree as stored, or undefined; read with a clean Git context. */
export function registered(f: Fixture): string | undefined {
  const read = spawnSync(
    "git",
    ["config", "--file", join(f.common, "config"), "--get", "core.worktree"],
    {
      env: f.env,
      encoding: "utf8",
    },
  );
  return read.status === 0 ? read.stdout.replace(/\n$/, "") : undefined;
}

/** pnpm declared by packageManager: npm_execpath when a pnpm run launched us, else PATH. */
export function realPnpm(isolated: NodeJS.ProcessEnv): string {
  const candidates = [
    process.env.npm_execpath,
    spawnSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).stdout.trim(),
  ].filter((path): path is string => Boolean(path) && !String(path).endsWith(".js"));
  for (const path of candidates) {
    const version = spawnSync(path, ["--version"], {
      cwd: isolated.HOME,
      env: isolated,
      encoding: "utf8",
      timeout: 10000,
    });
    if (version.status === 0 && version.stdout.trim() === pnpmVersion) return realpathSync(path);
  }
  throw new Error(
    `prerequisite: pnpm ${pnpmVersion} is required (checked npm_execpath and PATH: ${JSON.stringify(candidates)}). Put the native pnpm ${pnpmVersion} first on PATH.`,
  );
}

/** Fresh HOME, TMPDIR, PNPM_HOME and XDG dirs; no package-manager bootstrap or network. */
export function pnpmEnv(f: Pick<Fixture, "base" | "env">): {
  pnpm: string;
  env: NodeJS.ProcessEnv;
} {
  const env: NodeJS.ProcessEnv = { ...f.env };
  for (const name of [
    "home",
    "pnpm-home",
    "store",
    "xdg/config",
    "xdg/data",
    "xdg/cache",
    "xdg/state",
  ]) {
    mkdirSync(join(f.base, name), { recursive: true });
  }
  Object.assign(env, {
    PNPM_HOME: join(f.base, "pnpm-home"),
    pnpm_config_store_dir: join(f.base, "store"),
    XDG_CONFIG_HOME: join(f.base, "xdg/config"),
    XDG_DATA_HOME: join(f.base, "xdg/data"),
    XDG_CACHE_HOME: join(f.base, "xdg/cache"),
    XDG_STATE_HOME: join(f.base, "xdg/state"),
    PNPM_SHIM_BYPASS: "1",
    COREPACK_ENABLE_NETWORK: "0",
    pnpm_config_offline: "true",
    pnpm_config_pm_on_fail: "ignore",
    pnpm_config_runtime_on_fail: "ignore",
    pnpm_config_verify_deps_before_run: "false",
  });
  const pnpm = realPnpm(env);
  env.PATH = `${dirname(pnpm)}:${env.PATH}`;
  return { pnpm, env };
}
