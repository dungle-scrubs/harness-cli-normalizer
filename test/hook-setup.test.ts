import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOwner } from "../scripts/git-context.ts";
import {
  assertSelfContained,
  deployedFiles,
  hooksFromDump,
  installedLefthook,
  layout,
  lefthookConfig,
  readManifest,
  sha256,
  shimText,
} from "../scripts/hook-state.ts";
import {
  cleanupFixtures,
  type Fixture,
  fixture,
  installLefthook,
  node,
  pnpmEnv,
  put,
  registered,
  repo,
  runScript,
  runSetup,
  scratch,
} from "./hook-fixture.ts";

const packageScripts: Record<string, string> = JSON.parse(
  readFileSync(join(repo, "package.json"), "utf8"),
).scripts;
const bun = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

// Every job writes what it saw; none runs repository tooling.
const probeConfig = [
  "pre-commit:",
  "  jobs:",
  "    - name: probe",
  '      run: printf "%s|%s" "$PWD" "$GIT_INDEX_FILE" > "$HOOK_PROBE"',
  "    - name: verdict",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion.
  '      run: exit "${HOOK_EXIT:-0}"',
  "pre-push:",
  "  jobs:",
  "    - name: args",
  '      run: printf "%s" "{1} {2}" > "$HOOK_PROBE"',
  "",
].join("\n");

// Lefthook 2.2.1 trims a trailing newline from Git's paths, so fixtures that run it use none.
const lefthookPaths = { primaryName: "primary space", linkedName: "linked space" };

afterEach(cleanupFixtures);

/** Content digest of every file under a directory, symlinks as their targets. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) out[key] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else out[key] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return out;
}

const workspaceRoots = ["allowBuilds", "overrides", "packageExtensions"];
const workspaceFix =
  "keep build policy in allowBuilds with lefthook: false; a new root policy needs a deliberate review of this gate";

/**
 * The workspace's top-level keys, which must be exactly the reviewed vocabulary in order. Only
 * plain unquoted keys are read; any other top-level form fails rather than being skipped.
 */
function workspacePolicyRoots(text: string): string[] {
  const keys: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "" || line.startsWith("#") || /^\s/.test(line)) continue;
    const key = /^([A-Za-z][A-Za-z0-9]*):(?:\s.*)?$/.exec(line)?.[1];
    if (!key) {
      throw new Error(
        `pnpm-workspace.yaml: line ${index + 1} is not a plain top-level key; ${workspaceFix}`,
      );
    }
    keys.push(key);
  }
  if (JSON.stringify(keys) !== JSON.stringify(workspaceRoots)) {
    throw new Error(
      `pnpm-workspace.yaml: top-level keys ${JSON.stringify(keys)} must be exactly ${JSON.stringify(workspaceRoots)}; ${workspaceFix}`,
    );
  }
  return keys;
}

function sharedState(f: Fixture) {
  return { metadata: snapshot(f.common), owner: registered(f) };
}

function readiness(f: Fixture, cwd: string) {
  return runScript(f, cwd, "check-hook-setup.ts");
}

function commit(f: Fixture, cwd: string, args: string[], extra = {}) {
  // Real hooks: no core.hooksPath override, unlike the fixture's seeding helper.
  return spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", ...args], {
    cwd,
    env: { ...f.env, ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
}

describe("install lifecycle contract", () => {
  it("runs no setup from any lifecycle script; setup and readiness are explicit", () => {
    for (const name of [
      "preinstall",
      "install",
      "postinstall",
      "preprepare",
      "prepare",
      "postprepare",
      "prepublish",
      "dependencies",
      "pnpm:devPreinstall",
    ]) {
      expect(
        packageScripts[name],
        `package.json: remove lifecycle script ${JSON.stringify(name)}; run \`pnpm setup:hooks\` explicitly from the primary checkout root instead`,
      ).toBeUndefined();
    }
    expect(packageScripts["setup:hooks"]).toBe("node scripts/install-hooks.ts");
    expect(packageScripts["check:setup"]).toBe("node scripts/check-hook-setup.ts");
    for (const [name, body] of Object.entries(packageScripts)) {
      if (name !== "setup:hooks") expect(body, name).not.toMatch(/install-hooks|setup:hooks/);
    }
    const gates = (packageScripts.check as string).split(" && ");
    expect(gates.slice(0, 2)).toEqual(["pnpm check:setup", "pnpm check:task-state"]);
    expect(gates.indexOf("pnpm build")).toBeLessThan(gates.indexOf("pnpm test"));
    expect(gates.indexOf("pnpm build")).toBeLessThan(gates.indexOf("pnpm test:bun"));
  });

  it("denies the Lefthook dependency installer and keeps the other build policy", () => {
    const workspace = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
    expect(workspacePolicyRoots(workspace)).toEqual(workspaceRoots);
    const builds = workspace.match(/^allowBuilds:\n((?: {2}\S.*\n)+)/m)?.[1];
    expect(builds).toBe("  koffi: true\n  lefthook: false\n");
    expect(workspace).toMatch(/^overrides:\n {2}"typed-rest-client@2\.3\.1>qs": 6\.16\.0$/m);
    const strykerVersion = JSON.parse(
      readFileSync(join(repo, "node_modules/@stryker-mutator/core/package.json"), "utf8"),
    ).version;
    const extensionKey = workspace.match(/^packageExtensions:\n( {2}"[^"\n]+":)$/m)?.[1];
    expect(extensionKey).toBe(`  "@stryker-mutator/core@${strykerVersion}":`);
  });

  it("rejects workspace roots that could grant builds around the explicit deny", () => {
    const workspace = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
    for (const extra of [
      "permissions:\n  build:\n    lefthook: true\n",
      "dangerouslyAllowAllBuilds: true\n",
      'overrides:\n  "lefthook": 0.0.0\n',
      '"onlyBuiltDependencies":\n  - lefthook\n',
      "<<: {dangerouslyAllowAllBuilds: true}\n",
    ]) {
      expect(() => workspacePolicyRoots(`${workspace}\n${extra}`), extra).toThrow(
        /^pnpm-workspace\.yaml: /,
      );
    }
  });

  it("the versioned config disables Lefthook auto-install and keeps every gate", () => {
    const root = realpathSync(repo);
    const config = lefthookConfig(installedLefthook(root), join(root, "lefthook.yml")) as Record<
      string,
      { jobs: { name: string }[] }
    > & { no_auto_install: boolean };
    expect(config.no_auto_install).toBe(true);
    expect(config["pre-commit"]?.jobs.map((job) => job.name)).toEqual([
      "task-state",
      "biome",
      "types",
    ]);
    expect(config["pre-push"]?.jobs.map((job) => job.name)).toEqual(["trufflehog"]);
  });

  it("both workflows set up the primary explicitly after installing, before any gate", () => {
    const steps = (file: string) =>
      [
        ...readFileSync(join(repo, ".github/workflows", file), "utf8").matchAll(/- run: (.+)$/gm),
      ].map((match) => match[1]);
    const ci = steps("ci.yml");
    const install = ci.indexOf("pnpm install --frozen-lockfile");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(ci.indexOf("pnpm setup:hooks")).toBeGreaterThan(install);
    expect(ci.indexOf("pnpm check:setup")).toBe(ci.indexOf("pnpm setup:hooks") + 1);
    expect(ci.indexOf("pnpm check:task-state")).toBe(ci.indexOf("pnpm check:setup") + 1);
    const publish = steps("publish.yml");
    expect(publish.indexOf("pnpm setup:hooks")).toBeGreaterThan(
      publish.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(publish.indexOf("pnpm check")).toBeGreaterThan(publish.indexOf("pnpm setup:hooks"));
  });

  // Synthetic package: the actual script names with sentinel bodies, the actual workspace build
  // policy, and a local fake `lefthook` whose postinstall stands in for the real installer.
  function install(variant: "actual" | "prepare" | "lefthook-build"): string {
    const { base, env: baseEnv } = scratch();
    const pkg = join(base, "package");
    const sentinel = join(base, "lifecycle");
    const record = (name: string) => `printf '%s\\n' ${name} >> "$HCN_LIFECYCLE_SENTINEL"`;
    const scripts = Object.fromEntries(
      Object.keys(packageScripts).map((name) => [name, record(name)]),
    );
    if (variant === "prepare") scripts.prepare = record("prepare");
    put(
      pkg,
      "fake-lefthook/package.json",
      JSON.stringify({
        name: "lefthook",
        version: "0.0.0",
        scripts: { postinstall: record("lefthook-postinstall") },
      }),
    );
    put(
      pkg,
      "package.json",
      JSON.stringify({
        name: "lifecycle-probe",
        private: true,
        scripts,
        devDependencies: { lefthook: "file:./fake-lefthook" },
      }),
    );
    const workspace = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
    put(
      pkg,
      "pnpm-workspace.yaml",
      // Local artifacts need an exact grant; the production name-only denial covers all sources.
      variant === "lefthook-build"
        ? workspace.replace("lefthook: false", "'lefthook@file:fake-lefthook': true")
        : workspace,
    );
    const { pnpm, env } = pnpmEnv({ base, env: baseEnv });
    const result = spawnSync(pnpm, ["install", "--offline"], {
      cwd: pkg,
      env: { ...env, HCN_LIFECYCLE_SENTINEL: sentinel },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return existsSync(sentinel) ? readFileSync(sentinel, "utf8") : "";
  }

  it("a real pnpm install runs neither a setup script nor the Lefthook installer", () => {
    expect(install("actual")).toBe("");
  });

  it("the same install probe sees a prepare script (positive witness)", () => {
    expect(install("prepare")).toBe("prepare\n");
  });

  it("the same install probe sees an allowed Lefthook build (positive witness)", () => {
    expect(install("lefthook-build")).toBe("lefthook-postinstall\n");
  });
});

describe("manifest shape", () => {
  const digest = "a".repeat(64);
  const valid = {
    version: 1,
    hooks: ["pre-commit", "pre-push"],
    node: "/opt/node/bin/node",
    lefthookVersion: "2.2.1",
    files: Object.fromEntries(deployedFiles.map((name) => [name, digest])),
  };

  it("accepts exactly the closed shape and rejects every other record before reading files", () => {
    const { base } = scratch();
    const path = join(base, "manifest.json");
    const read = (value: unknown) => {
      writeFileSync(path, JSON.stringify(value));
      return () => readManifest(path);
    };
    expect(read(valid)()).toEqual(valid);
    const { files, ...withoutFiles } = valid;
    for (const [label, value] of [
      ["empty files", { ...valid, files: {} }],
      ["missing files", withoutFiles],
      ["traversal key", { ...valid, files: { ...files, "../escape": digest } }],
      ["missing runtime file", { ...valid, files: { ...files, lefthook: undefined } }],
      ["uppercase digest", { ...valid, files: { ...files, lefthook: "A".repeat(64) } }],
      ["short digest", { ...valid, files: { ...files, lefthook: "a" } }],
      ["extra field", { ...valid, extra: true }],
      ["version", { ...valid, version: 2 }],
      ["no hooks", { ...valid, hooks: [] }],
      ["duplicate hook", { ...valid, hooks: ["pre-commit", "pre-commit"] }],
      ["unsafe hook", { ...valid, hooks: ["../pre-commit"] }],
      ["relative node", { ...valid, node: "bin/node" }],
      ["empty node", { ...valid, node: "" }],
      ["empty version", { ...valid, lefthookVersion: "" }],
      ["array", []],
    ] as const) {
      expect(read(value), label).toThrow();
    }
  });
});

describe("hook configuration", () => {
  it("recognizes jobs, commands and scripts hook maps and rejects unsafe or remote config", () => {
    expect(
      hooksFromDump({
        no_auto_install: true,
        colors: { red: 1 },
        "pre-push": { scripts: {} },
        "pre-commit": { jobs: [] },
        "commit-msg": { commands: {} },
        "post-checkout": { parallel: true },
      }),
    ).toEqual(["commit-msg", "pre-commit", "pre-push"]);
    for (const name of ["../escape", "pre commit", "Pre-commit", "pre-commit\n"]) {
      expect(() => hooksFromDump({ [name]: { jobs: [] } })).toThrow("unsafe hook name");
    }
    expect(() => hooksFromDump({ extends: ["x"], "pre-commit": { jobs: [] } })).toThrow(
      "self-contained",
    );
    expect(() => hooksFromDump({ no_auto_install: true })).toThrow("configures no hooks");
    expect(() => hooksFromDump([])).toThrow("not a mapping");
  });

  it("admits only plain top-level keys before the native parser ever runs", () => {
    const { base } = scratch();
    const ran = join(base, "dump-ran");
    // Native-command sentinel: records that dump ran and the parser fixture's branch.
    const fake = join(base, "fake-lefthook");
    writeFileSync(
      fake,
      `#!/bin/sh\ngit symbolic-ref --short HEAD > ${JSON.stringify(ran)}\nprintf '%s' '{"pre-commit":{"jobs":[]}}'\n`,
    );
    chmodSync(fake, 0o755);
    const config = join(base, "lefthook.yml");
    const rejected = [
      "extends:\n  - other.yml\n",
      "remotes:\n  - git_url: https://example.invalid/x\n",
      '"extends":\n  - other.yml\n',
      "'remotes':\n  - git_url: x\n",
      '"ext\\u0065nds": [other.yml]\n',
      "  extends: [other.yml]\n  pre-commit: {}\n",
      "<<: {extends: [other.yml]}\n",
      "pre-commit:\n  jobs: []\n---\nextends: [other.yml]\n",
      "{extends: [other.yml]}\n",
      "!!map\nextends: [other.yml]\n",
      "? extends\n: [other.yml]\n",
      "Pre-commit:\n  jobs: []\n",
    ];
    for (const text of rejected) {
      expect(() => assertSelfContained(text), text).toThrow(/lefthook\.yml line \d+/);
      writeFileSync(config, text);
      expect(() => lefthookConfig(fake, config), text).toThrow(/lefthook\.yml line \d+/);
      expect(existsSync(ran), `dump ran for ${JSON.stringify(text)}`).toBe(false);
    }
    for (const text of [readFileSync(join(repo, "lefthook.yml"), "utf8"), probeConfig]) {
      writeFileSync(config, `# comment\n\n${text}`);
      expect(lefthookConfig(fake, config)).toEqual({ "pre-commit": { jobs: [] } });
      expect(readFileSync(ran, "utf8")).toBe("main\n");
      rmSync(ran);
    }
  });

  it("parses only a copy of the versioned file, never lefthook-local.yml beside it", () => {
    const f = fixture({ lefthook: true, config: probeConfig });
    put(f.main, "lefthook-local.yml", "post-merge:\n  jobs:\n    - run: echo local\n");
    const config = lefthookConfig(installedLefthook(f.main), join(f.main, "lefthook.yml"));
    expect(Object.keys(config as object).sort()).toEqual(["pre-commit", "pre-push"]);
  });
});

describe("explicit primary setup", () => {
  it("refuses linked checkouts, subdirectories, foreign scripts and other runtimes before any write", () => {
    const f = fixture({ lefthook: true });
    const before = sharedState(f);
    const linked = runSetup(f, f.linked);
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("setup:hooks: this is a linked checkout");
    // Inherited Git context must not present the linked checkout as the primary.
    const masked = runSetup(f, f.linked, [], { GIT_DIR: f.common, GIT_WORK_TREE: f.linked });
    expect(masked.status).toBe(1);
    expect(masked.stderr).toContain("setup:hooks: this is a linked checkout");
    const nested = spawnSync(node, [join(f.main, "scripts/install-hooks.ts")], {
      cwd: join(f.main, "src"),
      env: f.env,
      encoding: "utf8",
    });
    expect(nested.stderr).toContain("run from the checkout root");
    const otherRuntime = spawnSync(bun, [join(f.main, "scripts/install-hooks.ts")], {
      cwd: f.main,
      env: f.env,
      encoding: "utf8",
    });
    expect(otherRuntime.stderr).toContain("run with Node >= 24");
    expect(runSetup(f, f.main, ["--force"]).stderr).toContain('unknown argument "--force"');
    expect(sharedState(f)).toEqual(before);
  });

  it("refuses a setup script from another repository before any write", () => {
    const f = fixture({ lefthook: true });
    const other = fixture({ lefthook: true });
    const before = [sharedState(f), sharedState(other)];
    const script = join(other.main, "scripts/install-hooks.ts");
    const foreign = runSetup(f, f.main, [], {}, other.main);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain(
      `${JSON.stringify(script)} is not from a checkout of this repository`,
    );
    expect([sharedState(f), sharedState(other)]).toEqual(before);
  });

  it("registers the primary from a linked checkout's script, config and Lefthook", () => {
    const f = fixture({ lefthook: true });
    installLefthook(f.linked);
    rmSync(join(f.main, "node_modules"), { recursive: true });
    for (const name of ["git-context.ts", "hook-dispatch.ts"]) {
      put(
        f.linked,
        `scripts/${name}`,
        `${readFileSync(join(f.linked, "scripts", name), "utf8")}// linked\n`,
      );
    }
    put(
      f.linked,
      "lefthook.yml",
      `${readFileSync(join(f.linked, "lefthook.yml"), "utf8")}commit-msg:\n  jobs:\n    - run: "true"\n`,
    );
    const before = snapshot(f.common);
    const setup = runSetup(f, f.main, [], {}, f.linked);
    expect(setup.status, setup.stderr).toBe(0);
    const after = snapshot(f.common);
    expect(Object.keys(before).filter((key) => !(key in after))).toEqual([]);
    expect(
      Object.keys(after)
        .filter((key) => after[key] !== before[key])
        .sort(),
    ).toEqual(
      [
        "config",
        "hooks/commit-msg",
        "hooks/pre-commit",
        "hooks/pre-push",
        "hcn-hooks/manifest.json",
        ...deployedFiles.map((name) => `hcn-hooks/runtime/${name}`),
        "hcn-hooks/runtime/node",
      ].sort(),
    );
    expect(registered(f)).toBe(relative(f.common, f.main));
    const paths = layout(f.common);
    for (const name of ["git-context.ts", "hook-dispatch.ts"]) {
      expect(readFileSync(join(paths.runtime, name), "utf8")).toBe(
        readFileSync(join(f.linked, "scripts", name), "utf8"),
      );
    }
    expect(sha256(readFileSync(paths.lefthook))).toBe(
      sha256(readFileSync(installedLefthook(f.linked))),
    );
    expect(readManifest(paths.manifest).hooks).toEqual(["commit-msg", "pre-commit", "pre-push"]);
    for (const cwd of [f.main, f.linked]) expect(readiness(f, cwd).status).toBe(0);
  });

  it("refuses a Node runtime that lives inside a checkout", () => {
    const f = fixture({ lefthook: true });
    const local = join(f.main, "tools", "node");
    mkdirSync(join(f.main, "tools"));
    copyFileSync(node, local);
    chmodSync(local, 0o755);
    const before = sharedState(f);
    const result = spawnSync(local, ["scripts/install-hooks.ts"], {
      cwd: f.main,
      env: f.env,
      encoding: "utf8",
      timeout: 20000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lives in a checkout");
    expect(sharedState(f)).toEqual(before);
  });

  for (const [label, options] of [
    ["conventional .git", {}],
    ["separate metadata", { separate: true, metadataName: "git data" }],
    ["separate metadata named .git", { separate: true, metadataName: ".git" }],
  ] as const) {
    it(`registers the primary and deploys a self-contained runtime (${label})`, () => {
      const f = fixture({ ...options, lefthook: true });
      const setup = runSetup(f, f.main);
      expect(setup.status, setup.stderr).toBe(0);
      expect(registered(f)).toBe(relative(f.common, f.main));
      const owner = resolveOwner(f.common);
      expect(owner).toEqual({ kind: "registered", root: f.main, common: f.common });
      for (const cwd of [f.main, f.linked]) expect(readiness(f, cwd).status).toBe(0);
      const paths = layout(f.common);
      for (const hook of ["pre-commit", "pre-push"]) {
        expect(readFileSync(join(paths.hooks, hook), "utf8")).toBe(shimText(hook));
        expect(lstatSync(join(paths.hooks, hook)).mode & 0o111).toBe(0o111);
      }
      expect(readdirSync(paths.runtime).sort()).toEqual([
        "git-context.ts",
        "hook-dispatch.ts",
        "lefthook",
        "node",
        "package.json",
      ]);
      expect(realpathSync(paths.node)).toBe(node);
      expect(sha256(readFileSync(paths.lefthook))).toBe(
        sha256(readFileSync(installedLefthook(f.main))),
      );
      // Nothing deployed points into a checkout or its dependencies.
      const texts = [
        ...["pre-commit", "pre-push"].map((hook) => join(paths.hooks, hook)),
        paths.manifest,
        ...["package.json", "git-context.ts", "hook-dispatch.ts"].map((name) =>
          join(paths.runtime, name),
        ),
      ].map((path) => [path, readFileSync(path, "utf8")] as const);
      texts.push([paths.node, readlinkSync(paths.node)]);
      for (const [name, text] of texts) {
        for (const forbidden of [f.main, f.linked, "node_modules"]) {
          expect(text.includes(forbidden), `${name} mentions ${forbidden}`).toBe(false);
        }
      }
      const deployed = { ...snapshot(paths.hooks), ...snapshot(paths.root) };
      expect(runSetup(f, f.main).status).toBe(0);
      expect({ ...snapshot(paths.hooks), ...snapshot(paths.root) }).toEqual(deployed);
    });
  }

  it("refuses to reassign a registered owner or adopt an invalid one", () => {
    const f = fixture({ lefthook: true });
    const impostor = join(f.base, "impostor");
    mkdirSync(impostor);
    writeFileSync(join(impostor, ".git"), `gitdir: ${f.common}\n`);
    f.git(f.main, "config", "core.worktree", impostor);
    expect(resolveOwner(f.common)).toMatchObject({ kind: "registered", root: impostor });
    const before = sharedState(f);
    const conflict = runSetup(f, f.main);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain(
      `primary already registered as ${JSON.stringify(impostor)}; refusing to reassign it`,
    );
    expect(sharedState(f)).toEqual(before);
    f.git(impostor, "--git-dir", f.common, "config", "core.worktree", join(f.base, "missing"));
    const stale = runSetup(f, f.main);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(join(f.base, "missing"));
    expect(existsSync(layout(f.common).root)).toBe(false);
  });

  it("ignores inherited repository context when validating the owner", () => {
    const f = fixture({ lefthook: true });
    expect(runSetup(f, f.main).status).toBe(0);
    const linkedGitDir = f.git(f.linked, "rev-parse", "--path-format=absolute", "--git-dir").trim();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    try {
      process.env.GIT_DIR = linkedGitDir;
      process.env.GIT_WORK_TREE = f.linked;
      expect(resolveOwner(f.common)).toEqual({
        kind: "registered",
        root: f.main,
        common: f.common,
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("managed hook dispatch", () => {
  it("runs the committing checkout's jobs without auto-install after the source install is gone", () => {
    // The linked branch keeps a legacy config without no_auto_install.
    const f = fixture({ lefthook: true, config: probeConfig, ...lefthookPaths });
    expect(runSetup(f, f.main).status).toBe(0);
    rmSync(join(f.main, "node_modules"), { recursive: true });
    const hooks = snapshot(layout(f.common).hooks);
    put(f.linked, "a.txt", "a");
    put(f.linked, "b.txt", "b");
    f.git(f.linked, "add", "a.txt", "b.txt");
    const probe = join(f.base, "probe");
    const result = commit(f, f.linked, ["-m", "partial", "a.txt"], { HOOK_PROBE: probe });
    expect(result.status, result.stderr).toBe(0);
    const [cwd, index] = readFileSync(probe, "utf8").split("|");
    expect(cwd).toBe(f.linked);
    expect(index).toMatch(/next-index-\d+\.lock$/);
    expect(f.git(f.linked, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt\n");
    expect(snapshot(layout(f.common).hooks)).toEqual(hooks);
    expect(readiness(f, f.linked).status).toBe(0);

    const head = f.git(f.linked, "rev-parse", "HEAD");
    const failing = commit(f, f.linked, ["-m", "blocked", "b.txt"], {
      HOOK_PROBE: probe,
      HOOK_EXIT: "3",
    });
    expect(failing.status).not.toBe(0);
    expect(f.git(f.linked, "rev-parse", "HEAD")).toBe(head);
  });

  it("detects Lefthook's implicit install as a positive witness for the no-auto flag", () => {
    const f = fixture({ lefthook: true, config: probeConfig, ...lefthookPaths });
    expect(runSetup(f, f.main).status).toBe(0);
    const hooks = snapshot(layout(f.common).hooks);
    const implicit = spawnSync(layout(f.common).lefthook, ["run", "pre-push"], {
      cwd: f.linked,
      env: { ...f.env, HOOK_PROBE: join(f.base, "probe") },
      encoding: "utf8",
    });
    expect(implicit.status).toBe(0);
    expect(snapshot(layout(f.common).hooks)).not.toEqual(hooks);
    expect(readiness(f, f.linked).status).toBe(1);
  });

  it("passes arguments, stdin bytes, environment and exit status through the shim", () => {
    const f = fixture({ lefthook: true, config: probeConfig, ...lefthookPaths });
    expect(runSetup(f, f.main).status).toBe(0);
    const out = join(f.base, "protocol");
    // Protocol fake for the managed Lefthook: records argv, cwd, index and stdin, exits 7.
    writeFileSync(
      layout(f.common).lefthook,
      `#!/bin/sh\nprintf '%s\\0' "$PWD" "$GIT_INDEX_FILE" "$@" > "$OUT"\ncat > "$OUT.stdin"\nexit 7\n`,
    );
    const stdin = Buffer.from("refs/heads/a 1\0binary\nlast");
    const args = ["origin", "a\nb", "--x", " spaced "];
    const result = spawnSync(join(layout(f.common).hooks, "pre-push"), args, {
      cwd: f.linked,
      env: { ...f.env, OUT: out, GIT_INDEX_FILE: "/index with space" },
      input: stdin,
    });
    expect(result.status).toBe(7);
    expect(readFileSync(out, "utf8").split("\0").slice(0, -1)).toEqual([
      f.linked,
      "/index with space",
      "run",
      "--no-auto-install",
      "pre-push",
      "--",
      ...args,
    ]);
    expect(readFileSync(`${out}.stdin`)).toEqual(stdin);
  });

  it("fails actionably when the owner registration or the Node runtime is gone", () => {
    const f = fixture({ lefthook: true, config: probeConfig, ...lefthookPaths });
    expect(runSetup(f, f.main).status).toBe(0);
    const paths = layout(f.common);
    rmSync(paths.node);
    symlinkSync(join(f.base, "missing-node"), paths.node);
    expect(readiness(f, f.linked).stderr).toContain("managed Node runtime");
    expect(spawnSync(join(paths.hooks, "pre-commit"), [], { cwd: f.linked }).status).not.toBe(0);
    rmSync(paths.node);
    symlinkSync(node, paths.node);
    f.git(f.main, "config", "--unset", "core.worktree");
    put(f.linked, "c.txt");
    f.git(f.linked, "add", "c.txt");
    const result = commit(f, f.linked, ["-m", "ownerless"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "hook-dispatch: no registered primary checkout\nThe primary checkout cannot be inferred from Git metadata. From the primary checkout root, run `pnpm setup:hooks` to register it.",
    );
  });
});

describe("existing hook state", () => {
  it("backs up and replaces what the historical producer generated", () => {
    const f = fixture({ lefthook: true, ...lefthookPaths });
    // Byte-exact scripts/install-hooks.ts at 497e151fe68b7a58c895cd533b6a633bc6171631, the
    // automatic producer this setup replaces; recorded so shallow checkouts need no history.
    const historical = readFileSync(join(repo, "test/historical/install-hooks.ts.txt"), "utf8");
    expect(historical).toContain('"lefthook", ["install", "--force"]');
    put(f.main, ".test-tmp/historical-install-hooks.ts", historical);
    const bin = join(f.base, "bin with space");
    mkdirSync(bin);
    const executable = join(bin, "lefthook");
    copyFileSync(installedLefthook(f.main), executable);
    chmodSync(executable, 0o755);
    const produced = spawnSync(node, [".test-tmp/historical-install-hooks.ts"], {
      cwd: f.main,
      env: { ...f.env, PATH: `${bin}:${f.env.PATH}` },
      encoding: "utf8",
    });
    expect(produced.status, produced.stderr).toBe(0);
    const paths = layout(f.common);
    const generated = Object.fromEntries(
      ["pre-commit", "pre-push"].map((hook) => [hook, readFileSync(join(paths.hooks, hook))]),
    );
    for (const [hook, bytes] of Object.entries(generated)) {
      expect(bytes.toString()).toContain(`\ncall_lefthook run "${hook}" "$@"`);
      const installed = `'${realpathSync(executable)}'`;
      expect(bytes.toString()).toContain(
        `\n  elif ${installed} -h >/dev/null 2>&1\n  then\n    ${installed} "$@"\n`,
      );
    }
    expect(readiness(f, f.linked).stderr).toContain("no registered primary checkout");

    // Resemblance is not ownership: displacing generated hooks takes explicit consent.
    const before = sharedState(f);
    const refused = runSetup(f, f.main);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'existing hooks "pre-commit", "pre-push" were not written by this setup',
    );
    expect(sharedState(f)).toEqual(before);
    const setup = runSetup(f, f.main, ["--replace"]);
    expect(setup.status, setup.stderr).toBe(0);
    const [stamp] = readdirSync(paths.backups);
    for (const [hook, bytes] of Object.entries(generated)) {
      expect(readFileSync(join(paths.backups, stamp as string, "hooks", hook))).toEqual(bytes);
      expect(readFileSync(join(paths.hooks, hook), "utf8")).toBe(shimText(hook));
    }
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("refuses unrecognized hooks and external hook paths without --replace, then backs them up", () => {
    const f = fixture({ lefthook: true });
    const paths = layout(f.common);
    const custom = "#!/bin/sh\necho custom\n";
    const unrelated = "#!/bin/sh\necho mine\n";
    put(paths.hooks, "pre-commit", custom);
    put(paths.hooks, "post-checkout", unrelated);
    symlinkSync(join(f.base, "elsewhere"), join(paths.hooks, "pre-push"));
    const before = sharedState(f);
    const refused = runSetup(f, f.main);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'existing hooks "pre-commit", "pre-push" were not written by this setup',
    );
    expect(sharedState(f)).toEqual(before);

    const replaced = runSetup(f, f.main, ["--replace"]);
    expect(replaced.status, replaced.stderr).toBe(0);
    const [stamp] = readdirSync(paths.backups);
    const backup = join(paths.backups, stamp as string, "hooks");
    expect(readFileSync(join(backup, "pre-commit"), "utf8")).toBe(custom);
    expect(readlinkSync(join(backup, "pre-push"))).toBe(join(f.base, "elsewhere"));
    expect(readFileSync(join(paths.hooks, "post-checkout"), "utf8")).toBe(unrelated);
    expect(readiness(f, f.linked).status).toBe(0);

    const external = join(f.base, "external hooks");
    f.git(f.main, "config", "core.hooksPath", external);
    const stateBefore = sharedState(f);
    const outside = runSetup(f, f.main);
    expect(outside.stderr).toContain(`Git runs hooks from ${JSON.stringify(external)}`);
    expect(sharedState(f)).toEqual(stateBefore);
    expect(runSetup(f, f.main, ["--replace"]).status).toBe(0);
    expect(
      spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: f.main,
        env: f.env,
      }).status,
    ).toBe(1);
    const saved = readdirSync(paths.backups).map((name) =>
      join(paths.backups, name, "core.hooksPath"),
    );
    expect(saved.filter(existsSync).map((path) => readFileSync(path, "utf8"))).toEqual([external]);
    expect(readiness(f, f.linked).status).toBe(0);
  });
});

/** A fresh fixture whose managed setup is in place and passes readiness. */
function managedFixture() {
  const f = fixture({ lefthook: true });
  const paths = layout(f.common);
  expect(runSetup(f, f.main).status).toBe(0);
  expect(readiness(f, f.linked).status).toBe(0);
  return { f, paths };
}

describe("readiness rejects no-op, partial and drifted setups", () => {
  it("rejects an unregistered and then an owner-only checkout until setup runs", () => {
    const f = fixture({ lefthook: true });
    expect(readiness(f, f.linked).stderr).toContain("no registered primary checkout");
    f.git(f.main, "config", "core.worktree", relative(f.common, f.main));
    expect(readiness(f, f.linked).stderr).toContain("managed hooks are not set up");
    expect(runSetup(f, f.main).status).toBe(0);
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("rejects a changed dispatcher until setup repairs it", () => {
    const { f, paths } = managedFixture();
    writeFileSync(paths.dispatcher, "process.exit(0);\n");
    expect(readiness(f, f.linked).stderr).toContain(
      "managed runtime file hook-dispatch.ts changed or missing",
    );
    expect(runSetup(f, f.main).status).toBe(0);
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("rejects a replaced hook shim until setup --replace restores it", () => {
    const { f, paths } = managedFixture();
    writeFileSync(join(paths.hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
    expect(readiness(f, f.linked).stderr).toContain("configured hook pre-commit is not managed");
    expect(runSetup(f, f.main, ["--replace"]).status).toBe(0);
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("rejects a Node link to another real executable", () => {
    const { f, paths } = managedFixture();
    // A real executable that is not the recorded Node must not pass.
    rmSync(paths.node);
    symlinkSync("/bin/true", paths.node);
    expect(readiness(f, f.linked).stderr).toContain(
      `managed Node runtime is missing or no longer links to ${JSON.stringify(node)}`,
    );
    rmSync(paths.node);
    symlinkSync(node, paths.node);
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("rejects malformed manifest file records before reading them", () => {
    const { f, paths } = managedFixture();
    const valid = readFileSync(paths.manifest, "utf8");
    const outside = join(f.base, "outside-secret");
    writeFileSync(outside, "not runtime\n");
    const manifest = JSON.parse(valid);
    for (const files of [
      {},
      { ...manifest.files, "../../../outside-secret": sha256("not runtime\n") },
      { ...manifest.files, lefthook: "ABC" },
    ]) {
      writeFileSync(paths.manifest, JSON.stringify({ ...manifest, files }));
      expect(readiness(f, f.linked).stderr).toContain(
        "hook-setup: managed hooks manifest is invalid",
      );
    }
    writeFileSync(paths.manifest, valid);
    expect(readiness(f, f.linked).status).toBe(0);
  });

  it("rejects a checkout that configures a hook the setup did not install", () => {
    const { f } = managedFixture();
    put(
      f.linked,
      "lefthook.yml",
      `${readFileSync(join(f.linked, "lefthook.yml"), "utf8")}commit-msg:\n  jobs:\n    - run: "true"\n`,
    );
    expect(readiness(f, f.linked).stderr).toContain("configured hook commit-msg is not managed");
    expect(readiness(f, f.main).status).toBe(0);
  });
});
