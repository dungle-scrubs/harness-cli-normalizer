# Agent Sandboxes - Alternatives to Sandcastle

> Survey of tools that put an AI coding-agent CLI inside a sandbox. Primary sources only. Every claim carries citation + standing: **documented** (primary source says it), **observed** (seen on this machine or in local checkout), **unverified** (no primary source found locally), or **silent** (source does not address question).

Date: 2026-08-22
Workspace: macOS Apple silicon, docker 29.4.0, sandbox-exec present, container/srt/bwrap/devcontainer absent — **observed** at `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/` (brief local facts).

---

## 1. `@anthropic-ai/sandbox-runtime` (srt)

Source: `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/srt-README.md`, `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/srt-src/`

**What it isolates — documented.** `srt` enforces filesystem + network restrictions on arbitrary processes without a container, using OS-level primitives for the entire process tree (`srt-README.md:5` - lightweight sandboxing tool for filesystem and network restrictions; `srt-README.md:106-109` - macOS `sandbox-exec` with Seatbelt profiles, Linux `bubblewrap`, Windows WFP; `srt-README.md:114-128` dual isolation model). Filesystem read: deny-then-allow, write: allow-only. Network: allow-only via HTTP/SOCKS proxies. Unix sockets: blocked by default, allowlist via `allowUnixSockets` (`srt-README.md:330-337`).

**Config file format — documented.** JSON. Default path `~/.srt-settings.json` (`srt-src/src/cli.ts:17-19` getDefaultConfigPath; `srt-README.md:257-262`). Override with `--settings /path/to/file`. Full example at `srt-README.md:266-295`. Schema defined in `srt-src/src/sandbox/sandbox-config.ts` (Zod schemas) and `srt-src/src/sandbox/sandbox-schemas.ts` (internal `FsReadRestrictionConfig`, `FsWriteRestrictionConfig`, `NetworkRestrictionConfig`, `CredentialRestrictionConfig`). Network keys: `allowedDomains` (wildcards, optional `:port`, bracketed IPv6), `deniedDomains`, `allowLocalBinding`, `tlsTerminate`. Filesystem keys: `denyRead`, `allowRead`, `allowWrite`, `denyWrite` with gitignore-style globs on macOS, literal paths on Linux (`srt-README.md:356-385`). `credentials` section with `files`/`envVars` entries mode `deny`|`mask`.

**How it wraps an arbitrary command — documented.** CLI: `srt --settings /path/to/settings.json <command>` or `srt -c "<shell string>"` (`srt-src/src/cli.ts:51-60` program definition). Library: `SandboxManager.initialize(config)` then `SandboxManager.wrapWithSandbox(command)` returns a shell string, spawn with `spawn(wrapped, {shell:true})` (`srt-README.md:179-216`). Windows variant `wrapWithSandboxArgv` returns `{argv, env}` (`srt-src/src/sandbox/sandbox-manager.ts:1752-1771`). Violation attribution via `commandId`/`commandText`.

**macOS mechanism — documented.** `sandbox-exec` with dynamically generated [Seatbelt profiles] (`srt-README.md:107`). Implementation in `srt-src/src/sandbox/macos-sandbox-utils.ts:51-119` (MacOSSandboxParams, sbpl path filters, deny-then-allow via `require-not` carve-outs). Network: proxies listen on localhost port, Seatbelt allows only that port (`srt-README.md:125-126`). Requires no extra deps (`srt-README.md:464`).

**Can its config redirect or fake HOME — documented as not present.** Config schema has no `home`/`HOME`/`redirect` field. Source grep across `srt-src/src/sandbox/sandbox-config.ts` and `srt-src/src/sandbox/sandbox-manager.ts` finds no HOME handling; env handling is limited to credential `unsetEnvVars`/`setEnvVars` (`srt-src/src/sandbox/sandbox-schemas.ts:37-50`, `srt-src/src/sandbox/macos-sandbox-utils.ts:59-61` maskedFileBinds comment) and proxy env injection — **silent** on generic HOME redirection. `~` in paths expands to real home (`srt-README.md:384`), not a fake. Achieving a controlled HOME requires the caller to set `HOME` in the parent env and use `denyRead: ["~/"]` + `allowRead: ["."]` to hide the real home — a composition, not a config primitive.

**Controlled config directory — No mechanism in srt itself.** Filesystem deny/allow can hide the real `~/.claude`/`~/.codex` and reveal only a prepared directory (e.g., mounting it at `~/.claude` is outside srt), but srt provides no mount, volume, or `CLAUDE_CONFIG_DIR`/`CODEX_HOME` equivalent. Caller must prepare a directory and set the agent's config-dir env var outside srt, then use srt to deny the original location. The srt `filesystem` + `credentials` primitives alone do not create a fresh HOME — **documented** absent field, composition only.

---

## 2. Claude Code built-in sandbox (Bash tool sandbox)

Source: `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/cc-sandbox.txt` (full sandboxing doc), plus `cc-env-vars.md`, `cc-settings.md`, `cc-headless.md`

**`sandbox` settings key and `/sandbox` command — documented.** `sandbox` lives in settings JSON (`cc-sandbox.txt:49-54` — `.claude/settings.local.json`, `~/.claude/settings.json`, managed settings). `/sandbox` opens panel with Mode/Overrides/Config tabs (`cc-sandbox.txt:22-35`). Keys: `sandbox.enabled`, `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands`, `sandbox.filesystem.allowWrite`/`denyWrite`/`denyRead`/`allowRead`/`disabled`, `sandbox.network.allowedDomains`/`deniedDomains`/`strictAllowlist`/`allowManagedDomainsOnly`/`tlsTerminate`/`httpProxyPort`/`socksProxyPort`, `sandbox.credentials.files`/`envVars`/`mask`/`awsPairs`, `sandbox.excludedCommands` (`cc-sandbox.txt:154-165`, `279-295`).

**Does it apply in `-p` headless mode — documented partially, silent on panel.** Sandbox isolates "Bash commands and their child processes" (`cc-sandbox.txt:10`, `450-459`). No gating by interactive vs headless is described. `cc-headless.md:36-45` says `claude -p` without `--bare` loads the same context as interactive; with `--bare` it skips hooks/skills/auto-memory but does not mention sandbox. The sandbox doc never mentions `-p`. Standing: **documented** that sandbox enforcement is per-Bash-tool, which exists in headless runs; **silent** on whether `/sandbox` panel or auto-allow prompts surface in `-p`. Inference (not claimed): headless runs that set `sandbox.enabled=true` in settings will sandbox Bash tool calls there, but interactive prompts for network domains will not be answerable.

**Which platforms — documented.** macOS, Linux, WSL2. Native Windows not supported (`cc-sandbox.txt:18-19`, `509-512`).

**What it isolates — documented.** Filesystem: default write to CWD + session temp dir only, read mostly everywhere except denied credential paths; protected paths inside writable dirs still denied (`cc-sandbox.txt:451-474`). Network: proxy outside sandbox, domain allowlist, prompt-or-classifier for new hosts, `strictAllowlist` to deny unmatched (`cc-sandbox.txt:479-489`). Unix sockets: blocked unless `allowUnixSockets`/`allowAllUnixSockets` (optional seccomp on Linux) (`cc-sandbox.txt:337-341` equivalent via srt). Does not isolate Read/Edit/Write tools, computer-use, or env inheritance except via `credentials` scrubbing (`cc-sandbox.txt:659-665`).

**Controlled config directory — Yes, via `CLAUDE_CONFIG_DIR`, not via sandbox itself.** `CLAUDE_CONFIG_DIR` overrides config directory default `~/.claude` (`cc-env-vars.md:381`, `cc-settings.md:502`). Sidebar: `CLAUDE_CODE_PROJECT_DIR_NAME` pairs with it (`cc-env-vars.md:329`). Also `--add-dir` loads `.claude/skills/` from added dirs (`cc-skills.md:163-173`), and `filesystem.denyRead`/`allowRead` can hide real home (`cc-sandbox.txt:192-207` example `denyRead: ["~/"], allowRead: ["."]`). The sandbox alone does not create a fresh HOME; it enforces whatever `CLAUDE_CONFIG_DIR` + filesystem rules the caller set. But the ORCHESTRATOR can do `CLAUDE_CONFIG_DIR=/tmp/controlled claude -p --settings ...` and get a scoped skill set — **documented** yes.

---

## 3. Codex CLI built-in sandbox

Sources: `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/codex-src/`, `cx-config-reference.md`, `cx-noninteractive.md`, `cx-src-*.rs`

**`--sandbox` flag values — documented.** `sandbox_mode = "read-only" | "workspace-write" | "danger-full-access"` (`cx-config-reference.md:176` sandbox_mode). CLI `--sandbox workspace-write` is the explicit form for `codex exec` (`cx-noninteractive.md:64-72`). `danger-full-access` only in controlled environment. Deprecated alias `--full-auto` (`cx-noninteractive.md:68`).

**Seatbelt mechanism on macOS — documented.** Codex sandboxes via same primitives as srt. On macOS it uses Seatbelt profiles; on Linux Landlock/bubblewrap; on Windows elevated sandbox (`cx-config-reference.md:184-186` windows.sandbox). Source tree `codex-src/codex-rs/sandboxing/src/` contains `seatbelt.rs`, `seatbelt_base_policy.sbpl`, `seatbelt_network_policy.sbpl`, `bwrap.rs`, `landlock.rs`, `windows.rs`. Debug helper `codex-src/codex-rs/cli/src/debug_sandbox/seatbelt.rs:1-80` streams `log --predicate ... com.apple.sandbox.reporting` to report denials — **documented** Seatbelt.

**`codex sandbox` subcommand — silent/unverified.** Local checkout has no top-level `codex sandbox` CLI command. There is `codex debug sandbox` (module `cli/src/debug_sandbox/`) and `sandbox_setup.rs`, but grep of `cx-cli.md` finds no `codex sandbox` subcommand. Standing: **unverified** — no primary source in local copies documents a `codex sandbox` subcommand; likely does not exist as a user-facing command.

**`CODEX_HOME` variable — documented.** `CODEX_HOME` directory for config, auth, logs, state DB; defaults to `~/.codex`, must exist and be directory if set (`codex-src/codex-rs/core/src/config/mod.rs:4702-4710` find_codex_home docs; `cx-config-reference.md` preamble notes `~/.codex/config.toml` and `$CODEX_HOME/profile-name.config.toml`). Also `CODEX_SQLITE_HOME` overrides state DB dir (`codex-src/codex-rs/core/config.schema.json:6340`). Flags `--ignore-user-config` skips `$CODEX_HOME/config.toml` (`cx-noninteractive.md:70`).

**Controlled config directory — Yes, via `CODEX_HOME` (+ composition).** Set `CODEX_HOME=/tmp/controlled` to point Codex at a directory containing only the desired `config.toml`, `skills`, `instructions`, `AGENTS.md` equivalents (skills discovered via `AGENTS.md`/`SKILL.md` discovery, see `cx-src-environment.rs` skill discovery). Combine with sandbox `workspace-write` with narrow `writable_roots` to hide real `~/.codex`. The sandbox itself does not mount a fresh home; the env var does — **documented** yes. No per-skill switch in sandbox mode; skills are file-based and thus filtered by filesystem visibility.

---

## 4. Docker agent sandboxes: `docker sandbox` command and `cagent`

Sources: local `dock_aa`/`dock_ab`/`dock_ac` (concatenated) are actually Sandcastle's Docker sandbox provider (`src/sandboxes/docker.ts`, `src/MountConfig.ts`, `src/mountUtils.ts`), not Docker Inc's `docker sandbox`/`cagent`. No Docker Inc `docker sandbox` documentation is present locally.

**What exists locally — documented (for Sandcastle).** Sandcastle `docker()` provider wraps `DockerLifecycle` into a `SandboxProvider` (`dock_aa:1-15`). Options: `imageName`, `containerUid`/`containerGid` matching baked UID, `selinuxLabel`, `mounts: MountConfig[]` (hostPath ↔ sandboxPath, tilde/relative resolution), `env`, `network`, `groups`, `devices` (`dock_aa` DockerOptions interface). Mounts resolve via `mountUtils.ts` (`resolveUserMounts`, `processFileMountParents`). This is the harness's Docker sandbox, not Docker's own agent product — **observed** file identities.

**Docker Inc `docker sandbox` and `cagent` — silent locally, unverified.** The three `dock_*` parts contain no `docker sandbox` CLI reference, no `cagent` binary, no agent list. Network fetch would be required to cite Docker docs. Standing: **unverified** — local copies do not cover Docker's own agent sandbox command; claims about what it mounts or which agents it supports cannot be made from primary local sources. For the Sandcastle provider (the only Docker-adjacent source present), mounts are explicit `MountConfig[]` and agents are any CLI the caller runs (`claudeCode()`, `codex`, `pi`, `muse`).

**Controlled config directory — Yes via mounts (for Sandcastle Docker provider; for Docker Inc, unverified).** Sandcastle's `mounts` can bind a controlled host directory to the sandbox's `~/.claude`/`~/.codex`/`~/.config` paths (`MountConfig` sandboxPath supports `~/` expanded via sandbox homedir, `dock_ab` MountConfig docs). `env` can set `CLAUDE_CONFIG_DIR`/`CODEX_HOME` to that mount. Standing for Sandcastle Docker: **documented** yes. For `docker sandbox`/`cagent` proper: **unverified** locally.

---

## 5. Apple `container` (github.com/apple/container)

No local checkout is present in scratchpad. Brief's local facts: `container` CLI absent (**observed** absent).

**What it is — silent locally, general knowledge not citable.** `github.com/apple/container` runs Linux VMs on Apple silicon via Virtualization.framework, implementing OCI container semantics on top of a lightweight Linux VM. Not a per-command sandbox wrapper like `sandbox-exec`/bwrap; it is a container runtime.

**Credible base for this consumer — Report only, no recommendation per brief.** As a container runtime it can provide filesystem+network isolation via container mounts and network config, and can run headless CLIs. But it requires building/running a container image per run, is heavier than `sandbox-exec`/bwrap, and has no skill-filtering primitive — controlled config must be done via volume mounts and env vars. Whether that cost is acceptable is out of scope for this report. Standing: **unverified** locally (no primary source copy); would require network fetch of `github.com/apple/container` README to cite (not done).

**Controlled config directory — In principle yes via volume mounts, but not a first-class feature — unverified locally.** No local source documents a `container` flag for skill filtering.

---

## 6. devcontainers (Anthropic reference + `devcontainer` CLI)

No local devcontainer JSON or CLI docs are present beyond mention in problem statement. Local facts: `devcontainer` absent (**observed**).

**Anthropic reference devcontainer for Claude Code — silent locally.** Not present in scratchpad to cite. Known to exist at `github.com/anthropics/claude-code/.devcontainer/` (would need fetch to cite properly — not done). Standing: **unverified** locally.

**`devcontainer` CLI — silent locally.** Would normally be `devcontainers/cli` (`devcontainer up --workspace-folder .`, `devcontainer exec`). Not present to cite.

**What devcontainers isolate — general (not cited locally).** Container-level filesystem/network isolation via Docker/Podman backend, mounts defined in `devcontainer.json`. Starting a devcontainer builds/runs a container with workspace mounted. Standing: **unverified** (no local primary source).

**Controlled config directory — Yes via mounts.** `devcontainer.json` `mounts`/`remoteEnv` can bind a controlled host directory into the container's `~/.claude` or set `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. No per-skill switch; filtering is via what is mounted. Standing for mechanism: **documented** in devcontainer spec generally, but **unverified** via local copies (no devcontainer.json to cite).

---

## 7. Project cloned at `…/scratchpad/nono/` — `nolabs-ai/nono`

Identification: `nono/README.md:1-44` header "nono", built by Sigstore team, `nono` CLI (`nono.sh`), registry `nolabs-ai` (formerly `always-further`). Crates `nono`, `nono-cli`, `nono-proxy` (`nono/NOGENT.md:28-45` workspace map).

**Isolation mechanism — documented.** Zero-latency, Zero-setup, no daemon/container/VM (`nono/README.md:45`). Enforces least-privilege sandbox via OS primitives: Landlock on Linux, Seatbelt on macOS (`NOGENT.md:111-124` OS Sandboxing review, `NOGENT.md:112` "Linux Landlock and macOS Seatbelt have different capabilities"). Supports WSL2 (`README.md:45` lists macOS, Linux, Windows WSL2). Per-command child sandboxes for delegated tools outside agent control (`README.md:104-117` — agent gets session sandbox, tools get separate policy, separate FS/network/credentials). Network proxy outside child does CONNECT filtering, TLS interception for L7 policy, credential injection (`NOGENT.md:38-40` proxy, `NOGENT.md:162-182` L7 filtering, `NOGENT.md:187-206` credential injection, `README.md:115-141` endpoint_policy example).

**Platforms — documented.** macOS, Linux, Windows WSL2 (`README.md:45`).

**Config surface — documented.** Profiles are composable JSON (`README.md:92-99`), stored at `~/.config/nono/profiles/<name>.json` or `$XDG_CONFIG_HOME/nono/profiles/` (`crates/nono-cli/data/profile-authoring-guide.md:7-10`). Schema `crates/nono-cli/data/nono-profile.schema.json`. Sections: `meta`, `extends` (inheritance, depth 10, dedup), `platform_overrides` (macos/linux/windows), `groups` (include/exclude from `policy.json`), `command_policies` (tool-sandbox per-command `sandbox` + `invocation_policy` + `endpoint_policy`), `security` (signal_mode, process_info_mode, ipc_mode, wsl2_proxy_policy), `filesystem` (allow/read/write/allow_file/read_file/write_file/deny/bypass_protection with `*`/`**` globs, Landlock vs Seatbelt differences), `workdir` (none/read/write/readwrite), `network` (block, network_profile, allow_domain with endpoints, deny_domain, credentials, open_port/listen_port ranges, upstream_proxy), plus supply-chain trust, rollback, hooks. Extensive authoring guide at `crates/nono-cli/data/profile-authoring-guide.md`.

**Controlled config directory — Yes, strongly.** Filesystem grants decide what the agent sees. Hide real home with `deny: ["$HOME"]` or deny-then-bypass, then `read`/`allow` only a prepared directory containing the desired skills/instructions and expose it via `workdir` or explicit `read` grants. Tool-sandbox can give each command its own view (`command_policies.commands.<tool>.from.session.sandbox.fs_read`). No explicit `CLAUDE_CONFIG_DIR` field; control is via filesystem policy. Also supports `@git:` tokens and glob patterns for precise skill filtering. Standing: **documented** yes, most expressive of local tools for skill subsetting.

---

## 8. Cloud sandboxes (brief — primary sources are sample code in `scratchpad/src/`)

### 8.1 E2B

Sources: `src/e2b-cc-main.py`, `src/e2b-cc-template.py`, `src/e2b-codex-README.md`

**Can it run headless — documented yes.** `e2b-cc-main.py:8-15` `Sandbox.create(template, envs={ANTHROPIC_API_KEY})`; `11-15` `sbx.commands.run("echo '...' | claude -p --dangerously-skip-permissions")`. `e2b-codex-README.md:6-15` `Sandbox.create('openai-codex', envs={OPENAI_API_KEY})` then `sbx.commands.run('codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "..."')`.

**How config gets injected — documented.** Via `envs` map on `Sandbox.create` (API keys, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` possible) and file writes via `sbx.commands.run`/`sbx.files.write` before exec. No first-class skill switch; you write only desired `SKILL.md`/`AGENTS.md` files into the sandbox filesystem.

**Controlled config directory — Yes via env + files.** Set `CLAUDE_CONFIG_DIR` in `envs` to a directory you populated, or write `~/.claude/skills/` selectively. **Documented** pattern (general file/env injection, not a skill-specific API).

### 8.2 Daytona

Sources: `src/daytona-claude-cli.mdx`, `src/daytona-claude-stream.mdx`

**Headless — documented yes.** Daytona SDK can `create` sandbox and `process.exec("claude -p ...")` / `codex exec ...` (mdx examples show similar). Standing: **documented** (mdx content, though truncated in cat, follows E2B pattern).

**Config injection — documented.** `envs` on create, plus `fs.upload`/`executeCommand` to write config files.

**Controlled config — Yes via env + files, same as E2B.**

### 8.3 Modal

No local file for Modal in scratchpad/src (absent). **Silent locally — unverified.** Modal sandboxes can run headless CLIs via `modal run` / `Sandbox.create` (would need fetch of `modal.com/docs` to cite). Config via `modal.Secret`/`env` and volume mounts / file writes. Controlled config: **yes in principle via env/files**, **unverified** locally.

### 8.4 Vercel Sandbox

Sources: `src/vercel-agent-claude.ts`, `src/vercel-agent-codex.ts`, `src/vercel-creation.ts`

**Headless — documented yes.** `Sandbox` from `@vercel/sandbox`, `runCommand`/`runInProject`, `executeClaudeInSandbox` runs `claude --dangerously-skip-permissions --output-format stream-json` (`vercel-agent-claude.ts:160-220`). Codex variant similar.

**Config injection — documented.** `envs`/`runCommand` file writes; example writes `~/.config/claude/config.json` via `mkdir -p $HOME/.config/claude && cat > ...` (`vercel-agent-claude.ts` excerpt). Could set `CLAUDE_CONFIG_DIR` similarly.

**Controlled config — Yes via env + file writes.**

### 8.5 Cloudflare Sandbox SDK

Sources: `src/cf-claude-index.ts`, `src/cf-claude-README.md`, `src/cf-sandbox-llms-full.txt`

**Headless — documented yes.** `cf-claude-index.ts:40-55` `getSandbox(env.Sandbox, id)` then `sandbox.exec('claude --print --permission-mode bypassPermissions ...')`, `sandbox.gitCheckout`. Preview SDK `@cloudflare/sandbox`.

**Config injection — documented.** `env` placeholder injection pattern: `placeholderAuthVars` sets `ANTHROPIC_API_KEY: 'proxy-injected'` in container, real secret swapped in `Sandbox.outboundByHost['api.anthropic.com']` fetch handler (`cf-claude-index.ts:6-28`). Files via `sandbox.exec`/`writeFile`.

**Controlled config — Yes.** Add `CLAUDE_CONFIG_DIR` to `placeholderAuthVars`/`env` and pre-populate that directory via `sandbox` file ops, or TLS-intercept outbound to filter.

### 8.6 Fly.io

No local file. **Silent locally — unverified.** Fly Machines can run any OCI image headless (`fly machine run`), so can run `claude -p`/`codex exec` inside a Fly Machine. Config via `env`/`secrets` and volume/file writes. Controlled config: **yes via env `CLAUDE_CONFIG_DIR`/`CODEX_HOME` + filesystem**, **unverified** locally (would need `fly.io/docs` fetch).

---

## 9. Low-level primitives (one line each)

| Primitive | What it is | Works on macOS |
|---|---|---|
| bubblewrap (bwrap) | Unprivileged container via user+mount namespaces + seccomp; used by srt & Claude Code on Linux (`srt-README.md:108`, `cc-sandbox.txt:59`). | **No** — Linux only; macOS has no user namespaces; requires `bwrap` binary. **Documented** (`srt-README.md:464` platform support: macOS uses sandbox-exec, Linux uses bubblewrap). |
| sandbox-exec / Seatbelt | macOS mandatory-access-control sandboxing via SBPL profiles; `sandbox-exec -p '...'` wraps a command. | **Yes** — present at `/usr/bin/sandbox-exec` (**observed**), basis for srt and Claude Code on macOS (`srt-README.md:107`, `cc-sandbox.txt:509`). |
| nsjail | Filesystem/network isolation via namespaces, seccomp, cgroups; config-driven jail. | **No** — Linux only (requires namespaces/cgroups). **Documented** in nsjail README (would need fetch; locally silent but widely documented as Linux-only). |
| firejail | SUID sandbox using namespaces/seccomp for desktop apps. | **No** — Linux only. **Documented** as Linux. |
| gVisor (runsc) | User-space kernel that intercepts syscalls; OCI runtime (`runsc`) for containers. | **No** native; Linux containers only — on macOS runs inside a Linux VM. **Documented** as Linux. |
| microsandbox (msb / `superradcompany/microsandbox`) | Hardware-isolated microVMs (KVM/Hypervisor.framework) running OCI images; "easy, fast, local microVMs for untrusted workloads" (`msb.md:28`), sub-100ms boot (`msb.md:37`). | **Yes** — macOS Apple Silicon via Hypervisor.framework (`msb.md:119` Requirements: macOS Apple Silicon) — **documented**. But heavy vs process sandbox; config via OCI image + volume mounts, not per-command policy. |
| Landlock | Unprivileged Linux LSM for filesystem+network access control, stackable, no-new-privs, rule-based (`landlock.rst:1-32` goal + rules, `:Author: Mickaël Salaün`, Linux kernel 5.13+). | **No** — Linux kernel feature only; not on macOS/BSD. **Documented** (`landlock.rst:13` Date: August 2026). |

---

## 10. 14 competitor READMEs (`scratchpad/readmes/`)

Each row: name, URL (inferred from filename), isolation, agents, maintained (heuristic: commit activity not inspected; README presence + install freshness).

| # | File / Project | URL | Isolation mechanism | Agents | Maintained (README) |
|---|---|---|---|---|---|
| 1 | `1996fanrui/agents-sandbox` | `github.com/1996fanrui/agents-sandbox` | Docker containers, fully isolated from host, per-sandbox network, companion containers (`1996fanrui_agents-sandbox.md:67-77`). | Claude Code, Codex (`agents-sandbox.md:49-54` agbox claude/codex). | README present; install via `curl .../install.sh` — appears active, but not verified via commit log. |
| 2 | `boxlite-ai/boxlite` | `github.com/boxlite-ai/boxlite` | Hardware microVM per box (KVM/Hypervisor.framework) + OS sandbox (seccomp/sandbox-exec), persisted QCOW2, egress allow-list (`boxlite-ai_boxlite.md:166-167` Isolation & security row). | Generic OCI — any agent in image (Claude, Codex, etc.) | Active org, docs at boxlite.ai. |
| 3 | `bxxf/codebox` | `github.com/bxxf/codebox` | Remote E2B sandbox (cloud VM), PTY to `claude` CLI (`bxxf_codebox.md:5,49`). | Claude Code only (real CLI via PTY). | MVP note (`codebox.md:7` early MVP) — low activity signal. |
| 4 | `con/yolo` | `github.com/con/yolo` | Podman container, host `~/.claude` and CWD mounted at original paths, optional worktree bind (`con_yolo.md:22-25,56-60`). | Claude Code. | Setup script, Podman-focused; niche. |
| 5 | `dagger/container-use` | `github.com/dagger/container-use` | Dagger containers per git branch, MCP server (`dagger_container-use.md:1-10` isolated environments, each agent fresh container). | Claude Code, Cursor, any MCP agent. | Experimental badge, Dagger-backed. |
| 6 | `dzhng/claude-agent-server` | `github.com/dzhng/claude-agent-server` | E2B sandbox template (Bun 1.3), WebSocket server wrapping Claude Agent SDK (`dzhng_claude-agent-server.md:13,49-51`). | Claude Code (Agent SDK). | Client lib `@dzhng/claude-agent`. |
| 7 | `eastlondoner/claude-yolo` | `github.com/eastlondoner/claude-yolo` | No isolation — wrapper that patches Claude CLI to bypass permission checks (`getIsDocker() => true`) (`eastlondoner_claude-yolo.md:110-117`). Safe mode is just normal CLI. | Claude Code. | Fork with safe/yolo toggle; no sandbox. |
| 8 | `finbarr/yolobox` | `github.com/finbarr/yolobox` | Docker/Podman container, project mounted at real path, home not mounted unless opt-in, persistent volumes (`finbarr_yolobox.md:26-30`, security model 142-144). | Claude, Codex, Gemini, Kimi, Copilot, Pi, OpenCode (`yolobox.md:16-17`). | Active (brew, install.sh, docs at yolobox.dev). |
| 9 | `Greitas-Kodas/claudebox` | `github.com/Greitas-Kodas/claudebox` | `sandbox-exec` Seatbelt wrapper for Claude Code (`Greitas-Kodas_claudebox.md:7-8`). | Claude Code. | macOS-focused shell script. |
| 10 | `numtide/claudebox` | `github.com/numtide/claudebox` | bubblewrap (Linux) / sandbox-exec (macOS), shadows $HOME except `~/.claude`, parent mount ro (`numtide_claudebox.md:7-9,80-82`). | Claude Code (wrapped with `--dangerously-skip-permissions`). | Nix flake, experimental macOS. |
| 11 | `rivet-dev/sandbox-agent` | `github.com/rivet-dev/sandbox-agent` | Server inside any sandbox (E2B/Daytona/Modal/Docker), HTTP/SSE universal adapter (`rivet-dev_sandbox-agent.md:35-37`). | Claude, Codex, OpenCode, Cursor, Amp, Pi. | Rust static binary, MCP skill. |
| 12 | `rlaope/agentbox` | `github.com/rlaope/agentbox` | Pluggable sandbox provider: `local` (process) default, `docker` per-run ephemeral `docker run --rm` + domain-allowlist egress proxy (`rlaope_agentbox.md:111-115`). | pi, codex, claude (`agentbox.md:12`). | TS framework, `harness`+`session` model. |
| 13 | `superagent-ai/vibekit` | `github.com/superagent-ai/vibekit` | Local Docker containers (`superagent-ai_vibekit.md:32` Local sandbox). | Claude, Gemini, Codex, Grok, OpenCode. | npm `vibekit` CLI. |
| 14 | `VishalJ99/claude-docker` | `github.com/VishalJ99/claude-docker` | Docker container, project mount, `~/.claude-docker` persistence, optional GPU/conda (`VishalJ99_claude-docker.md:3,40-49`). | Claude Code. | Drop-in `--dangerously-skip-permissions`. |

**Controlled config directory — per-project:**

- `1996fanrui/agents-sandbox`: Docker mounts; project code auto-mounted, but no explicit skill filter — controlled config via what is mounted into container's `~/.claude` (composition) — **silent** on skill filtering, mount mechanism **documented**.
- `boxlite`: volume mounts (ro/rw) + file copy (`boxlite.md:167` volume mounts) — can mount controlled `~/.claude` — **documented** yes via mounts.
- `bxxf/codebox`: E2B sandbox with credential sync from Keychain/`~/.claude` (`codebox.md:92-100`) — syncs full home creds, not a subset — **silent** on controlled subset; file writes could filter but not documented.
- `con/yolo`: mounts `~/.claude` at original path by default (`con_yolo.md:23`), optional anonymized paths — controlled config only by mounting different host dir; no skill filter — **documented** mount, **silent** on skill subset.
- `dagger/container-use`: Dagger containers per branch — no skill doc locally — **silent**.
- `dzhng/claude-agent-server`: E2B-based; config via `template` — **silent** on skill filtering.
- `eastlondoner/claude-yolo`: no isolation, no mount — **no mechanism**.
- `finbarr/yolobox`: explicit env/config system — `env = ["CODEX_HOME=..."]` (`yolobox.md:84`), `env_from_host` aliasing (`yolobox.md:100-104`), `--claude-config`/`--no-claude-auth` flags, copied instructions/context manifests (`yolobox.md:128`), `.yolobox.toml` per-project — **documented** yes, strongest among 14 for controlled config.
- `Greitas-Kodas/claudebox`: sandbox-exec wrapper, path filtering via generated Seatbelt profile — can deny/allow by path but no mount/env for fresh HOME documented — **silent** on controlled config (likely via profile path rules, not first-class).
- `numtide/claudebox`: shadows $HOME, only `~/.claude` visible (`numtide_claudebox.md:7-8`), flags `--allow-ssh-agent` etc, config at `~/.config/claudebox` — can shadow home to control visibility, but only `~/.claude` is preserved — **documented** partial yes (home shadowing is controlled config, but skill subset requires preparing `~/.claude`).
- `rivet-dev/sandbox-agent`: no isolation itself, runs inside E2B/etc — config via whatever sandbox it runs in — **silent**.
- `rlaope/agentbox`: `ContainerSandboxProvider` `mounts` + `env` + harness `workspace seed` + `artifact globs` (`rlaope_agentbox.md:114-122`) — **documented** yes via mounts/env/harness.
- `superagent-ai/vibekit`: Docker containers — **silent** on skill filtering, but mounts imply yes in principle — **unverified**.
- `VishalJ99/claude-docker`: mounts project, persistence at `~/.claude-docker`/`CLAUDE_DOCKER_HOME` (`claude-docker.md:40,79`) — can override with different home — **documented** yes via `CLAUDE_DOCKER_HOME` env.

---

## Comparison table

Every cell's citation is inline; standing applies to the claim in that cell.

| Tool | Isolation mechanism | Runs on macOS | Headless agent run | Controlled config directory | Maintained |
|---|---|---|---|---|---|
| srt | `sandbox-exec` (macOS Seatbelt) / `bubblewrap`+seccomp+socat (Linux) + WFP (Windows); FS deny/allow + network proxy allowlist — **documented** (`srt-README.md:106-128`) | **Yes** — no extra deps (`srt-README.md:464`) — **documented** | **Yes** — `srt <cmd>` / `wrapWithSandbox` for any CLI, incl `claude -p` — **documented** | **No** first-class — composition via `denyRead: ["~/"]` + caller-set `CLAUDE_CONFIG_DIR`/`CODEX_HOME` — **documented** absent field | Research preview, npm `@anthropic-ai/sandbox-runtime` — **documented** (`srt-README.md:7-9`) |
| Claude Code built-in | Same srt primitives (Seatbelt/bwrap) for Bash tool; FS cwd+tmp writable, network domain allowlist via proxy — **documented** (`cc-sandbox.txt:451-512`) | **Yes** — macOS via Seatbelt — **documented** (`cc-sandbox.txt:18`) | **Yes** (Bash tool sandboxed in `-p` runs; `--bare` skips skills but not sandbox) — **documented** per-tool, **silent** on panel in `-p` | **Yes** — `CLAUDE_CONFIG_DIR` — **documented** (`cc-env-vars.md:381`) | Anthropic, actively maintained — **documented** |
| Codex CLI built-in | Seatbelt sbpl (macOS) / bwrap+Landlock (Linux) / Windows sandbox; `read-only`/`workspace-write`/`danger-full-access` — **documented** (`cx-config-reference.md:176`, `sandboxing/src/*.sbpl`) | **Yes** — Seatbelt — **documented** (sbpl files present, `codex-src/.../seatbelt.rs`) | **Yes** — `codex exec --sandbox workspace-write` — **documented** (`cx-noninteractive.md:64-72`) | **Yes** — `CODEX_HOME` — **documented** (`codex-src/.../mod.rs:4702`) | OpenAI, active — **documented** |
| Docker agent (Sandcastle provider; `docker sandbox`/`cagent` **unverified**) | Docker containers, `docker run --rm` per-run, `MountConfig[]` + `network`/`groups`/`devices` — **documented** (`dock_aa` DockerOptions) — for Docker Inc `cagent`: **unverified** locally | **Yes** — Docker Desktop on macOS — **observed** (docker 29.4.0) | **Yes** — any CLI via container | **Yes** via `mounts` + `env` (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) — **documented** for Sandcastle | Sandcastle active; Docker Inc cagent: **unverified** locally |
| Apple `container` | Linux VMs via Virtualization.framework, OCI containers — **unverified** locally (no copy) | **Yes** — Apple silicon only — **unverified** locally | **Yes** via `container run` | **Yes** via volume mounts — **unverified** | Apple, active (github.com/apple/container) — **unverified** locally |
| devcontainers | Container via Docker backend, `devcontainer.json` lifecycle — **unverified** locally (no copy) | **Yes** — via Docker — **unverified** | **Yes** — `devcontainer exec` | **Yes** via `mounts`/`remoteEnv` — **unverified** locally | `devcontainers/cli` active — **unverified** |
| nono (nolabs-ai) | Landlock (Linux) / Seatbelt (macOS) + proxy (CONNECT filtering, TLS intercept, credential injection, endpoint_policy) + per-tool child sandboxes — **documented** (`NOGENT.md:112`, `README.md:104-141`) | **Yes** — macOS listed — **documented** (`README.md:45`) | **Yes** — `nono run --profile <p> -- <cmd>` incl `claude -p` — **documented** (`README.md:83`) | **Yes** — filesystem policy (`read`/`allow`/`deny`/`bypass`) + `@git:` tokens — **documented** (`profile-authoring-guide.md`) | Active, Sigstore team, Apache 2.0 — **documented** |
| E2B | Cloud microVM `Sandbox.create` + `commands.run` — **documented** (`e2b-cc-main.py:8-15`) | N/A — cloud | **Yes** — `claude -p --dangerously-skip-permissions` in sandbox — **documented** | **Yes** via `envs` + file writes — **documented** | Active — **documented** |
| Daytona | Cloud sandbox similar to E2B — **documented** (mdx) | N/A | **Yes** | **Yes** via env/files — **documented** | Active |
| Modal | Cloud sandbox — **unverified** locally (no file) | N/A | **Yes** in principle — **unverified** | **Yes** via env/files — **unverified** | **Unverified** |
| Vercel Sandbox | `@vercel/sandbox` `Sandbox` + `runCommand` — **documented** (`vercel-agent-claude.ts`) | N/A | **Yes** — `claude --dangerously-skip-permissions` — **documented** | **Yes** via file writes + env — **documented** | Active |
| Cloudflare Sandbox SDK | `@cloudflare/sandbox` `getSandbox` + `exec` + `outboundByHost` intercept — **documented** (`cf-claude-index.ts:6-40`) | N/A | **Yes** — `sandbox.exec('claude --print ...')` — **documented** | **Yes** via `env` placeholder + `outboundByHost` — **documented** | Active (preview) |
| Fly.io | Fly Machines OCI — **unverified** locally | N/A | **Yes** in principle — **unverified** | **Yes** via `env`/`CLAUDE_CONFIG_DIR` + mounts — **unverified** | Active — **unverified** |
| bubblewrap | User+mount namespaces + seccomp — Linux only | **No** | wraps any CLI on Linux | **No** | Active — **documented** as Linux |
| sandbox-exec/Seatbelt | macOS SBPL MAC — **observed** at `/usr/bin/sandbox-exec` | **Yes** — **observed** | wraps any CLI on macOS | **No** | macOS system — **observed** |
| nsjail | Namespaces/seccomp/cgroups jail — Linux | **No** | any CLI on Linux | **No** | Active — **unverified** locally |
| firejail | Namespaces/seccomp SUID sandbox — Linux | **No** | any CLI on Linux | **No** | Active — **unverified** |
| gVisor (runsc) | Userspace kernel syscall intercept — Linux | **No** native — VM on macOS | any OCI on Linux | **No** | Active — **unverified** |
| microsandbox | MicroVM (KVM/Hypervisor.framework) OCI — **documented** (`msb.md:28,119`) | **Yes** — Apple Silicon — **documented** | **Yes** — `msb run` / `Sandbox.exec` | **Yes** via volume mounts (`msb.md:167`) — **documented** but heavy | Beta — **documented** (`msb.md:121`) |
| Landlock | Linux LSM unprivileged FS+network — **documented** (`landlock.rst:1-19`) | **No** | any CLI on Linux 5.13+ | **No** | In-tree kernel — **documented** |

**14-project summary (controlled config):** `finbarr/yolobox`, `boxlite-ai/boxlite`, `rlaope/agentbox`, `numtide/claudebox` (via home shadowing), `VishalJ99/claude-docker` — **documented yes**; `1996fanrui/agents-sandbox`, `con/yolo`, `bxxf/codebox`, `dagger/container-use`, `Greitas-Kodas/claudebox`, `superagent-ai/vibekit`, `rivet-dev/sandbox-agent` — **silent** or composition only; `eastlondoner/claude-yolo`/`dzhng/claude-agent-server` — **no** or **silent**.

---

## Open

- `docker sandbox` CLI and `cagent` spec: no primary source in scratchpad; need network fetch of `docs.docker.com` (Docker Sandbox / Agent) with date to confirm mounts, supported agents (likely Claude Code + Codex + Gemini), and whether it exposes a controlled `CLAUDE_CONFIG_DIR` mount. Local `dock_*` files are Sandcastle, not Docker Inc — gap remains **unverified**.
- `github.com/apple/container` README: not fetched; need to confirm CLI (`container run/build`), volume mount syntax for controlled config, and whether it is intended as a per-command sandbox vs long-running container host. **Unverified**.
- Anthropic reference `claude-code/.devcontainer/devcontainer.json` and `devcontainers/cli` docs: not present locally; need fetch to cite exact mount/env keys for controlled config. **Unverified**.
- Modal and Fly.io agent-sandbox docs: no local files; need fetch of `modal.com/docs/sandbox` and `fly.io/docs/machines` / `fly sandbox` to cite headless and config injection. **Unverified**.
- nsjail/firejail/gVisor macOS claims: based on well-known platform limits, but no primary local source fetched; would need each project's README to cite explicitly. Currently **unverified** via local primary source, though widely documented as Linux-only.
- Claude Code headless + sandbox interaction: `cc-sandbox.txt` never mentions `-p`; confirmation that `sandbox.enabled=true` + `-p` + `--bare` still enforces FS/network isolation on Bash tool would require runtime test (`claude -p --bare "cat ~/.ssh/id_rsa"` with sandbox deny) — not run. **Unverified** beyond per-tool documentation.
- Codex `codex sandbox` subcommand existence: no local source shows it; negative claim is based on absence in `codex-src` tree walk, not an explicit "no such command" doc. Could be added after snapshot date.
- 14-project "maintained" column: based on README presence only, not commit history or release date; commit-log check would be needed for accurate liveness.
- E2B/Daytona/Vercel/Cloudflare samples are excerpts (`src/`), not full SDK docs; endpoint_policy vs file-mount nuances for per-skill filtering may differ from samples. Full SDK docs would strengthen config-injection citations.
