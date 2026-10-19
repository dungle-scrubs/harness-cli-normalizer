import { execFileSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { git, gitPath, resolveOwner, withoutRepositoryContext } from "./git-context.ts";
import {
  configuredHooks,
  deployedFiles,
  inspectHookSetup,
  installedLefthook,
  layout,
  type Manifest,
  namespace,
  readManifest,
  runtimePackageJson,
  runtimeSources,
  sha256,
  shimText,
} from "./hook-state.ts";

// The one deliberate writer of shared hook state: `pnpm setup:hooks` at the primary checkout root.
// The script, its Lefthook and its config may come from another checkout of the same repository
// (`node <checkout>/scripts/install-hooks.ts`); the primary at cwd is what gets registered.
// Every check runs before the first write. `--replace` consents to replacing any configured hook
// this setup did not write, and an outside hook path; they are backed up first.

const usage = "Usage: node <checkout>/scripts/install-hooks.ts [--replace], from the primary root";

function fail(message: string): never {
  throw new Error(`setup:hooks: ${message}`);
}

function isManaged(manifest: string): boolean {
  try {
    readManifest(manifest);
    return true;
  } catch {
    return false;
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function main(argv: string[]): void {
  const unknown = argv.filter((arg) => arg !== "--replace");
  if (unknown.length > 0) fail(`unknown argument ${JSON.stringify(unknown[0])}\n${usage}`);
  const replace = argv.includes("--replace");

  // Inherited GIT_DIR/GIT_WORK_TREE could present a linked checkout as the primary.
  const env = withoutRepositoryContext();
  const cwd = realpathSync(process.cwd());
  let top: string;
  let gitDir: string;
  let common: string;
  try {
    top = gitPath(cwd, ["--show-toplevel"], env);
    gitDir = gitPath(cwd, ["--git-dir"], env);
    common = gitPath(cwd, ["--git-common-dir"], env);
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    const reason = (stderr || message).trim();
    fail(`run from the root of a non-bare primary Git checkout${reason ? `\n${reason}` : ""}`);
  }
  if (gitDir !== common) {
    fail("this is a linked checkout; run `pnpm setup:hooks` from the primary checkout root");
  }
  // A registered core.worktree also moves Git's toplevel, so compare the owner with cwd.
  const owner = resolveOwner(common);
  if (owner.kind === "invalid") {
    fail(
      `existing core.worktree is invalid: ${owner.reason}\nRepair or unset it deliberately first.`,
    );
  }
  if (owner.kind === "registered" && !inside(cwd, owner.root)) {
    fail(`primary already registered as ${JSON.stringify(owner.root)}; refusing to reassign it`);
  }
  if (top !== cwd) fail(`run from the checkout root ${JSON.stringify(top)}, not a subdirectory`);
  // The source checkout supplies code, config and Lefthook; it must share this repository.
  const sourceRoot = realpathSync(join(import.meta.dirname, ".."));
  let sourceCommon = "";
  try {
    if (gitPath(sourceRoot, ["--show-toplevel"], env) === sourceRoot) {
      sourceCommon = gitPath(sourceRoot, ["--git-common-dir"], env);
    }
  } catch {}
  if (sourceCommon !== common) {
    fail(
      `${JSON.stringify(join(sourceRoot, "scripts", "install-hooks.ts"))} is not from a checkout of this repository`,
    );
  }

  if (process.versions.bun || Number(process.versions.node.split(".")[0]) < 24) {
    fail("run with Node >= 24 (`node scripts/install-hooks.ts`), not another runtime");
  }
  const node = realpathSync(process.execPath);
  const worktrees = git(top, ["worktree", "list", "--porcelain", "-z"], env)
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  if (inside(node, common) || worktrees.some((root) => inside(node, root))) {
    fail(`Node ${JSON.stringify(node)} lives in a checkout; use a Node installed outside it`);
  }

  let source: string;
  try {
    source = installedLefthook(sourceRoot);
  } catch {
    fail(
      `Lefthook is not installed in ${JSON.stringify(sourceRoot)}; run \`pnpm install\` there first`,
    );
  }
  const lefthookVersion = execFileSync(source, ["version"], { encoding: "utf8", env }).trim();
  const hooks = configuredHooks(source, join(sourceRoot, "lefthook.yml"));

  const paths = layout(common);
  const hooksPathSetting = git(
    top,
    ["config", "--local", "--default", "", "--get", "core.hooksPath"],
    env,
  );
  const effective = git(top, ["rev-parse", "--git-path", "hooks"], env);
  const effectiveHooks = existsSync(resolve(top, effective))
    ? realpathSync(resolve(top, effective))
    : resolve(top, effective);
  const externalHooksPath = effectiveHooks !== paths.hooks;
  if (externalHooksPath && !replace) {
    fail(
      `Git runs hooks from ${JSON.stringify(effectiveHooks)}, not ${JSON.stringify(paths.hooks)}\nInspect it, then rerun with --replace to switch.`,
    );
  }
  if (existsSync(paths.hooks) && !lstatSync(paths.hooks).isDirectory()) {
    fail(`${JSON.stringify(paths.hooks)} is not a directory; move it deliberately first`);
  }

  // Classified before any write. Only this setup's exact shims are its own; every other
  // configured hook, including one an older `lefthook install` wrote, needs --replace.
  // Hooks under other names are left alone.
  const displaced: string[] = [];
  const unrecognized: string[] = [];
  const entries = existsSync(paths.hooks) ? readdirSync(paths.hooks, { withFileTypes: true }) : [];
  for (const entry of entries) {
    const owned =
      entry.isFile() &&
      readFileSync(join(paths.hooks, entry.name), "utf8") === shimText(entry.name);
    if (hooks.includes(entry.name)) {
      if (!owned) unrecognized.push(entry.name);
    } else if (owned) {
      displaced.push(entry.name);
    }
  }
  if (unrecognized.length > 0 && !replace) {
    fail(
      `existing hooks ${unrecognized.map((name) => JSON.stringify(name)).join(", ")} were not written by this setup\nInspect them, then rerun with --replace to back them up and replace them.`,
    );
  }
  const foreignNamespace =
    existsSync(paths.root) && !(lstatSync(paths.root).isDirectory() && isManaged(paths.manifest));
  if (foreignNamespace && !replace) {
    fail(
      `${JSON.stringify(paths.root)} exists but is not a managed deployment; rerun with --replace`,
    );
  }

  // Writes start here.
  if (foreignNamespace) renameSync(paths.root, `${paths.root}.replaced-${Date.now()}`);
  if (owner.kind === "missing") {
    // Relative to the common directory, as Git resolves core.worktree.
    git(top, ["config", "--local", "core.worktree", relative(common, top) || "."], env);
    const registered = resolveOwner(common);
    if (registered.kind !== "registered" || registered.root !== top) {
      git(top, ["config", "--local", "--unset", "core.worktree"], env);
      fail("registering core.worktree did not resolve back to this checkout; it was removed");
    }
  }

  mkdirSync(paths.backups, { recursive: true });
  const backup = mkdtempSync(
    join(paths.backups, `${new Date().toISOString().replace(/[:.]/g, "-")}-`),
  );
  const replaced = [...displaced, ...unrecognized];
  if (replaced.length > 0) mkdirSync(join(backup, "hooks"));
  for (const name of replaced) {
    const from = join(paths.hooks, name);
    if (!lstatSync(from).isFile()) renameSync(from, join(backup, "hooks", name));
    else copyFileSync(from, join(backup, "hooks", name), constants.COPYFILE_EXCL);
  }
  if (externalHooksPath) writeFileSync(join(backup, "core.hooksPath"), hooksPathSetting);

  const staging = mkdtempSync(join(paths.root, ".staging-"));
  const files = {} as Manifest["files"];
  writeFileSync(join(staging, "package.json"), runtimePackageJson);
  for (const name of runtimeSources) {
    copyFileSync(join(sourceRoot, "scripts", name), join(staging, name));
  }
  copyFileSync(source, join(staging, "lefthook"));
  chmodSync(join(staging, "lefthook"), 0o755);
  symlinkSync(node, join(staging, "node"));
  for (const name of deployedFiles) {
    files[name] = sha256(readFileSync(join(staging, name)));
  }
  const old = join(paths.root, ".previous-runtime");
  rmSync(old, { recursive: true, force: true });
  if (existsSync(paths.runtime)) renameSync(paths.runtime, old);
  renameSync(staging, paths.runtime);
  rmSync(old, { recursive: true, force: true });
  const manifest: Manifest = { version: 1, hooks, node, lefthookVersion, files };
  writeFileSync(join(paths.root, ".manifest.tmp"), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(join(paths.root, ".manifest.tmp"), paths.manifest);

  mkdirSync(paths.hooks, { recursive: true });
  for (const name of replaced) {
    if (!hooks.includes(name)) rmSync(join(paths.hooks, name), { force: true });
  }
  for (const hook of hooks) {
    const temporary = join(paths.hooks, `.${hook}.${namespace}-tmp`);
    writeFileSync(temporary, shimText(hook), { mode: 0o755 });
    rmSync(join(paths.hooks, hook), { recursive: true, force: true });
    renameSync(temporary, join(paths.hooks, hook));
  }
  if (externalHooksPath) {
    if (hooksPathSetting) git(top, ["config", "--local", "--unset", "core.hooksPath"], env);
    if (
      realpathSync(resolve(top, git(top, ["rev-parse", "--git-path", "hooks"], env))) !==
      paths.hooks
    ) {
      git(top, ["config", "--local", "core.hooksPath", paths.hooks], env);
    }
  }
  if (readdirSync(backup).length === 0) rmSync(backup, { recursive: true });

  const errors = inspectHookSetup(top, env);
  if (errors.length > 0) fail(`setup did not verify:\n${errors.join("\n")}`);
  console.log(
    `setup:hooks: ${hooks.join(", ")} dispatch through ${JSON.stringify(paths.runtime)} for primary ${JSON.stringify(top)}`,
  );
  if (existsSync(backup))
    console.log(`setup:hooks: replaced files backed up in ${JSON.stringify(backup)}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = (error as Error).message;
  console.error(message.startsWith("setup:hooks: ") ? message : `setup:hooks: ${message}`);
  process.exitCode = 1;
}
