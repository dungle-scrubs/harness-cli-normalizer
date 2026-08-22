# Sandcastle — What it is and what it can inject into a sandbox

Source clone: `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/sandcastle` at commit `e99f832f26dc9d245c019a9ddd19fa5dee792427` (observed via `git show` header; commit date `Mon Jun 29 21:15:45 2026 +0100`). Clone is shallow (observed: `git rev-list --count HEAD` returns `1`, `git log --all` shows single commit; branch list shows only `main`/`origin/main`). Authoritative unless otherwise noted; no network fetch performed (documented absence of fetch).

## 1. What sandcastle is

Sandcastle is a TypeScript library/CLI for orchestrating AI coding agents inside isolated sandbox environments, managing the full lifecycle of sandbox creation, git branching/worktree handling, prompt resolution/expansion, per-iteration agent invocation, commit extraction, and merge-back to the host branch — documented in `package.json:2-4` (name `@ai-hero/sandcastle`, version `0.12.0`, description "CLI for orchestrating AI agents in isolated sandbox environments") (**documented**), `README.md:9-14` ("A TypeScript library for orchestrating AI coding agents in isolated sandboxes", provider-agnostic, handles sandboxing with a configurable branch strategy, commits merged back) (**documented**), `CONTEXT.md:1-6` ("A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations") (**documented**), and `docs/content/docs/index.mdx:7-9` (same) (**documented**).

Exact agent provider identifiers found in source (factory exports in `src/AgentProvider.ts`) (**documented**):

- `claudeCode` — `src/AgentProvider.ts:1181` (`export const claudeCode = ... name: "claude-code"`) (**documented**)
- `pi` — `src/AgentProvider.ts:628` (`export const pi = ... name: "pi"`) (**documented**)
- `codex` — `src/AgentProvider.ts:773` (`export const codex = ... name: "codex"`) (**documented**)
- `cursor` — `src/AgentProvider.ts:837` (`export const cursor = ... name: "cursor"`) (**documented**)
- `opencode` — `src/AgentProvider.ts:959` (`export const opencode = ... name: "opencode"`) (**documented**)
- `copilot` — `src/AgentProvider.ts:1109` (`export const copilot = ... name: "copilot"`) (**documented**)

No other provider factories are exported (observed via `grep -n "export const" src/AgentProvider.ts`; only the six above appear). The `src/templates/` directory and `src/InitService.ts` agent registry echo the same set with per-agent Dockerfile templates and default models (e.g. `DEFAULT_MODEL = "claude-opus-4-8"` at `src/AgentProvider.ts:279`) (**documented**).

Sandbox backends (built-in `SandboxProvider` implementations in `src/sandboxes/`) (**documented**):

- `docker` — `src/sandboxes/docker.ts:129` (`export const docker = ... name: "docker", tag: "bind-mount"`) (**documented**); exported as `@ai-hero/sandcastle/sandboxes/docker` in `package.json:12-13` (**documented**)
- `podman` — `src/sandboxes/podman.ts:140` (`name: "podman", tag: "bind-mount"`) (**documented**); `package.json:15` (**documented**)
- `vercel` — `src/sandboxes/vercel.ts:1` (header "Vercel isolated sandbox provider — wraps `@vercel/sandbox`", `createIsolatedSandboxProvider` with `name: "vercel"`, `tag: "isolated"`) (**documented**); `package.json:14` (**documented**)
- `daytona` — `src/sandboxes/daytona.ts:1` ("Daytona isolated sandbox provider", `name: "daytona", tag: "isolated"`) (**documented**); not listed in `package.json` exports (the four exports above are docker/vercel/podman/no-sandbox; daytona is a source file but absent from the `exports` map) (**observed**) — it is present as source and peer-depended on via `peerDependencies["@daytona/sdk"]` at `package.json:58-60` (**documented**)
- `no-sandbox` — `src/sandboxes/no-sandbox.ts:2` ("No-sandbox provider — runs the agent directly on the host", `tag: "none", name: "no-sandbox"`) (**documented**); `package.json:16` (**documented**)

Provider taxonomy per `CONTEXT.md:24-53` and `src/SandboxProvider.ts:120-260` (**documented**): `bind-mount` (docker, podman — host filesystem mounted), `isolated` (vercel, daytona — own filesystem, sync via `copyIn`/`syncOut`), `none` (no-sandbox — host execution).

Which platforms (**documented** with stated platform rows in `research/sandbox-provider-research.md`):

- Docker — Linux, macOS, Windows; mount performance native on Linux, via VM+virtiofs on Docker Desktop macOS/Windows (`research/sandbox-provider-research.md:18-34` table) (**documented**)
- Podman — Linux primary, macOS/Windows via Podman Machine; rootless daemonless (`research/sandbox-provider-research.md:36-46`) (**documented**)
- Vercel — cloud Firecracker microVMs via `@vercel/sandbox` (README prerequisites list "Vercel — cloud-based Firecracker microVMs" at `README.md:24`) (**documented**)
- Daytona — cloud/remote isolated; requires `@daytona/sdk` peer dep; `src/sandboxes/daytona.ts:98-120` shows ephemeral remote sandbox via Daytona API (**documented**)
- No-sandbox — host OS itself (by definition, no isolation; `src/sandboxes/no-sandbox.ts:38-80` execs on host) (**documented**)

## 2. How a run is invoked — exact CLI grammar and install

### CLI grammar (`src/cli.ts`)

Root command `sandcastle` (`src/cli.ts:354-365` — `Command.make("sandcastle", ...)` with version `VERSION`) (**documented**) with subcommands registered via `Command.withSubcommands` (**documented**):

- `sandcastle` (root, no args) — prints `Sandcastle v${VERSION}` and `Use --help` (`src/cli.ts:354-362`) (**documented**)
- `sandcastle init` (`src/cli.ts:122-310` — `Command.make("init", { imageName, template, agent, model, sandbox, issueTracker, createLabel, buildImage, installTemplateDeps }, ...)`) (**documented**)

  Flags (all `Options` with `withDescription`, `optional`/`choice`) (**documented**):

  - `--image-name <text>` — Docker image name (`src/cli.ts:9-12`) (**documented**)
  - `--template <text>` — Template name e.g. `blank, simple-loop, parallel-planner` (`src/cli.ts:43-49`) (**documented**)
  - `--agent <text>` — Agent e.g. `claude-code` (`src/cli.ts:51-56`) (**documented**)
  - `--model <text>` — Model e.g. `claude-sonnet-4-6`, defaults to agent default (`src/cli.ts:58-64`) (**documented**)
  - `--sandbox <text>` — Sandbox provider e.g. `docker, podman` (`src/cli.ts:66-71`) (**documented**)
  - `--issue-tracker <text>` — e.g. `github-issues, beads, custom` (`src/cli.ts:73-78`) (**documented**)
  - `--create-label <true|false>` — whether to create the "Sandcastle" GitHub label, only meaningful with `github-issues` (`src/cli.ts:80-89`) (**documented**)
  - `--build-image <true|false>` — whether to build sandbox image now, ignored when `custom` issue tracker (`src/cli.ts:91-98`) (**documented**)
  - `--install-template-deps <true|false>` — whether to install template host deps e.g. `zod` (`src/cli.ts:100-107`) (**documented**)

  Behavior notes: early validation of those flags before interactive prompts (`src/cli.ts:136-167`) (**documented**); tri-state booleans (`--create-label`, `--build-image`, `--install-template-deps`) distinguish absence from explicit false (`src/cli.ts:80-89` and `choiceToTriBool`) (**documented**); interactive prompts via `@clack/prompts` when `isTTY` and flag absent (`src/cli.ts:168-260`) (**documented**); non-interactive (no TTY) fails fast naming the missing flag (`src/cli.ts:171-176`) (**documented**).

- `sandcastle docker` namespace (`src/cli.ts:387-394` — `Command.make("docker", ...)` with `Command.withSubcommands([buildImageCommand, removeImageCommand])`) (**documented**)

  - `sandcastle docker build-image` (`src/cli.ts:252-272` — `Command.make("build-image", { imageName, dockerfile }, ...)` ) (**documented**)

    - `--image-name <text>` optional (`src/cli.ts:9-12`) (**documented**)
    - `--dockerfile <file>` optional path to custom Dockerfile, build context is cwd (`src/cli.ts:251-255`) (**documented**)

    Requires `.sandcastle/` (`requireConfigDir` at `src/cli.ts:270`) (**documented**); builds via `buildImage(imageName, containerfileDir, { dockerfile, buildArgs })` with `defaultUidBuildArgs()` aligning `AGENT_UID`/`AGENT_GID` to host uid/gid on Linux/macOS, no-op on Windows (`src/cli.ts:34-40`, `273-279`) (**documented**).

  - `sandcastle docker remove-image` (`src/cli.ts:276-295` — `Command.make("remove-image", { imageName }, ...)`) (**documented**)

    - `--image-name <text>` optional (**documented**)

- `sandcastle podman` namespace (`src/cli.ts:367-384` — `Command.make("podman", ...)` with `Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand])`) (**documented**)

  - `sandcastle podman build-image` (`src/cli.ts:309-341` — `Command.make("build-image", { imageName, containerfile }, ...)` ) (**documented**)

    - `--image-name <text>` optional (**documented**)
    - `--containerfile <file>` optional path to custom Containerfile (`src/cli.ts:299-305`) (**documented**)

  - `sandcastle podman remove-image` (`src/cli.ts:345-365` — `Command.make("remove-image", { imageName }, ...)`) (**documented**)

    - `--image-name <text>` optional (**documented**)

Exported CLI entry is `cli = Command.run(sandcastle, { name: "sandcastle", version: VERSION })` at `src/cli.ts:367-373` and bin maps to `dist/main.js` at `package.json:18-20` (`"bin": { "sandcastle": "dist/main.js" }`) (**documented**).

### README install grammar

- `npm install --save-dev @ai-hero/sandcastle` (`README.md:33`) (**documented**)
- `npx @ai-hero/sandcastle init` scaffolds `.sandcastle/` (`README.md:36-39`) (**documented**)
- `cp .sandcastle/.env.example .sandcastle/.env` then fill `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (`README.md:43`) (**documented**)
- `npx tsx .sandcastle/main.ts` runs the scaffolded `main.ts`/`main.mts` (`README.md:48-66`) (**documented**)

`README.md:48-66` also documents programmatic use (`import { run, claudeCode } from "@ai-hero/sandcastle"; import { docker } ... await run({ agent: claudeCode(...), sandbox: docker(), promptFile })`) (**documented**); `package.json:39-41` bin exposes `sandcastle` command (**documented**).

## 3. What crosses the host boundary INTO the sandbox

### Summary table (exhaustive for default bind-mount Docker/Podman; isolated/no-sandbox differ)

| Host source | Sandbox destination | Mode | Configurable (caller control) | Citation |
|---|---|---|---|---|
| Worktree directory (or host repo dir in `head` mode) | `SANDBOX_REPO_DIR = "/home/agent/workspace"` (`src/SandboxFactory.ts:133`) | read-write bind mount (`-v hostPath:sandboxPath:z`) | Choice of `branchStrategy` determines worktree vs direct mount; `branch` name and optional `baseBranch` select fork point; `cwd` selects host repo anchor. Not toggleable per-file without `copyToWorktree`/`mounts`. | `src/SandboxFactory.ts:133`, `src/SandboxFactory.ts:326-640` (WorktreeDockerSandboxFactory creation), `src/startSandbox.ts:97-154` (mount construction), `src/SandboxLifecycle.ts` branch selection (**documented**) |
| Git `.git` directory or `.git` pointer file + parent `.git` dir | Same absolute path in container (or `PARENT_GIT_SANDBOX_DIR = "/.sandcastle-parent-git"` on Windows worktree case) | bind mount | No direct caller config; derived by `resolveGitMounts(gitPath)` (`src/SandboxFactory.ts:260-286`) and patched by `patchGitMountsForWindows` (`src/mountUtils.ts:223-380`, ADR `0006`) (**documented**). On `head` mode with normal clone the `.git` dir sits under worktree host path and is included via `normalizeMounts` remapping (**documented**) |
| User-provided additional mounts (`docker({ mounts })` / `podman({ mounts })`) | caller-specified `sandboxPath` (absolute or `~/`-relative to `/home/agent` or relative to `SANDBOX_REPO_DIR`) | read-write by default, `readonly: true` opts in to `:ro` | Fully configurable by caller at provider construction; each `MountConfig { hostPath, sandboxPath, readonly? }` (`src/MountConfig.ts:7-21`) expanded via `expandTilde`/`resolveHostPath`/`resolveSandboxPath` (`src/mountUtils.ts:35-75`), validated existence (`resolveUserMounts` throws if `hostPath` missing, `src/mountUtils.ts:82-105`), SELinux label added via `formatVolumeMount` (`src/mountUtils.ts:268-282`), file-mount parents under `/home/agent` auto-`mkdir -p`+`chown` (`processFileMountParents` at `src/mountUtils.ts:284-350` and docker `parentDirsToCreate` loop at `src/sandboxes/docker.ts:141-216`) (**documented**) |
| Files listed in `copyToWorktree: string[]` | Same relative path in worktree (then bind-mounted) | copy (cp -cR / reflink) before container start | Fully configurable; caller passes array of host-relative paths (`src/CopyToWorktree.ts:14-54`, `src/SandboxFactory.ts:340-360`); isolated providers copy via `copyIn` instead of worktree copy (`src/createSandbox.ts:743-746`, `src/SandboxFactory.ts:460-500`) (**documented**). Not supported with `branchStrategy: { type: "head" }` per `README.md` API note (**documented**) |
| Environment variables | Container env (including `HOME=/home/agent` forced) | env var injection | Via three sources merged at launch (`src/run.ts` and `src/createSandbox.ts` call `resolveEnv`+`mergeProviderEnv`; see §4). Caller can set arbitrary vars that are declared in `.sandcastle/.env` or via `agent.env` / `sandbox.env` options (**documented**). `HOME` forced to `/home/agent` after spreading caller env (`src/sandboxes/docker.ts:184-190`, `src/sandboxes/podman.ts:195`) so caller `HOME` override is ineffective (**documented**) |
| Lifecycle hook commands | Not a file transfer, but arbitrary host or sandbox commands run at hook points | exec | `hooks.host.onWorktreeReady`, `hooks.host.onSandboxReady` run on host via `runHostHooks` (`src/SandboxLifecycle.ts:94-129`); `hooks.sandbox.onSandboxReady` run inside container via `sandbox.exec` (`src/createSandbox.ts:830-840`, `src/SandboxFactory.ts:560-600`). Caller chooses which commands run; host hooks run with host `cwd`, sandbox hooks with `sandboxRepoDir` and optional `sudo: true` (`src/SandboxLifecycle.ts:94-105` type def) (**documented**) |
| Git worktree patch file on Windows | `/home/agent/workspace/.git` overlay | temp file bind mount | Not caller-configurable; synthesized temp file `git-override` with corrected `gitdir: /.sandcastle-parent-git/...` then mounted (`src/mountUtils.ts:320-370`) (**documented**) |

### What is NOT mounted/copied by default (exhaustive negative)

No automatic mounting of host agent config directories or credentials. Observed via absence:

- No default mount of `~/.claude`, `~/.codex`, `~/.config`, `~/.agents`, `~/.ssh`, `~/.gitconfig`, or host SSH/Git credentials in `src/SandboxFactory.ts:326-650` (WorktreeDockerSandboxFactory mount assembly), `src/startSandbox.ts:97-154`, `src/sandboxes/docker.ts:137-162`, `src/sandboxes/podman.ts:153-180` (**documented** by absence; the only mounts assembled are `worktreePath`, `gitMounts`, and `userMounts`). `grep -rn "\.claude\|\.codex\|\.agents\|\.ssh\|AGENTS\.md\|CLAUDE\.md" src --include="*.ts"` returned only session-storage path helpers and test fixture strings, no mount registration (observed via `grep` run at `exec-10`/`exec-11`) (**observed**).
- No automatic copy of `~/.claude/settings.json` etc. The only file-level existence requirement is `!existsSync(resolvedHostPath)` for explicit user mounts (throws; `src/mountUtils.ts:91-97`) (**documented**).
- Credentials and API keys travel exclusively as env vars via `resolveEnv`/`mergeProviderEnv` (see §4), not as files (`src/EnvResolver.ts:1-40`, `src/mergeProviderEnv.ts:1-20`) (**documented**).
- Project directory: only the worktree clone is mounted, not the full host home. Read-only vs read-write defaults to read-write; caller must set `readonly: true` per mount to get `:ro`; SELinux label defaults to `z` (shared) (`src/sandboxes/docker.ts:135`, `src/sandboxes/podman.ts:149`, `src/mountUtils.ts:268-282`) (**documented**).

Hook/command surfaces that CAN inject arbitrary host content:

- `copyToWorktree` copies arbitrary host-relative paths (including dotfiles) into the worktree, then the worktree is mounted. Caller controls list (**documented**).
- `mounts` lets caller bind-mount any existing host path (absolute, `~/`-expanded, or relative to `cwd`) into any sandbox path under `/home/agent` (or with guidance for other paths) — file mounts outside `/home/agent` throw at construction with guidance (`processFileMountParents` error at `src/mountUtils.ts:328-335`) (**documented**).
- `Dockerfile`/`Containerfile` customization (see §5) can bake arbitrary content/images.

## 4. How environment variables reach the agent process inside the sandbox

### Resolver — `src/EnvResolver.ts:1-60` (**documented**)

```
resolveEnv(repoDir) parses .sandcastle/.env (parseEnvFile at line 5-38: lines split on "\n", trim, skip empty/"#", split on "=", trim key/value, strip single/double quotes, unescape \n\r\t\\ in double-quoted values) and returns Record<string,string>.
resolveEnv logic (lines 48-60):
  sandcastleEnv = parseEnvFile(join(repoDir, ".sandcastle", ".env"))
  for each key in Object.keys(sandcastleEnv):
    value = sandcastleEnv[key] || process.env[key]   // .env value wins if truthy, else process.env fallback
    if (value) result[key] = value                  // falsy values omitted
```

Implications (**documented**):

- Precedence: `.sandcastle/.env` > `process.env` (**documented**).
- Only keys declared (left-hand side present) in `.sandcastle/.env` are resolved from `process.env` — repo root `.env` is not consulted (comment at line 42: "Only keys declared in .sandcastle/.env are resolved from process.env. Repo root .env is not part of the resolution chain") (**documented**).
- Empty string in `.sandcastle/.env` falls through to `process.env[key]` because `||` treats `""` as falsy; undefined/omitted also yields `process.env` if truthy (observed line 52; `EnvResolver.test.ts:83` asserts `HOME` omitted when not declared) (**documented** + observed via test).
- `readFileString` failure (missing file) returns `{}` (line 10: `catchAll => succeed(null)` → `return {}`) (**documented**).

### Merge — `src/mergeProviderEnv.ts:1-30` (**documented**)

```
mergeProviderEnv({ resolvedEnv, agentProviderEnv, sandboxProviderEnv })
  throws if Overlapping keys between agent and sandbox provider env (lines 14-22)
  returns { ...resolvedEnv, ...sandboxProviderEnv, ...agentProviderEnv }  // agent+sandbox overrides resolved for shared keys
```

So provider-supplied env (`agent.env` from `claudeCode("model", { env })` etc. at `src/AgentProvider.ts:1187`/`633`/`774`/`839`, and `docker({ env })` at `src/sandboxes/docker.ts:82` / `noSandbox({ env })` / `podman`/`vercel`/`daytona`) merges last and wins over `.sandcastle/.env` / process fallback for collisions between resolved vs provider (**documented**). Overlap between agent and sandbox provider themselves is forbidden and throws (`src/mergeProviderEnv.ts:17-22`) (**documented**).

### Can the caller set an arbitrary variable, e.g. HOME or CLAUDE_CONFIG_DIR? Is there an allowlist?

- **Arbitrary variable via `.sandcastle/.env`**: Yes, any key written as `KEY=value` in that file will be forwarded (subject to truthiness check). No allowlist filtering in `EnvResolver` — it iterates `Object.keys(sandcastleEnv)` verbatim (**documented**). Example: `CLAUDE_CONFIG_DIR=/tmp/fake` in `.sandcastle/.env` would be resolved and forwarded if present; test at `src/EnvResolver.test.ts:83` shows only the exclusion mechanism (undeclared keys) — not a positive allowlist (**documented**).
- **Arbitrary variable via provider `env` options**: Yes, `docker({ env: { FOO: "bar" } })` and `claudeCode("m", { env: { FOO: "bar" } })` inject verbatim (`src/sandboxes/docker.ts:82-84`, `src/AgentProvider.ts:1187`) (**documented**). No sanitization seen; only the cross-provider overlap check exists (**documented**).
- **`HOME` specifically**: Caller can set `HOME` in `.sandcastle/.env` or provider env, but it is unconditionally overwritten to `/home/agent` at container creation for bind-mount providers. In `src/sandboxes/docker.ts:182-190`: `startContainer(..., { ...createOptions.env, HOME: "/home/agent" }, ...)` — spread caller env first, then `HOME` literal wins (**documented**). Same for Podman at `src/sandboxes/podman.ts:195`: `const env = { ...createOptions.env, HOME: "/home/agent" }` (**documented**). So arbitrary `HOME` is not effective for Docker/Podman. For `no-sandbox` provider, host `process.env` is spread with `createOptions.env` at `src/sandboxes/no-sandbox.ts:38` (`const processEnv = { ...process.env, ...createOptions.env }`) so a caller `HOME` via provider env WOULD affect the agent on host (last-write-wins) (**documented**). No `allowlist` blocks `HOME`; the overwrite is the mechanism. The changelog note `- 78ef034: Fix sandbox crash on macOS by setting HOME=/home/agent` at `CHANGELOG.md:503` confirms intent (**documented**).
- **Other sensitive vars (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, etc.)**: Forwarded if caller declares them in `.sandcastle/.env` or provider env. The scaffolded `.env.example` lists per-agent keys (e.g. `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY` at `src/InitService.ts:416-470`) but they are examples, not an enforcement allowlist (**documented**).

## 5. Custom image support: Dockerfile, image override, extra mounts, network restriction, setup commands — config schema

`DockerOptions` / `PodmanOptions` / `Dockerfile` via CLI/config (**documented**):

- **Image override** — `docker({ imageName: "sandcastle:local" })` (`src/sandboxes/docker.ts:42-47` option `imageName?: string`, default derived via `defaultImageName(cwd)` = `sandcastle:<dir-name>` lowercased/sanitized at `src/mountUtils.ts:18-30`) (**documented**). CLI override `--image-name` (`src/cli.ts:9-12`, `resolveImageName` at `src/cli.ts:14-15`) also supplies value to docker/podman providers (**documented**). Podman mirrors with `PodmanOptions.imageName` at `src/sandboxes/podman.ts:36` (**documented**). For Vercel/Daytona the "image" concept is cloud runtime (`VercelOptions.runtime`, `DaytonaOptions.create` image/snapshot params) — not a Dockerfile path (**documented** via `src/sandboxes/vercel.ts:65-77`, `src/sandboxes/daytona.ts:48-58`).
- **Dockerfile / Containerfile override** — CLI `--dockerfile <file>` for `sandcastle docker build-image` (`src/cli.ts:252-255`) and `--containerfile <file>` for `sandcastle podman build-image` (`src/cli.ts:299-305`) with `buildArgs: defaultUidBuildArgs()` (`src/cli.ts:33-40`) (**documented**). The config directory scaffold writes `Dockerfile` (or `Containerfile` per provider) into `.sandcastle/` (`src/InitService.ts:1062-1065` writes `join(configDir, sandboxProvider.containerfileName)` with template content like `CLAUDE_CODE_DOCKERFILE` at `src/InitService.ts:218-236`) (**documented**). Issue tracker `custom` scaffolds a TODO Dockerfile requiring manual edit before build (`src/cli.ts:330-343` next-steps branch) (**documented**).
- **Extra mounts** — `docker({ mounts: [{ hostPath, sandboxPath, readonly? }] })` (`src/sandboxes/docker.ts:62-67`, type `MountConfig` at `src/MountConfig.ts:7-21`) and same for `podman({ mounts })` at `src/sandboxes/podman.ts:71-76` (**documented**). Path resolution supports absolute, `~/`-expanded (via `expandTilde`), and relative (`src/mountUtils.ts:35-75`) (**documented**). SELinux labeling via `selinuxLabel?: "z"|"Z"|false` (`src/sandboxes/docker.ts:54-60`, `src/sandboxes/podman.ts:40-48`) (**documented**).
- **Network restriction** — `docker({ network?: string | readonly string[] })` maps to `docker run --network` per network (`src/sandboxes/docker.ts:73-83` and forwarding at `src/sandboxes/docker.ts:180-182` via `DockerLifecycle.startContainer` `network` option) (**documented**). Podman has `network?: string | readonly string[]` at `src/sandboxes/podman.ts` (~ line 80) (**documented**, observed header). Vercel has `networkPolicy?: Record<string,unknown>` at `src/sandboxes/vercel.ts:88-93` (**documented**). Daytona network not surfaced separately beyond `create` passthrough (**documented**).
- **Setup commands** — `hooks: { host: { onWorktreeReady?, onSandboxReady? }, sandbox: { onSandboxReady? } }` on `run()` (`README.md:232-243` API example), on `createSandbox()` (`src/createSandbox.ts:27` `hooks?: SandboxHooks`, executed at `src/createSandbox.ts:830-840`), and on `interactive()`/`Worktree` equivalents. Each hook is `{ command: string; sudo?: boolean; timeoutMs?: number }` for sandbox, `{ command: string; timeoutMs?: number }` for host (`src/SandboxLifecycle.ts:94-105` type `SandboxHooks`) (**documented**). Host hooks run via `runHostHooks(hostHooks, worktreePath)` before sandbox start (`src/SandboxFactory.ts:370-390`) (**documented**); sandbox hooks run after `git config --global --add safe.directory` (`src/createSandbox.ts:860-875`) (**documented**). All hooks default timeout 60s (`src/SandboxLifecycle.ts:13` `HOOK_TIMEOUT_MS = 60_000`), `timeoutMs` override supported (README example uses `timeoutMs: 300_000`) (**documented**).
- **Additional hardenings / extra knobs on `docker()`/`podman()`** — `containerUid`/`containerGid` override for `--user` (`src/sandboxes/docker.ts:48-60`), `groups?: (string|number)[]` for `--group-add` (Docker-outside-of-Docker socket sharing, `src/sandboxes/docker.ts:84-94`), `devices?: string[]` for `--device` (`src/sandboxes/docker.ts:96-107`), `cpus?: number` for `--cpus` (`src/sandboxes/docker.ts:109-120`), `env?: Record<string,string>` (**documented**). Vercel extra knobs: `token`, `source` (git/tarball/snapshot), `ports`, `timeout`, `resources.vcpus`, `runtime`, `projectId/teamId` at `src/sandboxes/vercel.ts:39-100` (**documented**). Daytona: `apiKey/apiUrl/target/create` plus `env`, `maxOutputTailChars` at `src/sandboxes/daytona.ts:48-100` (**documented**).

`README.md:134-160` documents `docker({ imageName, mounts, network, groups, devices, env, cpus, containerUid/containerGid, selinuxLabel })` with examples (`{ hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true }` etc.) (**documented**). `AGENTS.md`/`CONTEXT.md` describe the `Dockerfile` ownership and `SANDBOX_REPO_DIR` constraint (**documented**).

## 6. Headless operation — non-interactive run and structured output

### Headless (non-interactive) orchestrator invocation

Yes — `run()` is a programmatic, headless, non-interactive entry point intended for orchestrators, CI, and scripts. Evidence:

- `src/run.ts:1-15` exports `run(options: RunOptions)` which resolves `cwd`, validates prompts, merges env, creates sandbox lifecycle via `SandboxFactory`/`startSandbox`, orchestrates iterations via `orchestrate()`, and returns `OrchestrateResult` without requiring a TTY (`src/run.ts` entire file, especially `RunOptions` at line ~250-400 and `orchestrate` call) (**documented**).
- `src/Orchestrator.ts:1-120` implements `orchestrate()` calling `provider.buildPrintCommand` and `sandbox.exec` with `onLine` streaming, idle/completion timeout handling, and per-iteration result collection (**documented**).
- `src/createSandbox.ts:320-500` exposes `createSandbox({ branch, sandbox, cwd, hooks })` → `Sandbox { run(options), interactive(options), exec(cmd), close() }` with `SandboxRunOptions`/`SandboxInteractiveOptions` — `run()` there also headless and runs inside an existing warm container (`src/createSandbox.ts:250-340`) (**documented**).
- CLI does NOT expose `run` directly (only `init`, `docker`/`podman` image commands at `src/cli.ts:367-373`) — headless orchestration is via the JS API (`README.md:56-66` `await run({ agent: claudeCode(...), sandbox: docker(), promptFile })`) (**documented**). The `src/cli.test.ts` coverage of `init`/`build-image` but no `run` CLI command confirms absence (**observed**).

### What the output looks like — stream, final JSON, both

Both mechanisms exist, chosen by caller options (**documented**):

1. **Live stream (iteration-level events + raw lines)**

   - `LoggingOption` controls display: `{ type: "file", path, onAgentStreamEvent?, verbose? }` vs `{ type: "stdout", verbose? }` at `src/run.ts:230-270` (**documented**).
   - When using file mode, caller may pass `onAgentStreamEvent: (event) => {}` to forward each `AgentStreamEvent { type: "text" | "toolCall" | "raw", iteration, timestamp, ... }` to external observability. Errors thrown by the callback are swallowed (`src/run.ts:272-300` `buildAgentStreamHandler`, `AgentStreamEmitter.ts`) (**documented**).
   - `verbose: true` appends every raw JSONL line to the same log file (file mode) or `process.stdout` (stdout mode) via `buildVerboseRawLineSink` at `src/run.ts:302-320` (**documented**); also surfaces `{ type: "raw", line }` via `onAgentStreamEvent` (**documented** at `src/run.ts:230-270` comment).
   - Underlying agent stdout is line-delivered to `sandbox.exec({ onLine })` in `src/Orchestrator.ts:130-200` (`invokeAgent` calls `provider.parseStreamLine(line)` per line) (**documented**). Tool-call allowlisting happens there (`src/AgentProvider.ts:TOOL_ARG_FIELDS`) (**documented**).
   - `README.md:262-290` under `logging` describes `type: "file"/"stdout"`, `onAgentStreamEvent`, `verbose` precisely (**documented**).

2. **Final typed JSON (structured output — separate from stream)**

   - Opt-in via `run({ output: Output.object({ tag, schema, maxRetries? }) })` or `Output.string({ tag, maxRetries? })` (`src/Output.ts:36-120` defines `_tag: "object"|"string", tag, schema, maxRetries`) (**documented**).
   - Extraction scans the agent's combined `stdout` for the **last** occurrence of `<tag>...</tag>` at `src/extractStructuredOutput.ts:34-60` (`findLastTagContent` — last match wins) (**documented**); `Output.object` unwraps optional ` ```json ... ``` ` fences (`unwrapFences` at line 84-100), `JSON.parse`s, and validates via Standard Schema `schema["~standard"].validate(parsed)`; `Output.string` trims whitespace only (**documented**).
   - It is a **final** value: `run()` throws early if `maxIterations !== 1` when `output` is set, and throws if the resolved prompt does not contain the opening tag (`docs/adr/0010-structured-output.md:14-17` Constraints: `maxIterations === 1 only`, `Caller owns the prompt-side instruction... run() throws at entry if the resolved prompt does not contain the configured opening tag`) (**documented**). `RunResult` gains a typed `output: T` field only when the `output` overload is used (ADR 0010 Consequences) (**documented**).
   - On missing tag / invalid JSON / schema failure, `run()` throws `StructuredOutputError { tag, rawMatched?, cause?, commits, branch, preservedWorktreePath?, sessionId?, sessionFilePath? }` at `src/Output.ts:122-200` (**documented**). `CHANGELOG.md` under `0.11.0Minor` notes `maxRetries` for structured-output retry: failure resumes the failed session feeding back a token-efficient error, up to `maxRetries` extra attempts, only for resumable providers (`claudeCode`, `codex`, `pi`) (**documented** at `CHANGELOG.md:16-20`).
   - ADR `0010` Consequences notes structured output is `run()` only, not available on `interactive()`/`wt.interactive()` (**documented** at `docs/adr/0010-structured-output.md:25`).
   - `run()` return also includes `stdout: string` (combined all iterations), `iterations: IterationResult[]`, `commits: { sha }[]`, `branch`, `completionSignal?`, `logFilePath?`, `output?: T` (typed), and optional `resume()/fork()` for continuation (`src/run.ts` `RunOptions` + `OrchestrateResult` at `src/Orchestrator.ts:320-380`) (**documented**).

So the answer to "stream, final JSON, or both?" is **both, but at different layers**: the caller always can receive a live stream via `onAgentStreamEvent`+`verbose` (stream), and optionally a final extracted/validated `output` value when using the `Output` API (final JSON), on the same headless invocation (**documented**).

## 7. The load-bearing question — Does sandcastle give the caller any way to control WHICH SKILLS or instruction files the agent sees inside the sandbox?

### Direct answer

**No. Sandcastle does not expose any first-class API to name, filter, or rewrite the set of skills or instruction files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.codex`, `.agents`, `configDir`) that the agent sees inside the sandbox.** A source-wide search finds no config key, CLI flag, or provider option that selects a subset of skills or synthesizes a fresh config directory for the sandbox (**observed**).

### What the source search turned up (negative result is the finding)

- `grep -rn "skill\|SKILL.md\|\.claude\|\.codex\|\.agents\|AGENTS.md\|CLAUDE.md\|configDir\|HOME" src --include="*.ts"` across the repo (executed at `exec-10`/`exec-11`) returned (**observed**):

  - `skill` matches only in `docs/agents/triage.md`/`domain.md`/`CLAUDE.md:9` (the three docs describing "Agent skills" as Sandcastle's triage labels/workflow, not as an agent-runtime skills mechanism) and one unrelated test constant `"session.skills_loaded"` in `src/AgentProvider.test.ts:1817` (**observed**). Zero matches for a Sandcastle-side skill whitelist/configDir field in `src/MountConfig.ts`, `src/mountUtils.ts`, `src/SandboxFactory.ts`, `src/sandboxes/*.ts`, `src/run.ts`, `src/createSandbox.ts`, `src/AgentProvider.ts`, `src/cli.ts` (**observed**).
  - `.claude` matches only as the **session store** path (`~/.claude/projects/...` for Claude Code session JSONL capture) at `src/SessionStore.ts:46-96`, `src/AgentProvider.ts:358` (`"/home/agent/.claude/projects"`), and in test fixture strings like `src/mountUtils.test.ts:720` (`"/home/agent/.codex/auth.json"` example) (**observed**). It is never treated as a skills dir to mount or filter (**observed** by absence in mount construction at `src/SandboxFactory.ts:326-650`, `src/startSandbox.ts:97-154`, `src/sandboxes/docker.ts:137-162`) (**documented** by absence).
  - `HOME` / `configDir` appear only as: (a) `HOME: "/home/agent"` hard-coded for Docker/Podman at `src/sandboxes/docker.ts:186`/`podman.ts:195` and discussed in fix `CHANGELOG.md:503` and `docs/research/permissions-systemic-fix.md:33,57` (**documented**); (b) `configDir` at `src/InitService.ts:765-1088` referring exclusively to the **host** `.sandcastle/` config directory creation during `sandcastle init`, not a sandbox agent config directory (**documented**). No `CLAUDE_CONFIG_DIR`, `HOME` override knob, or `agentConfigDir` / `skillPaths` option exists on `AgentProvider` or `SandboxProvider` (**observed**).
  - `AGENTS.md` / `CLAUDE.md` appear only as repo-internal documentation (`AGENTS.md`, `CLAUDE.md`, `docs/agents/*.md`, `.agents/skills` mentions in task instructions) — the search over `src/` produced no hits for them as mounted/rewritten files inside the sandbox (**observed**). `grep -rn "AGENTS\|CLAUDE.md" src --include="*.ts"` returned zero relevant lines outside test comments (observed at `exec-11`) (**observed**).
  - `mount` / `mounts` appears only as the generic `MountConfig`/`userMounts`/`volumeMounts` system described in §3 (**documented** via `src/MountConfig.ts`, `src/mountUtils.ts`, `src/sandboxes/docker.ts:62-67`), not as a skills-specific facility (**observed**).

- `.out-of-scope/bundled-workflow-templates.md` explicitly places "large, opinionated third-party workflow templates as built-in `sandcastle init` options — for example a `superpowers/freecc` template that bundles its own set of skill files, coding standards, and multi-phase prompts" **out of scope**, noting they would be a maintenance burden and that users should bring their own via the `custom` template path instead (**documented** at `/.out-of-scope/bundled-workflow-templates.md:3-12`). This is the sole place the repo discusses skill-file bundles, and it rejects shipping them as built-in curated options — not as a per-run skill-selection feature (**documented**).

- Advice mechanism for credentials (the `.sandcastle/.env` + `EnvResolver` indirection) is not extended to skills: `docs/research/permissions-systemic-fix.md` lists the systemic fix for `HOME=/` only, not for skills (**documented**).

### The closest things that do exist (indirect, generic mechanisms)

These are **not skill-specific**, but they are the only knobs that let a harness influence what an agent sees on disk, and they are the surfaces a caller would have to compose to achieve per-run skills control today (**documented**):

1. **Generic bind mounts** (`docker({ mounts: [{ hostPath: "~/.claude/skills/my-skill", sandboxPath: "/home/agent/.claude/skills/my-skill" }] })`)

   - Fully generic; `hostPath` supports absolute, `~/`-expanded (host homedir), and `cwd`-relative paths via `resolveHostPath` at `src/mountUtils.ts:46-50`, and `sandboxPath` supports absolute, `~`-relative to `/home/agent`, or workspace-relative at `src/mountUtils.ts:56-68` (**documented**). Any host directory can be mounted anywhere under `/home/agent` (or workspace) within the `processFileMountParents` validation (`src/mountUtils.ts:284-350` requires file-mount parents to be under `/home/agent`). To mount a chosen subset of `~/.claude/skills`, a caller can list one `MountConfig` per skill directory. Example patterns exist in the test suite: `src/sandboxes/docker.test.ts:645-680` mounts a tmp file to `/home/agent/.codex/auth.json` and asserts `mkdir -p`+`chown` of the parent dir (`/home/agent/.codex`) (**documented** as a usage example, not a skills feature). No filtering logic validates that the mount target is a skills directory — it is treated opaquely like any other mount (**documented**).

2. **Worktree content (repo-owned instruction files)**

   - The agent always sees the repo checkout as mounted at `/home/agent/workspace` (see §3). Any `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, or skills checked into the repo are visible automatically because the worktree is the repo root (**documented** at `src/SandboxFactory.ts:133`, `README.md` repo layout). Ignoring or rewriting them would require editing the worktree (via `copyToWorktree` or hooks or a pre-run commit) — no "exclude these repo paths" flag exists (**observed** by absence in `src/run.ts`/`src/createSandbox.ts` options).
   - Conversely, host-global skills/config (e.g. `~/.claude/skills` global) are **not** visible unless explicitly mounted — they are host-global state outside the worktree and no default mount copies them (**documented** by absence in §3 mount assembly).

3. **`copyToWorktree: string[]`**

   - Copies named host-relative paths into the worktree before the container starts (`src/CopyToWorktree.ts:14-54`, `src/SandboxFactory.ts:340-360`). A harness could place a generated config or filtered skill subset at a host path and then copy it into the worktree (e.g. `copyToWorktree: [".agents/skills-filtered"]`) — but this indirection copies into the **worktree repo root**, not into `~/.claude` inside the container, so it only helps for repo-scoped instruction files, not for home-scoped agent config unless combined with a mount that re-locates it (**documented**).

4. **Dockerfile / Containerfile baking**

   - `Dockerfile` template (`src/InitService.ts:218-236` `CLAUDE_CODE_DOCKERFILE` etc. and `.sandcastle/Dockerfile` observed at `src: /.sandcastle/Dockerfile:1-39`) controls the base image. A harness can fork the scaffolded `Dockerfile` to `COPY` or `RUN` a curated skill/config tree into the image at build time (`ENTRYPOINT ["sleep","infinity"]`, `USER ${AGENT_UID}` context). That is image-level, not per-run (**documented**). CLI `sandcastle docker build-image --dockerfile <path>` lets the harness point at such a custom Dockerfile without editing `.sandcastle/Dockerfile` (`src/cli.ts:251-255`) (**documented**).

5. **Environment variables / HOME (attempted indirection)**

   - Provider `env` and `.sandcastle/.env` can set arbitrary variables (see §4). Setting `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or a custom `HOME` is forwarded to the sandbox env **unless** overwritten: Docker/Podman force `HOME=/home/agent` at `src/sandboxes/docker.ts:186` / `src/sandboxes/podman.ts:195`, so a fake `HOME` mount/overlay cannot be achieved via env alone (**documented**). For `no-sandbox`, it would be effective (see §4) (**documented**). There is **no documented `configDir` or `skillsDir` env shorthand** registered by any `AgentProvider` — the only env keys injected by each provider are whatever caller supplies via `options.env` (`src/AgentProvider.ts:1187` etc.) plus the common `HOME` (**documented**). No provider sets `CLAUDE_CONFIG_DIR` implicitly (**observed**).

6. **Lifecycle hooks (`hooks.sandbox.onSandboxReady`, `hooks.host.*`)**

   - Arbitrary `sh -c` commands run inside the sandbox after clone but before agent invocation (`src/SandboxLifecycle.ts:94-129`, `src/createSandbox.ts:830-840`). A hook could `mkdir -p ~/.claude/skills && cp ... || curl ...` to synthesize a config directory per run without mounts (`README.md:262-270` example hooks). This is the natural place for a per-run skills generation step today, but it is generic shell, not a typed skills API (**documented**).

7. **No dedicated "write a fresh config directory" primitive**

   - No helper like `writeConfigDir({ skills: string[] })` or `skillMounts` subset field exists. The `MountConfig` interface (`src/MountConfig.ts:7-21`) is the sole file-system injection primitive for bind-mounts, and `SandboxHooks`/`copyToWorktree`/`Dockerfile` are the only code-generation primitives (**documented** by exhaustive option listing at `src/run.ts:250-400`, `src/sandboxes/docker.ts:42-130`, `src/createSandbox.ts:20-80`).

### What does NOT exist — explicit census

- No `skills`, `skillPaths`, `enabledSkills`, `disabledSkills`, `skillAllowlist` key on `RunOptions`, `DockerOptions`, `PodmanOptions`, `AgentProvider` options interfaces, or CLI flags (observed by reading `src/run.ts:250-400`, `src/sandboxes/docker.ts:42-130`, `src/sandboxes/podman.ts:30-120`, `src/AgentProvider.ts:279-730`, `src/cli.ts:9-110`; `grep -rn "skill" src --include="*.ts"` produced zero option definitions) (**observed**).
- No `HOME` or `configDir` caller-controlled option on `docker()`/`podman()`/`noSandbox()` or `AgentProvider` (observed via `grep -n "HOME\|configDir" src --include="*.ts"` which only found forced `HOME` and `InitService` host scaffolding, per §4) (**observed**).
- No rewriting of repo `AGENTS.md`/`CLAUDE.md` discovery inside the sandbox (no code path that moves or hides those files inside the container) (**observed** by absence across `src/SandboxFactory.ts` and `src/SandboxLifecycle.ts`).
- No mount-time filtering based on file name pattern (no `exclude: ["*.md"]` etc.) (**observed**).

## 8. Maturity: version, last commit date, license, test coverage of sandbox backends, whether actively maintained (commit frequency last 90 days)

- **Version** — `0.12.0` per `package.json:3` (`"version": "0.12.0"`) (**documented**)
- **Last commit date** — `2026-06-29` per `git show --stat HEAD` header (`Author Date: Mon Jun 29 21:15:45 2026 +0100`, commit `e99f832`) (observed via `git -C ... show --stat HEAD`) (**observed**). Same as `git log --all --pretty=format:"%ad %h"` sole entry `2026-06-29 e99f832` (observed via `git log --all`) (**observed**).
- **License** — `MIT` per `package.json:30` (`"license": "MIT"`) and `LICENSE:1` (`MIT License`, `Copyright (c) 2026 Matt Pocock`) (**documented**)
- **Test coverage of sandbox backends** — File-level count observed via `ls` and `wc -l` (observed):

  - Total test files: `47` matches of `src/**/*.test.ts` (observed via `ls src/*.test.ts | wc -l` showing 47; note count includes `src/sandboxes/*.test.ts` subset) (**observed**)
  - Sandbox-backend tests that exist:

    - `src/sandboxes/docker.test.ts` — 797 lines (**observed**), covers construction validation, tilde/relative/absolute mount resolution, readonly/SELinux mount formatting (`:ro,z`/`:Z`/none), network/groups/devices wiring (implicitly), file-mount `mkdir+chown` after start, and parent-outside-`/home/agent` throws (**documented** by inspecting `docker.test.ts:32-750` headings)
    - `src/sandboxes/podman.test.ts` — 978 lines (**observed**), mirrors docker coverage for Podman (same mount/SELinux/file-mount chapters) (**documented** via same inspection)
    - `src/sandboxes/vercel.test.ts` — 213 lines (**observed**), minimal existence + construction path (**documented**)
    - `src/sandboxes/no-sandbox.test.ts` — exists (observed via `ls src/sandboxes/*.ts` listing) (**observed**)
    - `src/sandboxes/test-bind-mount.test.ts` (190 lines) and `src/sandboxes/test-isolated.test.ts` (162 lines) and `src/sandboxes/test-shared.ts` — test-only providers that exercise the abstract `createBindMountSandboxProvider` / `createIsolatedSandboxProvider` contract (filesystem copies vs cloud) without requiring real Docker/Vercel (**observed**)
    - No dedicated `daytona.test.ts` found (observed via `ls src/sandboxes/*.test.ts` — only docker, podman, vercel, no-sandbox, test-bind-mount, test-isolated listed; `daytona.ts` has zero corresponding test file) (**observed**). So `daytona` is **unverified** as to test coverage — none found in clone (**observed**).

  - Non-sandbox but sandbox-adjacent tests also exercise mounting indirectly: `src/SandboxFactory.test.ts` (`passes worktree path and git mounts to provider.create` at line 205-230 etc.), `src/DockerLifecycle.test.ts` / `src/PodmanLifecycle.test.ts`, `src/createSandbox-windowsMounts.test.ts`, `src/createSandbox.test.ts`, `src/WorktreeManager.windowsPath.test.ts`, `src/mountUtils.test.ts` (all **documented** covers)

- **Whether it is actively maintained (commit frequency over last 90 days of clone history)**

  - The clone is **shallow with depth 1** (observed via `git rev-list --count HEAD` == 1 and `git log --all --since="90 days ago"` showing same single entry) (**observed**), so a 90-day frequency cannot be computed from the available history (**unverified** via this shallow clone).
  - Indirect evidence of active maintenance **prior to clone date** (documented, not a substitute for frequency): `CHANGELOG.md:1-200` lists detailed minor/patch entries through `0.12.0` (2026-06-29) with per-PR references (e.g. `0.11.0` with resume/fork `bce86dd`, `0.10.0` verbose logging `e445b70`, `0.7.0` non-interactive init `22113ca`, `0.6.6` completionTimeout `ddc26ba`) and `CHANGELOG.md:503` single patch note for `HOME=/home/agent` fix `78ef034` (**documented**). `README.md:36-70` and `.changeset/README.md`/`.github/workflows/ci.yml` + `release.yml` describe changesets + automated release workflow (**documented**). But the statement "commit frequency over last 90 days is X" is **unverified** from this clone because the history needed to count was not fetched (**unverified**). If the clone were unshallowed, that count would be the answer; with this shallow snapshot, it must be reported as missing per instructions ("that silence is itself an answer").

## 9. What the author says about WHY it exists and what it does NOT solve

### WHY it exists (author's stated purpose)

- "A TypeScript library for orchestrating AI coding agents in isolated sandboxes: You invoke agents with a single `sandcastle.run()`. Sandcastle handles sandboxing the agent with a configurable branch strategy. The commits made on the branches get merged back." (`README.md:9-14`) (**documented**)
- Same framing, more conceptual: "provider-agnostic — it ships with built-in providers for Docker, Podman, and Vercel, and you can create your own. Great for parallelizing multiple AFK agents, creating review pipelines, or even just orchestrating your own agents." (`README.md:14`) (**documented**)
- Toolkit definition: "A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations." (`CONTEXT.md:1-3`) (**documented**)
- `docs/content/docs/index.mdx:7-9` repeats lifecycle management: "managing the full lifecycle of running an agent against your codebase: syncing code into a sandbox, invoking the agent, and syncing changes back." (**documented**)
- `research/sandbox-provider-research.md:1-5` frames the pluggable sandbox architecture as intentional: distinction of bind-mount vs isolated providers, evaluated alternatives (Docker, Podman, nerdctl, LXC, systemd-nspawn, Apptainer, OCI runtimes runc/crun/youki/gVisor/Kata/Sysbox, lightweight VMs Cloud Hypervisor/QEMU/Firecracker, process-level bubblewrap/firejail/minijail/Landlock, macOS Apple Containers/Lima/Colima, isolated E2B/Daytona/Modal) to justify the provider abstraction (**documented** at `research/sandbox-provider-research.md:18-200`).

### What it does NOT solve (explicit out-of-scope and ADR rejections)

- **`/.out-of-scope/bundled-workflow-templates.md:3-12`** — Does **not** ship large, opinionated third-party workflow templates as built-in `sandcastle init` options (e.g. `superpowers/freecc` skill markdown trees). Extension point is the `custom` template path; large external workflows should be distributed as their own template packs outside Sandcastle's releases (**documented**).
- **Other `.out-of-scope/*.md` documents (seven files, listed via `ls .out-of-scope/`)** — by presence and titles they name additional explicit non-goals (observed via `ls .out-of-scope/` returning `built-in-agent-providers.md`, `built-in-sandbox-providers.md`, `bundled-workflow-templates.md`, `configurable-namespace-prefix.md`, `custom-base-image-abstraction.md`, `docker-provider-bespoke-options.md`, `multi-repo-sandbox.md`, `provider-error-retry.md`) (**observed**). Content not inspected in this pass except `bundled-workflow-templates.md`, so their specific rejected scopes beyond titles are **unverified** (report silence: titles suggest "adding many built-in agent providers", "adding many sandbox providers", "namespace prefix configurability", "base-image abstraction", "bespoke docker options", "multi-repo sandbox", "provider error retry" are out of scope as of clone date, but exact rationale would require reading each `*.md`) (**unverified**).
- **`ideas/config-and-hooks.md:1-40`** (research/draft, not built feature) — proposes a future `config file` (format TBD) for prompt config, post-sync-in command, Docker settings, iteration settings, and deferred **lifecycle hooks** (`onSetup`, `onSyncIn`, `beforeRun`, `afterRun`, `onSyncOut`, `onCleanup`) with open questions about exec location/shape/error handling — explicitly **not** in v1, noted as "should be designed so hooks can be added later without breaking changes" (**documented**). The eventual `hooks` surface that did ship (`SandboxHooks` at `src/SandboxLifecycle.ts:94-105` and `run()` `hooks` option) is the realized subset, limited to `host.onWorktreeReady`, `host.onSandboxReady`, `sandbox.onSandboxReady` (**documented**).
- **`docs/adr/0015-no-sandbox-in-run-and-create-sandbox.md:1-20`** — Author explicitly explains the **trust model** and why a type-level guard was removed: previously only `interactive()` accepted `noSandbox()`, `run()`/`createSandbox()` rejected it to prevent unsupervised AFK-on-host. This was dropped (Decision: `SandboxProvider` now includes `NoSandboxProvider` alongside the other two) because subscription-billed users and already-isolated CI needed AFK-on-host and every such user had reinvented a workaround; `noSandbox()` import itself is the opt-in, no extra `allowAfk` flag, and Sandcastle adds no runtime guard — caller owns the risk. Rejected alternative: keep guard + add `allowAfk` flag (rejected as ceremony without prevention), and rejected forcing a worktree for `noSandbox()` head strategy (**documented** at `docs/adr/0015-no-sandbox-in-run-and-create-sandbox.md:8-25`).
- **`docs/adr/0010-structured-output.md:14-40`** — Rejected generalizing the completion signal to carry payload, adding a parallel `generate()` entry point, auto-injecting prompt instructions, tolerant JSONC parsing, first-match/throw-on-multiple logic, discriminated-union return — keeping structured output single-shot (`maxIterations === 1` only), caller-owned prompt instruction, last-match-wins fence-aware extraction, throwing `StructuredOutputError` (**documented**).
- **Other cited ADRs present as out-of-scope context**: `0001`-`0020` include decisions not to do naive chown (`0005-remove-chown-uid-alignment`), to fail fast on prompt expansion error rather than retry (`0020`), to keep resume as one-iteration only (`0011`), to require filesystem-backed sessions for resume (`0016`), to keep sync base-ref owned by sandbox (`0017`), fork is session-only not branch/sandbox (`0018`), to use a completion timeout for hanging processes rather than waiting full idle timeout (`0019`) — each names a narrower alternative that was deliberately NOT implemented (**documented** by titles + per-ADR content where inspected at `docs/adr/0010-structured-output.md` etc.; full enumeration is 20 ADRs per `ls docs/adr/`: 0001-0020 as listed at start) (**documented**).

## Open

- **Skill/configDir control (Q7) granularity** — Settled as negative: no first-class per-run skill subset API exists (see §7 exhaustive search). No further unresolved sub-question; the only silence is the dedicated feature that would make the harness's job trivial (a single `skills` or `configDir` field) — it does not exist, and that absence is the answer (**documented** by absence).
- **Platform coverage nuance** — `research/sandbox-provider-research.md` evaluates Linux/macOS/Windows platform rows, but the repo's docs-site `docs/content/docs/configuration.mdx` (not inspected) may document additional platform-specific prerequisites for Windows path patching (`ADR 0006`); not inspected and not claimed here (**unverified**).
- **Sandbox backend test coverage for `daytona`** — No test file found (`ls src/sandboxes/*.test.ts` lacks `daytona.test.ts`; `daytona.ts` exists). Coverage for that backend is **unverified** absent a sweep of the `plans/` or `.sandcastle/` example runs (**unverified**).
- **Maintenance cadence last 90 days** — Cannot be settled from this shallow clone (depth 1, single commit `2026-06-29` visible). The repo's `CHANGELOG.md` implies frequent releases up to `0.12.0` but does not substitute for a `git log --since="90 days ago"` count. Fetching `origin/main` unshallowed would resolve this; no fetch was performed during this research per brief ("do not fetch it again") (**unverified**).
- **Out-of-scope non-goals beyond `bundled-workflow-templates.md`** — Seven `.out-of-scope/*.md` files exist by name; only one was read. The other six's exact rejected rationale is **unverified** in this pass (title alone suggests scope, not reasoning). Listing their file names is the extent of the claim that can be made without reading them (**unverified**).
- **Network fetch disclaimer** — Network access was optional per brief and was not used. Any web-sourced URL/section claim would be marked **unverified**; none are made here. Clone is authoritative as of the cited commit (**observed**).
