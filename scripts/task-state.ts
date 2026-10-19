import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Repository-owned outputs, not an ignore-pattern policy. Source ownership comes
// from the index below; adding an ignore entry does not create an output owner.
const localOwners = new Set([
  ".git",
  "node_modules",
  "dist",
  ".native-artifacts",
  "coverage",
  "reports",
  ".test-tmp",
  ".lefthook-local",
  ".smoke",
  ".e2e",
  ".DS_Store",
  "AGENTS.local.md",
  "CLAUDE.local.md",
]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function primaryWorktree(porcelain: string): string {
  const fields = porcelain.split("\0");
  const end = fields.indexOf("");
  const first = fields.slice(0, end);
  const path = first[0];
  if (end < 1 || !path?.startsWith("worktree ") || first.includes("bare")) {
    throw new Error("no usable primary checkout (missing record or bare primary)");
  }
  const root = path.slice("worktree ".length);
  if (!isAbsolute(root)) throw new Error("no usable primary checkout (non-absolute owner)");
  return root;
}

function limitation(): string {
  return "task-state: cannot resolve a primary checkout\nRun from a Git checkout with an accessible non-bare primary worktree; restore its location before saving task state.";
}

/** Names and structure in this checkout only; never reads artifact contents. */
export function checkTaskState(cwd: string): string[] {
  let root: string;
  let primary: string;
  let indexed: string[];
  try {
    // rev-parse appends one newline; trim() would corrupt a newline in the path.
    root = realpathSync(git(cwd, "rev-parse", "--show-toplevel").replace(/\n$/, ""));
    primary = realpathSync(primaryWorktree(git(root, "worktree", "list", "--porcelain", "-z")));
    const common = realpathSync(
      git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").replace(/\n$/, ""),
    );
    // Porcelain can name separate metadata (or its parent if named .git).
    // An explicit primary owner takes precedence over that metadata location.
    const explicitOwner = git(
      root,
      "--git-dir",
      common,
      "config",
      "--default",
      "",
      "--get",
      "core.worktree",
    ).replace(/\n$/, "");
    if (explicitOwner) {
      primary = realpathSync(
        git(root, "--git-dir", common, "rev-parse", "--show-toplevel").replace(/\n$/, ""),
      );
    }
    if (primary === common) return [limitation()];
    indexed = git(root, "ls-files", "--cached", "-z").split("\0").filter(Boolean);
  } catch {
    return [limitation()];
  }

  const files = new Set(indexed);
  const sourceRoots = new Set(
    indexed.filter((path) => path.includes("/")).map((path) => path.split("/")[0]),
  );
  const destination = join(primary, ".scratch", "<task>");
  const fix = `Move task artifacts to ${JSON.stringify(destination)}. Stage only intended project-history files, never private local configuration.`;
  const errors: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    if (name === ".scratch") {
      if (root !== primary && (!entry.isDirectory() || readdirSync(join(root, name)).length > 0)) {
        errors.push(`task-state: linked checkout contains .scratch state\n${fix}`);
      }
      continue;
    }
    if (files.has(name) || (entry.isDirectory() && sourceRoots.has(name))) continue;
    if (localOwners.has(name) || name.endsWith(".tsbuildinfo")) continue;
    // Project config has one owner, not an arbitrary artifact directory.
    if (
      name === ".hcn" &&
      entry.isDirectory() &&
      readdirSync(join(root, name)).every(
        (child) => child === "config.json" && lstatSync(join(root, name, child)).isFile(),
      )
    )
      continue;
    // Only the machine-local run subtree has an owner here.
    if (
      name === ".lucid" &&
      entry.isDirectory() &&
      readdirSync(join(root, name)).every((child) => {
        const path = join(root, name, child);
        return lstatSync(path).isDirectory() && readdirSync(path).every((leaf) => leaf === "run");
      })
    )
      continue;
    errors.push(`task-state: unowned top-level path ${JSON.stringify(name)}\n${fix}`);
  }
  return errors;
}
