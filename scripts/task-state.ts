import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { git, gitPath, ownerFailure, resolveOwner } from "./git-context.ts";

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

function limitation(): string {
  return "task-state: cannot resolve a primary checkout\nRun from a Git checkout whose primary checkout is registered by `pnpm setup:hooks`; no files were changed.";
}

/** Names and structure in this checkout only; never reads artifact contents. */
export function checkTaskState(cwd: string): string[] {
  let root: string;
  let primary: string;
  let indexed: string[];
  try {
    // This checkout's own context, including a partial commit's GIT_INDEX_FILE.
    root = gitPath(cwd, ["--show-toplevel"]);
    const owner = resolveOwner(gitPath(root, ["--git-common-dir"]));
    if (owner.kind !== "registered") return [ownerFailure(owner, "task-state")];
    primary = owner.root;
    indexed = git(root, ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean);
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
