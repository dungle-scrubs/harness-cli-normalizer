import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Standard library only: setup:hooks deploys this file beside the hook dispatcher.

let localVariables: string[] | undefined;

/** The environment without Git's repository-local variables (GIT_DIR, GIT_INDEX_FILE, ...). */
export function withoutRepositoryContext(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  localVariables ??= execFileSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    env: { PATH: env.PATH },
    timeout: 5000,
  })
    .split("\n")
    .filter(Boolean);
  const clean = { ...env };
  for (const name of localVariables) delete clean[name];
  return clean;
}

/** Runs Git and returns stdout without its single trailing newline; paths may contain newlines. */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

export function gitPath(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", ...args], env));
}

export type Owner =
  | { kind: "registered"; root: string; common: string }
  | { kind: "missing"; common: string }
  | { kind: "invalid"; common: string; reason: string };

export const missingOwnerHelp =
  "The primary checkout cannot be inferred from Git metadata. From the primary checkout root, run `pnpm setup:hooks` to register it.";

/** The diagnostic for an unusable owner, prefixed with the reporting command's label. */
export function ownerFailure(owner: Exclude<Owner, { kind: "registered" }>, label: string): string {
  return owner.kind === "missing"
    ? `${label}: no registered primary checkout\n${missingOwnerHelp}`
    : `${label}: registered primary checkout is invalid: ${owner.reason}\nRepair core.worktree deliberately, then run \`pnpm setup:hooks\` from the primary checkout root.`;
}

/**
 * Reads the primary checkout that `pnpm setup:hooks` registered as `core.worktree` in the common
 * Git directory. Native metadata is queried only to validate it; nothing is guessed.
 */
export function resolveOwner(commonDir: string): Owner {
  const common = realpathSync(commonDir);
  const env = withoutRepositoryContext();
  // Read the file outside any repository: discovery would first enter a stale core.worktree.
  const read = spawnSync(
    "git",
    ["config", "--file", join(common, "config"), "--get", "core.worktree"],
    { cwd: "/", env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (read.status === 1 && read.stdout === "") return { kind: "missing", common };
  if (read.status !== 0) return { kind: "invalid", common, reason: "core.worktree is unreadable" };
  const value = read.stdout.replace(/\n$/, "");
  // Git resolves a relative core.worktree against the Git directory.
  const declared = isAbsolute(value) ? value : resolve(common, value);
  let root: string;
  try {
    root = realpathSync(declared);
  } catch {
    return { kind: "invalid", common, reason: `${JSON.stringify(declared)} does not exist` };
  }
  try {
    if (gitPath(root, ["--show-toplevel"], env) !== root) throw new Error();
    if (gitPath(root, ["--git-dir"], env) !== common) throw new Error();
    if (gitPath(root, ["--git-common-dir"], env) !== common) throw new Error();
  } catch {
    return {
      kind: "invalid",
      common,
      reason: `${JSON.stringify(root)} is not a primary checkout of ${JSON.stringify(common)}`,
    };
  }
  return { kind: "registered", root, common };
}
