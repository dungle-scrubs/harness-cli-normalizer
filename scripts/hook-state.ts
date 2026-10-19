import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { git, gitPath, ownerFailure, resolveOwner } from "./git-context.ts";

// Read-only description of the managed hook layout, shared by setup:hooks and check:setup.

export const namespace = "hcn-hooks";
/** Repository scripts deployed beside the managed Lefthook and Node runtime. */
export const runtimeSources = ["git-context.ts", "hook-dispatch.ts"] as const;
/** Every hashed runtime file; the manifest records exactly these and nothing else. */
export const deployedFiles = ["package.json", ...runtimeSources, "lefthook"] as const;
/** The runtime's module boundary, so Node runs the deployed .ts files as ES modules. */
export const runtimePackageJson = '{"type":"module"}\n';

export interface Manifest {
  version: 1;
  hooks: string[];
  node: string;
  lefthookVersion: string;
  files: Record<(typeof deployedFiles)[number], string>;
}

export function layout(common: string) {
  const root = join(common, namespace);
  const runtime = join(root, "runtime");
  return {
    root,
    runtime,
    manifest: join(root, "manifest.json"),
    backups: join(root, "backups"),
    node: join(runtime, "node"),
    lefthook: join(runtime, "lefthook"),
    dispatcher: join(runtime, "hook-dispatch.ts"),
    hooks: join(common, "hooks"),
  };
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The shim Git runs. It finds the runtime from its own hooks-directory location. */
export function shimText(hook: string): string {
  return [
    "#!/bin/sh",
    "# Managed by `pnpm setup:hooks` in the primary checkout. Do not edit.",
    'here=$(dirname -- "$0"; printf x)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion.
    "here=${here%?x}",
    `exec "$here/../${namespace}/runtime/node" "$here/../${namespace}/runtime/hook-dispatch.ts" '${hook}' "$@"`,
    "",
  ].join("\n");
}

const hookName = /^[a-z][a-z0-9-]*$/;
const hookMaps = ["jobs", "commands", "scripts"];
const rootKey = /^([a-z][a-z0-9_-]*) ?:(?:[ \t].*)?$/;
const externalKeys = new Set(["extends", "remotes"]);

/**
 * Admits only this repository's config style before any native parser sees the file: every
 * top-level line is a plain lowercase key, so quoted, escaped, tagged, merged, flow or
 * multi-document roots cannot smuggle in `extends` or `remotes`. Nested content is the native
 * parser's job; this is a format gate, not a YAML parser.
 */
export function assertSelfContained(text: string): void {
  let first = true;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const content = line.trimStart();
    if (content === "" || content.startsWith("#")) continue;
    const at = `lefthook.yml line ${index + 1}`;
    if (line !== content) {
      if (first) throw new Error(`${at}: the first entry must be an unindented top-level key`);
      continue;
    }
    first = false;
    const key = rootKey.exec(line)?.[1];
    if (!key) {
      throw new Error(
        `${at}: top-level lines must be plain lowercase keys (\`name:\`); quoted, tagged, merge, flow and document forms are unsupported`,
      );
    }
    if (externalKeys.has(key)) {
      throw new Error(`${at}: lefthook.yml must be self-contained (no extends or remotes)`);
    }
  }
}

/**
 * A versioned lefthook.yml as parsed by the given native Lefthook. Only a copy of that one file
 * is dumped, in a fresh repository with fresh HOME and XDG directories and no inherited Git or
 * Lefthook settings, so lefthook-local.yml and user configuration cannot contribute.
 */
export function lefthookConfig(lefthook: string, config: string): unknown {
  assertSelfContained(readFileSync(config, "utf8"));
  const base = mkdtempSync(join(tmpdir(), "hcn-hook-config-"));
  try {
    const repo = join(base, "repo");
    const home = join(base, "home");
    mkdirSync(repo);
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: base,
      GIT_TERMINAL_PROMPT: "0",
    };
    execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repo], {
      env,
      stdio: "ignore",
      timeout: 5000,
    });
    copyFileSync(config, join(repo, "lefthook.yml"));
    const dump = spawnSync(lefthook, ["dump", "--format", "json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    if (dump.status !== 0) throw new Error(`lefthook dump failed: ${dump.stderr.trim()}`);
    return JSON.parse(dump.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function configuredHooks(lefthook: string, config: string): string[] {
  return hooksFromDump(lefthookConfig(lefthook, config));
}

export function hooksFromDump(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("lefthook dump is not a mapping");
  }
  if ("extends" in config || "remotes" in config) {
    throw new Error("lefthook.yml must be self-contained (no extends or remotes)");
  }
  const hooks: string[] = [];
  for (const [name, value] of Object.entries(config)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!hookMaps.some((key) => key in value)) continue;
    if (!hookName.test(name)) throw new Error(`unsafe hook name ${JSON.stringify(name)}`);
    hooks.push(name);
  }
  if (hooks.length === 0) throw new Error("lefthook.yml configures no hooks");
  return hooks.sort();
}

/** The Lefthook native executable that `root`'s own lefthook dependency selects. */
export function installedLefthook(root: string): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const exe = process.platform === "win32" ? ".exe" : "";
  const lefthook = realpathSync(join(root, "node_modules", "lefthook", "package.json"));
  const binary = realpathSync(
    createRequire(lefthook).resolve(`lefthook-${os}-${process.arch}/bin/lefthook${exe}`),
  );
  if (!binary.startsWith(`${root}${sep}`)) {
    throw new Error(`Lefthook resolves outside ${JSON.stringify(root)}`);
  }
  return binary;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function linksTo(path: string, target: string): boolean {
  try {
    return (
      lstatSync(path).isSymbolicLink() &&
      readlinkSync(path) === target &&
      realpathSync(path) === target &&
      executable(path)
    );
  } catch {
    return false;
  }
}

/** Readiness of the managed hooks for the checkout at `cwd`. Changes nothing. */
export function inspectHookSetup(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const top = gitPath(cwd, ["--show-toplevel"], env);
  const owner = resolveOwner(gitPath(top, ["--git-common-dir"], env));
  if (owner.kind !== "registered") return [ownerFailure(owner, "hook-setup")];
  const fix = `Run \`pnpm setup:hooks\` from ${JSON.stringify(owner.root)}.`;
  const paths = layout(owner.common);
  if (!existsSync(paths.manifest)) return [`hook-setup: managed hooks are not set up\n${fix}`];
  let manifest: Manifest;
  try {
    manifest = readManifest(paths.manifest);
  } catch (error) {
    return [`hook-setup: managed hooks manifest is invalid: ${(error as Error).message}\n${fix}`];
  }
  const errors: string[] = [];
  for (const name of deployedFiles) {
    let actual = "";
    try {
      actual = sha256(readFileSync(join(paths.runtime, name)));
    } catch {}
    if (actual !== manifest.files[name])
      errors.push(`hook-setup: managed runtime file ${name} changed or missing\n${fix}`);
  }
  if (!executable(paths.lefthook)) errors.push(`hook-setup: managed Lefthook is missing\n${fix}`);
  if (!linksTo(paths.node, manifest.node)) {
    errors.push(
      `hook-setup: managed Node runtime is missing or no longer links to ${JSON.stringify(manifest.node)}\nInstall Node >= 24 outside any checkout, then ${fix}`,
    );
  }
  let hooksDir = "";
  try {
    hooksDir = realpathSync(resolve(top, git(top, ["rev-parse", "--git-path", "hooks"], env)));
  } catch {}
  if (hooksDir !== paths.hooks) {
    errors.push(
      `hook-setup: Git runs hooks from ${JSON.stringify(hooksDir)}, not the managed directory\n${fix}`,
    );
    return errors;
  }
  let configured: string[] = [];
  try {
    configured = configuredHooks(paths.lefthook, join(top, "lefthook.yml"));
  } catch (error) {
    errors.push(`hook-setup: cannot read configured hooks: ${(error as Error).message}`);
  }
  for (const hook of configured) {
    const shim = join(paths.hooks, hook);
    let text = "";
    try {
      text = lstatSync(shim).isFile() ? readFileSync(shim, "utf8") : "";
    } catch {}
    if (!manifest.hooks.includes(hook) || text !== shimText(hook) || !executable(shim)) {
      errors.push(`hook-setup: configured hook ${hook} is not managed\n${fix}`);
    }
  }
  return errors;
}

const manifestKeys = ["files", "hooks", "lefthookVersion", "node", "version"];
const digest = /^[0-9a-f]{64}$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

/** Parses and validates the closed manifest shape; never reads the files it names. */
export function readManifest(path: string): Manifest {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!exactKeys(manifest, manifestKeys)) throw new Error("unexpected or missing fields");
  if (manifest.version !== 1) throw new Error("unsupported version");
  const { hooks, node, lefthookVersion, files } = manifest;
  if (
    !Array.isArray(hooks) ||
    hooks.length === 0 ||
    !hooks.every((hook) => typeof hook === "string" && hookName.test(hook)) ||
    new Set(hooks).size !== hooks.length
  ) {
    throw new Error("hooks must be unique safe hook names");
  }
  if (typeof node !== "string" || !isAbsolute(node) || node.includes("\0")) {
    throw new Error("node must be an absolute path");
  }
  if (typeof lefthookVersion !== "string" || !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(lefthookVersion)) {
    throw new Error("lefthookVersion is not a version");
  }
  if (!exactKeys(files, deployedFiles))
    throw new Error("files must list exactly the runtime files");
  for (const name of deployedFiles) {
    if (typeof files[name] !== "string" || !digest.test(files[name] as string)) {
      throw new Error(`files.${name} is not a SHA-256 digest`);
    }
  }
  return manifest as unknown as Manifest;
}
