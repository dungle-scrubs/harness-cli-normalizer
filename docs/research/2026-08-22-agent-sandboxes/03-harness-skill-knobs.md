# Harness skill and instruction discovery knobs — primary sources

Scraped docs date: 2026-08-22. Installed versions observed 2026-08-22 via `--version` / `--help`: `claude 2.1.239`, `codex-cli 0.147.0`, `pi 0.84.2`, `Muse Code 0.2.1 (0.2.1-R1215.1)`. Standing words: **documented** = official docs, **observed** = `--help` / installed package source, **unverified** = claimed without source. Empty scraped files (`cx-agents-md.md`, `cx-config-basics.md` = 9 bytes) treated as failed scrapes and not cited.

## 1. claude (Claude Code 2.1.239)

### 1. Skill search roots (precedence documented)

Sources [scratchpad/cc-skills.md: Where skills live] — **documented**:

1. Enterprise — managed settings delivery (e.g. `/etc/claude-code/.claude/skills/<name>/` on Linux) — overrides personal and project.
2. Personal — `~/.claude/skills/<skill-name>/SKILL.md` — overrides project. Source notes `enterprise overrides personal, and personal overrides project` and that personal example overrides project example.
3. Project — `.claude/skills/<skill-name>/SKILL.md` from the directory where `claude` is started and every parent directory up to repo root ("Project skills load from `.claude/skills/` in the directory where you start Claude Code and in every parent directory up to the repository root").
4. Plugin — `<plugin>/skills/<skill-name>/SKILL.md` — namespaced `plugin-name:skill-name`, does not collide.
5. Nested project `.claude/skills/` below starting directory — not loaded at startup; loaded on first `Read`/`Edit` of a file inside that subdirectory, persists for session (qualified name `<subdir>:<name>`; example `apps/web:deploy`).
6. Additional directories via `--add-dir <dir>` / `/add-dir` — each added directory's `.claude/skills/` loads automatically (exception to the `additionalDirectories` file-access-only rule; `permissions.additionalDirectories` does NOT load skills).
7. Synced — `~/.claude/skills/synced/` for skills enabled on claude.ai (only after `CLAUDE_CODE_SYNC_SKILLS=1 claude -p …` non-interactive sync).
8. Bundled — included with Claude Code; not a filesystem path but listed in skills.

`.claude/commands/<name>.md` also creates a `/name` command and works like a skill (legacy), but skill takes precedence on name clash.

**Reads `~/.agents/skills` and `.agents/skills`?** **No.** No mention of `~/.agents/skills` or `.agents/skills` anywhere in `cc-skills.md`. Only `~/.claude/skills` and `.claude/skills`. **Documented as silent** — does not read cross-harness locations. `pi` docs explicitly note compatibility by adding `~/.claude/skills` to its own `skills` array; the converse is not true for Claude Code.

### 2. Instruction files

`CLAUDE.md` (not `AGENTS.md`) is the instruction file — **documented** [scratchpad/cc-memory.md: CLAUDE.md files / How CLAUDE.md files load]:

- Managed policy: `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux/WSL), `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows).
- User: `~/.claude/CLAUDE.md`
- User rules: `~/.claude/rules/*.md` (recursive)
- Project: `./CLAUDE.md` or `./.claude/CLAUDE.md` — auto-discovers from CWD plus every ancestor directory up to filesystem root, ordered root→CWD (deeper wins). `CLAUDE.local.md` alongside each level appends after `CLAUDE.md`.
- Subdirectory `CLAUDE.md` under CWD — loaded lazily on first file read in that subdirectory (not at launch).
- Project rules: `.claude/rules/*.md` (path-scoped via `paths:` frontmatter triggers only on matching file reads).
- Imports: `@path/to/file` expands at load; external imports outside CWD require one-time trust dialog.
- For `AGENTS.md` repos: `CLAUDE.md` can `@AGENTS.md` or symlink to it; Claude Code does not natively load `AGENTS.md`.
- Additional directories: CLAUDE.md from `--add-dir` NOT loaded unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

### 3. Config/home directory variable

`CLAUDE_CONFIG_DIR` — **documented** [scratchpad/cc-env-vars.md: CLAUDE_CONFIG_DIR row; scratchpad/cc-settings.md: Where Claude Code looks for each file]:

- Quote: "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path, as are credentials on Linux and Windows; on macOS, credentials are in the system Keychain."
- Also relocates `~/.claude/settings.json`, `settings.local.json`, `CLAUDE.md` resolution base, `projects/` transcripts, `skills/`, `plugins/`, `projects/<name>/memory/`, and `~/.claude.json` global config handling (the global config section notes it always reads `~/.claude.json` but that relocates via `CLAUDE_CONFIG_DIR` env).
- Companion: `CLAUDE_CODE_PROJECT_DIR_NAME` only has effect when `CLAUDE_CONFIG_DIR` is set; chooses the `projects/` subdirectory name.
- When set to a directory inside a git repo that keeps `.claude/settings.local.json` at repo root, trust handling differs (configuration-home exception skips only trust step).

What it relocates: **all state** under `~/.claude` plus `~/.claude.json` handling, session/history, plugins, skills.

Effect on skill discovery when set: personal skills path becomes `$CLAUDE_CONFIG_DIR/skills/` instead of `~/.claude/skills/`; synced path becomes `$CLAUDE_CONFIG_DIR/skills/synced/`; project `.claude/skills` behavior unchanged (still repo-relative). **Documented**: varying `$CLAUDE_CONFIG_DIR` points to a different home directory than the one edited ("Profile confusion" analog).

### 4. HOME relocation

Plain `HOME` relocation **is not the documented mechanism**; `CLAUDE_CONFIG_DIR` is. However, since default paths are `~/.claude` and `~/...` via `homedir()`, moving `HOME` does relocate them unless `CLAUDE_CONFIG_DIR` is set explicitly. Not documented as intended, but implied by tilde expansion.

What breaks when HOME moves — **documented / observed**:

- Credentials: on macOS, credentials are in system Keychain (not filesystem), so moving HOME does not relocate them but may affect keychain item lookup tied to config path; on Linux/Windows, credentials are `.credentials.json` under config dir, so HOME move relocates them. Source: `cc-env-vars.md` credentials note above.
- OAuth / keychain reads: in `--bare` mode, Claude Code "never reads OAuth and keychain" — but normally keychain reads depend on Keychain, not HOME. Moving HOME does not break keychain but restores a blank `~/.claude` hierarchy.
- Session storage: stored under `$CLAUDE_CONFIG_DIR/projects/` or `~/.claude/projects/` — moves with HOME.
- Additional side effects: `~/.claude/CLAUDE.md` user instructions, `~/.claude/rules/`, and `~/.claude/settings.json` all move. Docs treat `HOME` move as unsupported alternative to `CLAUDE_CONFIG_DIR`; no explicit warning text about breakage beyond the managed-settings and keychain notes.

Viability: **viable but not documented as supported** — `CLAUDE_CONFIG_DIR` is the supported knob; staging a temporary HOME works as a brute-force filesystem isolation but also moves unrelated `HOME` state (shell rc, git config) and on macOS leaves Keychain behind, so it is not equivalent to a clean config relocate.

### 5. Flags/settings that turn skill discovery OFF entirely

- `--disable-slash-commands` — "Disable all skills and commands for this session" — **observed** `claude --help` (line: `--disable-slash-commands  Disable all skills`); **documented** in `cc-cli-reference.md` same wording.
- `--safe-mode` — "Start with all customizations (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents, output styles, workflows, custom themes, keybindings, and more) disabled — useful for troubleshooting" — managed/policy hooks still apply — **documented** [scratchpad/cc-cli-reference.md: --safe-mode] and **observed** `--help`.
- `--bare` — "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery ... Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir." Also printed as "Skip auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory, and CLAUDE.md ... Skills in a directory you pass with --add-dir still load." — **observed** `--help` (`--bare Minimal mode: skip hooks ...`) and **documented** [scratchpad/cc-headless.md: Start faster with bare mode] + `cc-cli-reference.md --bare` row. Note: docs conflict slightly: `--help` says "Skills still resolve via /skill-name" while the table says "skip auto-discovery of ... skills" — resolution: bare skips **auto-discovery** but `/skill-name` via `--skill`-like explicit provision still works; `--add-dir` skills still load.
- `--setting-sources <sources>` excludes source `project` etc — can suppress project skills/commands/agents — **observed** `--help`.
- Settings: `disableBundledSkills: true` in any `settings.json` (Any file scope) removes bundled skills/workflows; `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` env equivalent — **documented** [scratchpad/cc-settings-reference.md: disableBundledSkills]. `disableSkillShellExecution` only disables inline `` !` `` execution, not discovery.
- No documented "disable all non-bundled skills" flag except the above.

### 6. Per-run allowlist

- No dedicated `--skills` allowlist flag. **Observed** `claude --help` shows `--allowedTools` / `--disallowedTools` which gate **tools**, not skills.
- Whether `Skill` is a tool name gateable by `permissions` / `--allowedTools`: **Unverified / effectively no.** Docs show skills invoke via `/skill-name` (slash command) and via model-driven `Read` of `SKILL.md`; the `Skill` tool name appears in some internal docs but `cc-permissions.md` and `cc-settings.md` do not list `Skill` in `permissions.allow/deny` examples, and `cc-cli-reference.md --tools` says "MCP tools" vs built-in tools without enumerating `Skill`. The `allowed-tools` frontmatter field inside a skill scopes tools **after** the skill runs, not a global gate. Conclusion: there is no documented single-tool `Skill` that a permission rule can deny to block all skills, nor a per-skill allowlist via `permissions` matching `/skill-name`. Best available is `skillOverrides` per skill.
- `skillOverrides` — object mapping skill name → `"on" | "name-only" | "user-invocable-only" | "off"` — writes to `.claude/settings.local.json` via `/skills` menu — **documented** [scratchpad/cc-settings-reference.md: skillOverrides]. `"off"` hides from model and autocomplete; `"user-invocable-only"` hides from model but keeps `/name` typable; `"name-only"` strips description. Applies only to non-plugin skills; plugin skills managed via `/plugin`.
- `disable-model-invocation: true` frontmatter per skill — prevents model from auto-loading; still user-invocable — **documented** [scratchpad/cc-skills.md: frontmatter reference].
- `paths:` frontmatter per skill — limits auto-activation to matching file globs — **documented** [scratchpad/cc-skills.md: paths].
- No documented `--skills` allowlist that enumerates enabled skills for one run only; `--plugin-dir` / `--plugin-url` can additive-load a plugin's skills for one session but not subtractive-filter.

### 7. Headless mode (`claude -p` / `--print`)

- Headless **does** load skills by default — **documented** [scratchpad/cc-headless.md]: "`claude -p` loads the same context an interactive session would, including anything configured in the working directory or `~/.claude`." Explicit note: "User-invoked skills and custom commands work in `-p` mode: include `/skill-name` in the prompt string and Claude Code expands it before running."
- Behavioral differences vs interactive:
  - Trust dialog is skipped when Claude runs non-interactively (via `-p` or stdout not a TTY) — "Only use this in directories you trust. Settings files that fail validation are silently ignored" — **documented** [scratchpad/cc-cli-reference.md: -p --print description + scratchpad/cc-headless.md].
  - Synced skills require non-interactive sync: `CLAUDE_CODE_SYNC_SKILLS=1 claude -p "…"` downloads to `~/.claude/skills/synced/` — interactive loads them after that — **documented** [scratchpad/cc-skills.md: Where synced skills load].
  - Bare: `claude --bare -p` skips discovery as above, but still allows `--add-dir` skills. **Documented** above.
  - `CLAUDE_CODE_SIMPLE=1` env set by `--bare`; `CLAUDE_CODE_SAFE_MODE=1` by `--safe-mode` — **observed** `--help` descriptions.
- Knobs above behave **same** in headless, except that `--bare` is the recommended headless posture and will become default for `-p` in a future release — **documented** [scratchpad/cc-headless.md note box].

### 8. Settings-file keys

From [scratchpad/cc-settings-reference.md] — **documented** (all under `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, or managed `managed-settings.json`; types as in file):

- `disableBundledSkills: boolean` — Scope Any file.
- `disableSkillShellExecution: boolean` — Scope Any file (managed true cannot be overridden).
- `skillOverrides: object<string, "on"|"name-only"|"user-invocable-only"|"off">` — Scope Any file; `/skills` writes to Local.
- `syncClaudeAiSkills: boolean` (false only) — Scope User, local, or managed.
- `allowedChannelPlugins`, `blockedMarketplaces` etc — not skill discovery but adjacent.
- Per-skill frontmatter keys consumed at load: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility` — **documented** [scratchpad/cc-skills.md: Frontmatter reference].
- Env keys: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`, `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`, `DISABLE_DOCTOR_COMMAND`, `CLAUDE_CODE_SYNC_SKILLS`, `CLAUDE_CODE_SYNC_SKILLS_WAIT_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` etc — full list in [scratchpad/cc-env-vars.md].

---

## 2. codex (OpenAI Codex CLI 0.147.0)

### 1. Skill search roots (precedence documented; source order matters)

Primary doc [scratchpad/cx-skills.md: Where Codex loads local skills] — **documented** table; code-confirmed in [scratchpad/codex-src/cx-src-host_roots.rs: roots_from_layer_stack + repo_agents_skill_roots + resolve_skill_roots] and [scratchpad/codex-src/cx-src-discovery.rs] — **documented**:

| Order (from `resolve_skill_roots`) | Path | Scope | Source citation |
|---|---|---|---|
| Project workdir-ancestor chain (top → bottom) | `<project_root>/.agents/skills` and each ancestor `.agents/skills` up to `CWD/.agents/skills` (only dirs that stat as directory are included; walk `MAX_SCAN_DEPTH`, `MAX_SKILLS_DIRS_PER_ROOT`, skips hidden dirs, follows directory symlinks) | `REPO` | `cx-skills.md` table + `host_roots.rs: repo_agents_skill_roots` dirs_between_project_root_and_cwd loop |
| User legacy | `$CODEX_HOME/skills` (deprecated, kept for compat) | `USER` | `host_roots.rs: roots_from_layer_stack` User -> `config_folder.join(SKILLS_DIR_NAME)` comment "Deprecated user skills location (`$CODEX_HOME/skills`)" |
| User cross-harness | `$HOME/.agents/skills` | `USER` | `host_roots.rs` `home_dir.join(AGENTS_DIR_NAME).join(SKILLS_DIR_NAME)` + `cx-skills.md` USER row |
| System bundled | `system_cache_root_dir(&config_folder)` — bundled with Codex (displayed as SYSTEM) | `SYSTEM` | `host_roots.rs` system_cache_root_dir + `SkillsConfig.bundled.enabled` |
| System admin | `/etc/codex/skills` | `ADMIN` | `cx-skills.md` ADMIN row + `host_roots.rs` System layer path (note: `cx-skills.md` lists ADMIN path as `/etc/codex/skills` under System scope; code uses `ConfigLayerSource::System` path) |
| Config-layer project | per-layer `config_folder/skills` where layer source is `Project` (i.e. `<repo>/.codex/skills` or ancestor `.codex/skills` resolved via config layer stack) | `REPO` | `host_roots.rs` Project branch inside `roots_from_layer_stack` |
| Plugin roots | `PluginSkillRoot.path` via `plugin_skill_roots` vector | `User` (forced) | `host_roots.rs` `plugin_skill_roots` loop |
| Extra roots | `--add-dir` / API `extra_skill_roots` | `User` | `host_roots.rs` `extra_skill_roots` loop |

Notes:
- `project_root` is discovered by walking CWD ancestors looking for `project_root_markers` (default `.git`); if none found, CWD is project root — **documented** [scratchpad/cx-config-advanced.md: Project root detection] + [scratchpad/codex-src/cx-src-host_roots.rs: find_project_root].
- Within repo roots, Codex probes every directory from project root to CWD inclusive; only those where `.agents/skills` exists as directory become roots. Earlier code used to check `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills` (docs table lists those three illustrative examples; real code probes all ancestors).
- Discovery per root: walk truncated at `MAX_SKILLS_DIRS_PER_ROOT` / `MAX_SKILLS_ENTRIES_PER_ROOT`; hidden directories (dot-prefixed below root) skipped; directory symlinks **followed** for USER/REPO/ADMIN scopes, **ignored** for SYSTEM — [scratchpad/cx-src-host.rs: directory_symlinks match] — **documented** via source.
- Skills are directories containing `SKILL.md`; file at `$path/SKILL.md` discovered; symlinked skill folders followed — **documented** `cx-skills.md` "Codex supports symlinked skill folders".
- Name collision: project-level overrides user-level by precedence; within same scope both appear but selectors disambiguate — [scratchpad/cx-skills.md: If two skills share the same name, Codex doesn't merge them; both can appear].
- **Reads `~/.agents/skills`? Yes** — explicitly listed as `USER` row and in code `home_dir/.agents/skills`. **Reads `.agents/skills`? Yes** — every ancestor including CWD and repo root.

### 2. Instruction files

`AGENTS.md` (and `AGENTS.override.md`) — **documented** [scratchpad/cx-guides_agents-md.md]:

- Global: `$CODEX_HOME/AGENTS.override.md` if non-empty else `$CODEX_HOME/AGENTS.md` — only first non-empty at this level.
- Project: from project root (walk `project_root_markers` = `.git` by default; fallback names configurable) down to CWD, in each directory checks `AGENTS.override.md` → `AGENTS.md` → fallback names in `project_doc_fallback_filenames` — at most one file per directory, concatenated root→CWD with blank line join; deeper files override earlier (appear later in combined prompt). Empty files skipped; truncate at `project_doc_max_bytes` (default 32 KiB).
- Fallback filenames: configurable via `project_doc_fallback_filenames` in `~/.codex/config.toml` (e.g. `TEAM_GUIDE.md`, `.agents.md`).
- Verified via `codex --ask-for-approval never "Summarize the current instructions."` etc.

### 3. Config/home directory variable

`CODEX_HOME` — **documented** [scratchpad/cx-config-advanced.md: Config and state locations] and [scratchpad/cx-guides_agents-md.md: use CODEX_HOME]:

- Quote: "Codex stores its local state under `CODEX_HOME` (defaults to `~/.codex`)."
- Quote: "Set the `CODEX_HOME` environment variable when you want a different profile, such as a project-specific automation user: `CODEX_HOME=$(pwd)/.codex codex exec …`"
- Relocates: `config.toml`, per-profile `profile-name.config.toml` (`$CODEX_HOME/profile-name.config.toml` selected via `--profile`), `auth.json` (if file storage) or keychain fallback, `history.jsonl` (when `history_persistence` on), `log/` via `log_dir` default `$CODEX_HOME/log` and caches. Full set: "Common files you may see there: config.toml, auth.json, history.jsonl, Other per-user state such as logs and caches" — **documented** same file.

What exactly it relocates: **all user-level state**: config, credentials (file backend), history, logs, and the legacy `$CODEX_HOME/skills` location plus the config-layer resolution for user/systems skills. It does NOT relocate project `.agents/skills` or repo `.codex/config.toml` layers (those are repo-relative) — but it does control which `AGENTS.md` global file is loaded and which `config.toml` overrides global defaults.

Effect on skill discovery when set: user/legacy/system skill roots resolve under the new home; admin `/etc/codex/skills` unchanged; repo roots unchanged. **Documented** behavior: pointing `CODEX_HOME` at a different directory makes `~/.agents/skills` still resolve via `HOME` independently — so a temporary `CODEX_HOME` alone does not hide `~/.agents/skills`.

### 4. HOME relocation

Plain `HOME` relocation **does affect discovery** because one root is derived from `dirs::home_dir()` → `$HOME/.agents/skills` — **observed** [scratchpad/codex-src/cx-src-host_roots.rs: `home_dir().and_then(...).join(AGENTS_DIR_NAME).join(SKILLS_DIR_NAME)`] — **documented** also via docs table `USER $HOME/.agents/skills`. Moving `HOME` therefore stages a clean user skills directory without needing `CODEX_HOME`.

What else breaks when HOME moves — **documented / source-based**:

- Credentials: Codex uses either `auth.json` under `CODEX_HOME` **or** OS keychain/keyring — per [scratchpad/cx-config-advanced.md: Common files ... auth.json (if you use file-based credential storage) or your OS keychain/keyring]. If `CODEX_HOME` not overridden, `CODEX_HOME` defaults to `~/.codex` which itself derives from `HOME` on most platforms (`dirs::home_dir()`). Separate from that, if configured for keychain, keychain reads are keyed by service name, not HOME path, so they may still authenticate but file-based auth moves.
- OAuth tokens: same as credentials.
- Session storage: history/log location `$CODEX_HOME/history.jsonl`, `$CODEX_HOME/log/` moves with HOME if CODEX_HOME not set.
- Other breakage: project root detection falls back to `home_dir()` for nothing else; but `HOME` move also affects `~/.codex/config.toml` discovery, so a blank temporary HOME yields a Codex with no user config unless `CODEX_HOME` is pinned.
- No explicit "keychain read" failure note for HOME move in docs; docs instead warn about profile confusion (`echo $CODEX_HOME`).

Viability: **Highly viable** — Codex docs explicitly suggest `CODEX_HOME=$(pwd)/.codex codex exec …` as the project-scoped automation pattern; similarly `HOME=$(mktemp -d) CODEX_HOME=$HOME/.codex` staging a temporary HOME empties both the legacy `$CODEX_HOME/skills` and `$HOME/.agents/skills`. The only skills that survive are project `.agents/skills` and `/etc/codex/skills`. For full isolation the caller should set **both** `HOME` and `CODEX_HOME` to the staged directory, or set `HOME` and rely on `CODEX_HOME` defaulting under it.

### 5. Flags/settings that turn skill discovery OFF entirely

- `--ignore-user-config` — "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`" — **observed** `codex exec --help`, **documented** [scratchpad/cx-noninteractive.md: Permissions]. This suppresses user config-layer skill roots (user legacy + system) but **does not suppress** repo `.agents/skills` — those still load.
- No observed `--disable-skills` / `--no-skills` flag. `codex --help` / `codex exec --help` do not list a skills-off flag — **observed** (absent from help dumps 2026-08-22).
- Settings: `skills.bundled.enabled = false` via `~/.codex/config.toml` disables bundled SkillsConfig — **documented** via source [scratchpad/cx-src-skills_config.rs: BundledSkillsConfig.enabled] and [scratchpad/cx-config-reference.md: skills.config...]. Setting `"skills.bundled"` under `SkillsExtensionConfig.bundled_skills_enabled` — **documented** [scratchpad/cx-src-config.rs].
- Also `skills.include_instructions = false` — "Whether turns receive the automatic skills instructions block" — can suppress catalog injection without disabling discovery — **observed** `SkillsConfig.include_instructions` source.
- No global "disable all skills" boolean in `config.toml` beyond disabling each entry via `[[skills.config]] enabled=false` per path or disabling bundled — see next section.
- Project untrusted gate: project-local skills/config layers load only when project is trusted — **documented** [scratchpad/cx-config-advanced.md: Project config files ... Codex loads project-scoped config files only when the project is trusted]. So an untrusted checkout implicitly disables repo skills.

### 6. Per-run allowlist

- `[[skills.config]]` entries in `~/.codex/config.toml` — **documented** [scratchpad/cx-skills.md: Enable or disable local Codex skills] and [scratchpad/cx-config-reference.md: skills.config]:
  ```toml
  [[skills.config]]
  path = "/path/to/skill/SKILL.md"
  enabled = false
  ```
  Selector can be `path` or `name` per [scratchpad/cx-src-skills_config.rs: SkillConfig { path, name, enabled }]. Exact match on path or name. Not per-run except via `-c skills.config…` override (see below).

- `-c` / `--config <key=value>` — **observed** `codex --help` and `codex exec --help`: `Override a configuration value that would otherwise be loaded from config.toml. Use a dotted path. The value portion is parsed as TOML.` This is the per-run allowlist mechanism: `codex exec -c 'skills.config=[{path="/repo/.agents/skills/my-skill/SKILL.md", enabled=false}]'` or `codex -c skills.bundled.enabled=false …`. Profile overlay `--profile` also layers `$CODEX_HOME/<name>.config.toml` per run — **documented**.

- Permission-style gating: **Unverified / no.** `Skill` is not a tool name exposed in Codex permissions docs; permissions gate `Bash`, `Edit`, etc. Skills are disclosed via the skills catalog (up to 8000 chars / 2% context — **documented** [scratchpad/cx-skills.md: Skills use progressive disclosure ... initial list uses at most 2% or 8000 chars]) and then file-read; there is no `Skill` tool to deny. The earlier `skill` mention selector `$skill` is UI, not a tool-permission. No source shows `Tool: Skill` permission rule that can name one skill.

- `SkillPolicy` / `allow_implicit_invocation: false` via optional `agents/openai.yaml` metadata — **documented** [scratchpad/cx-skills.md: Optional metadata]: `policy.allow_implicit_invocation` defaults true; when false, Codex won't implicitly invoke based on prompt (explicit `$skill` still works). Not a permission deny but a per-skill opt-out of implicit use.

### 7. Headless mode (`codex exec`)

- **Does load skills.** `codex exec` is non-interactive but still discovers skills via same `resolve_skill_roots` path — no headless-specific branch that disables skills exists in source snippets. Docs treat `codex exec` as same as TUI for discovery — **documented** via absence of any "headless disables skills" note and via examples like `codex exec --profile deep-review "review this change"` (which would include skills).

- Behavioral differences:
  - Default sandbox is `read-only` for `codex exec` vs TUI interactive; allow edits via `--sandbox workspace-write` — **documented** [scratchpad/cx-noninteractive.md: Permissions and safety].
  - Headless has no workspace-trust UI; project `.codex/config.toml` layers still gated on trust — behavior **same** as TUI (trust persisted flag still checked).
  - No separate `bare` or `safe-mode` concept that suppresses skills headless-only.
  - Ephemeral runs: `codex exec --ephemeral` avoids persisting rollout files but does not skip skills — **observed** `--help`.

- Knobs behave **same** in headless: `-c`, `--profile`, `--ignore-user-config`, `--ignore-rules`, `CODEX_HOME` all work in `exec` (explicitly listed under `codex exec --help` Options). Verified: `codex exec --help` repeats `-c`, `--profile`, `--ignore-user-config`, `--ignore-rules` — **observed**.

### 8. Settings-file keys

From [scratchpad/cx-src-skills_config.rs + scratchpad/cx-config-reference.md] — **documented**:

- `skills.bundled.enabled: boolean` (default true) — TOML `skills.bundled.enabled`.
- `skills.include_instructions: boolean` — whether turns receive automatic skills instructions block.
- `skills.config: array<object>` — list of overrides.
- `skills.config[].path: string (AbsolutePathBuf)` — path to `SKILL.md` folder/file.
- `skills.config[].name: string` — name-based selector.
- `skills.config[].enabled: boolean` — enable/disable that entry.
- Env / CLI: `CODEX_HOME: string` (env, not a config.toml key but a layer selector), `-c <key=value>` dotted-path overrides, `-p/--profile <name>` selects `$CODEX_HOME/<name>.config.toml`, `--ignore-user-config`, `--ignore-rules`.
- Related: `project_root_markers: string[]`, `project_doc_max_bytes`, `project_doc_fallback_filenames` (instruction file discovery) — **documented** [scratchpad/cx-config-advanced.md].

---

## 3. pi (pi coding agent 0.84.2)

### 1. Skill search roots (precedence order relevant to caller)

Docs [installed package: @earendil-works/pi-coding-agent/docs/skills.md: Locations; @earendil-works/pi-coding-agent/dist/core/skills.js + skills.d.ts] — **documented** + **observed** (package source):

Load order inside `loadSkills({ cwd, agentDir, skillPaths, includeDefaults })` — **observed** via `dist/core/skills.js: loadSkills`:

1. Global:
   - `~/.pi/agent/skills/` — direct root `.md` files discovered as individual skills + directories containing `SKILL.md` discovered recursively.
   - `~/.agents/skills/` — only directories containing `SKILL.md` discovered recursively; root `.md` files **ignored** in this location.
2. Project (only after project is trusted — see §4):
   - `.pi/skills/` under CWD — same discovery rules as global `.pi/agent/skills/` (root `.md` + recursive `SKILL.md`).
   - `.agents/skills/` in `CWD` and ancestor directories up to git repo root (or filesystem root when not in a repo) — recursive `SKILL.md` discovery; root `.md` ignored. Implemented via `walk` with GitIgnore respect (`.gitignore`, `.ignore`, `.fdignore`), hidden-dot dirs skipped, `node_modules` skipped, max depth implicit via recursion.
3. Packages — `skills/` directories or `pi.skills` entries in `package.json` — `skills/` recursively finds `SKILL.md` folders plus top-level `.md` files — **documented** [docs/packages.md: Convention Directories] + `settingsManager` package handling.
4. Settings `skills` array — explicit file or directory paths — additive — **documented** via `settings.md: Resources`.
5. CLI `--skill <path>` — repeatable, additive even with `--no-skills` — **observed** `pi --help` (`--skill <path>   Load a skill file or directory …`) and **documented** [docs/skills.md: CLI].

**Reads `~/.agents/skills` and `.agents/skills`? Yes — both** — **documented** locations bullet lists `~/.agents/skills/` and `.agents/skills/` in cwd + ancestors. Code confirms via `loadSkills` joining `~/.pi/agent/skills` and `.agents/skills` paths.

Precision notes:
- `~/.pi/agent/skills/` and `.pi/skills/` are the **native** locations where a lone `foo.md` at root counts as a skill; in `~/.agents/skills/` and project `.agents/skills/`, only `SKILL.md` directories count — **documented** "Discovery rules" bullets.
- Symlinks to skill directories are followed (`statSync` + `isDirectory` check) — **observed** `loadSkillsFromDirInternal` symlink handling.
- Collision: same `name` keeps first-found, logs warning — **observed** `loadSkills` collisionDiagnostics: `skillMap.has(name)` retains first.

### 2. Instruction files

`AGENTS.md` and `CLAUDE.md` (alias called "context files") — **documented** [docs/quickstart.md: Give pi project instructions — Pi loads: `~/.pi/agent/AGENTS.md` for global instructions] and `dist/config.js` constants plus `--no-context-files`:

- Global: `~/.pi/agent/AGENTS.md`
- Project: `.pi/AGENTS.md`? Actually pi loads `AGENTS.md` and `CLAUDE.md` discovery via `--no-context-files` flag description: "Disable AGENTS.md and CLAUDE.md discovery and loading" — **observed** `pi --help`. Docs state project loads context files at startup. Additional nuance: `.pi/AGENTS.md` is under the same `.pi` dir handling as skills (needs trust).
- No per-directory ancestor chain documented beyond skills; instruction file discovery likely mirrors skill ancestor but docs only state cwd file. Treat as **unverified** for multi-level project `AGENTS.md` chain; pi docs do not enumerate it.

Disable via `--no-context-files` — **observed** `pi --help`.

### 3. Config/home directory variable

`PI_CODING_AGENT_DIR` — **documented** [installed package: `pi --help` Environment Variables section; `dist/config.js: ENV_AGENT_DIR = ${APP_NAME}_CODING_AGENT_DIR` and `getAgentDir()`]:

```js
export function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR]; // PI_CODING_AGENT_DIR
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), CONFIG_DIR_NAME, "agent"); // ~/.pi/agent
}
```

Default `~/.pi/agent` — **observed** `dist/config.js: 412-417`.

What it relocates: **all global state** — `settings.json` (`~/.pi/agent/settings.json`), `auth.json`, `tools/`, `bin/`, `prompts/`, `sessions/` (`getSessionsDir()`), `models.json`, `extensions/`, `skills/`, global `AGENTS.md` — essentially everything under `~/.pi/agent`. Source: `getSettingsPath()`, `getAuthPath()`, `getSessionsDir()` all `join(getAgentDir(), …)` — **observed**.

Related: `PI_CODING_AGENT_SESSION_DIR` (alias `PI_CODING_AGENT_SESSION_DIR`) — overrides only session storage directory — **observed** `pi --help` + `dist/config.js: ENV_SESSION_DIR` + `settings.md: sessionDir precedence --session-dir > PI_CODING_AGENT_SESSION_DIR > sessionDir in settings.json`.

Effect on skill discovery when set: global skill root switches from `~/.pi/agent/skills/` to `$PI_CODING_AGENT_DIR/skills/`; user cross-harness `~/.agents/skills/` is **unaffected** (still derived from HOME). Project `.pi/skills/` and `.agents/skills/` are also unaffected (cwd-relative). So staging `PI_CODING_AGENT_DIR` alone does NOT hide `~/.agents/skills`.

Additional package/config variants via `${APP_NAME}`: if `piConfig.name`/`configDir` overridden in package.json, env var name changes — not relevant for default `pi`.

### 4. HOME relocation

Plain `HOME` relocation **partially** achieves isolation — **documented + observed**:

- Default `getAgentDir()` falls back to `join(homedir(), ".pi", "agent")` — `homedir()` is `os.homedir()` which honors `HOME` on POSIX — so moving HOME moves the global skills dir unless `PI_CODING_AGENT_DIR` overrides it.
- The cross-harness `~/.agents/skills/` root also derives from `homedir()` (via `~`/`homedir` resolution in settings and skills loader) — so moving HOME hides that cross-harness population and replaces it with an empty one.
- Project skills (`.agents/skills`, `.pi/skills`) are cwd-relative and unaffected by HOME — require separate `--no-skills` or untrusted-project gating.
- What else breaks when HOME moves — **documented / observed**:
  - Credentials: `auth.json` at `~/.pi/agent/auth.json` moves; OAuth bearer tokens stored there move. Substrate for API keys via `ANTHROPIC_API_KEY`, etc. env vars unaffected but `auth.json` not found yields "not logged in" unless env keys provided. Keychain not used (pi authenticates via `auth.json` and `apiKeyHelper`-like tooling, not system Keychain — no Keychain doc mention).
  - OAuth tokens: same `auth.json`.
  - Session storage: `~/.pi/agent/sessions/` moves; if `PI_CODING_AGENT_SESSION_DIR` set, session dir is independent of HOME.
  - Other: npm packages under `~/.pi/agent/npm/`, `~/.pi/agent/git/`, themes, prompts, custom tools — all move.
  - No documented "credentials in Keychain on macOS" caveat like Claude Code; pi's credential source is file-centric.

Viability: **viable with one extra flag.** Staging `HOME=$(mktemp -d)` alone hides both global locations (`~/.pi/agent/skills` and `~/.agents/skills`) but leaves project skills visible — caller who wants truly empty skill set must also pass `--no-skills` (or ensure project has no `.agents/skills`). Conversely, to isolate only `~/.pi/agent` without touching HOME's other files, staging `PI_CODING_AGENT_DIR=$(mktemp -d)/pi-agent` is the surgical knob; but caller who stages temporary HOME does not need per-skill allowlist.

### 5. Flags/settings that turn skill discovery OFF entirely

- `--no-skills`, `-ns` — "Disable skills discovery and loading" — **observed** `pi --help` (`--no-skills, -ns   Disable skills discovery and loading`). Explicit `--skill <path>` still additive even with `--no-skills` — **documented** [docs/skills.md: Disable discovery with --no-skills (explicit --skill paths still load)].
- `--no-context-files`, `-nc` — disables AGENTS.md/CLAUDE.md discovery (instruction files, not skills themselves) — **observed**.
- `--no-extensions`, `--no-prompt-templates` — adjacent but not skills.
- Settings `skills?: string[]` / `prompts` / `extensions` can be empty to avoid loading extra paths — but `includeDefaults` still loads native dirs unless `--no-skills` used. No `disableBundledSkills`-style settings toggle that removes bundled skills; pi's bundled concept is via `skills/` in its own package `skills/` convention directory but not gated.
- `--approve` vs `--no-approve` indirectly disables project skills by marking project untrusted (see next).
- Trust gate: when project not trusted, project skills (`.pi/skills/`, `.agents/skills/`) not loaded (see §7).

### 6. Per-run allowlist

- `--skill <path>` — repeatable additive explicit skill file/directory — **observed** `pi --help` (`--skill <path>   Load a skill file or directory (can be used multiple times)`). Use together with `--no-skills` to get "only these skills": `pi --no-skills --skill ./my-skill --skill ./other-skill` — pattern explicitly documented: "additive even with --no-skills" — **documented** [docs/skills.md].
- `--tools`, `-t <tools>` / `--exclude-tools`, `-xt <tools>` / `--no-tools`, `--no-builtin-tools` — gate **tools**, not skills — **observed** `pi --help` `Built-in Tool Names: read, bash, edit, write …`.
- No named-per-skill permission rule like `Skill:my-skill` deny — skill activation is via `read` tool loading `SKILL.md` plus `/skill:name` slash command; there is no `Skill` tool to deny; `--tools` filtering does not name skills. The only per-skill gate is frontmatter `disable-model-invocation: true` (hidden from system prompt; explicit `/skill:name` still works) — **documented** [docs/skills.md: Frontmatter disable-model-invocation].
- `--extension`, `-e <path>` + `--no-extensions` similar for extensions but not skills.
- Settings `skills: [ ... ]` array in `~/.pi/agent/settings.json` or `.pi/settings.json` acts as persistent allowlist/addition; with programmatic session manager `SettingsManager` — but per-run allowlist is via CLI flags above, not settings file.
- Authorship: caller can select a subset for one run via `--no-skills --skill` pattern — **legitimate per-run allowlist**.

### 7. Headless mode (`pi -p` / `--print`, `--mode json|rpc`)

- Headless **does** load skills, but **trust-gated**. Global skills (`~/.pi/agent/skills`, `~/.agents/skills`) load always; project skills (`.pi/skills/`, `.agents/skills` under cwd/ancestors) load **only if project is trusted**. Interactive startup prompts trust; non-interactive modes do **not** show trust prompt and fall back to `defaultProjectTrust` setting (`ask` default and `never` → ignore project resources; `always` → trust) or one-run override `--approve` / `--no-approve` — **documented** [docs/settings.md: Project Trust section].

  > "Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run."

- Skill availability in headless with default `ask` therefore **differs** from interactive: interactive would prompt and potentially load project skills; headless with default silently skips them. This is the biggest headless divergence among all harnesses — **documented**.

- Knobs behave differently:
  - `--no-skills`, `--skill`, `--no-context-files`, `--approve/--no-approve` all apply in headless — **observed** `pi --help` options list not mode-conditioned.
  - `PI_CODING_AGENT_DIR` + `PI_OFFLINE=1` etc also apply.

### 8. Settings-file keys

From [installed package: docs/settings.md + dist/core/settings-manager.d.ts + dist/core/skills.d.ts] — **documented/observed**:

- `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project; requires trust). `settings.json` must be valid JSON (no `schema_version` requirement like Muse).
- Keys bearing on skills/context:
  - `skills: string[]` — local skill file/dir paths or directories — **documented** [docs/settings.md: Resources | Setting | Type | `skills`].
  - `extensions: string[]`, `prompts: string[]`, `themes: string[]`, `enableSkillCommands: boolean` (= `true` registers `/skill:name` commands) — **documented**.
  - `packages: PackageSource[] | string[]` — `pi.skills` entries via npm/git packages — **documented** [docs/packages.md].
  - `defaultProjectTrust: "ask"|"always"|"never"` — controls headless project skill loading — **documented**.
  - `sessionDir: string`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` — env-overridable locations — **observed**.
  - Per-skill frontmatter (strict to spec + lenient beyond): `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` — **documented** [docs/skills.md: Frontmatter].
  - Negation: no `disableBundledSkills` equivalent.

---

## 4. muse (Muse Code 0.2.1)

### 1. Skill search roots (precedence documented)

From [scratchpad/muse-extending.html: Skills — Skills load from three sources] — **documented**; flags from `muse skills --help` — **observed**:

1. **Built-in** — skills that ship with Muse Code — not filesystem path; enumerated via `muse skills list --source built-in`.
2. **User** — `$XDG_CONFIG_HOME/muse/skills` (and `~/.agents/skills`) — text: "your account-wide skills, in `$XDG_CONFIG_HOME/muse/skills` (and `~/.agents/skills`), available in every project." — **documented**.
3. **Project** — `<repo>/.agents/skills/<skill-id>/SKILL.md` — "skills committed to a repo under `<repo>/.agents/skills/<skill-id>/SKILL.md`, shared with anyone who clones it. Muse Code also scans repo-local `.codex/skills` and `.claude/skills`." — therefore project roots are:
   - `.agents/skills` (primary)
   - `.codex/skills` (compat)
   - `.claude/skills` (compat)
   — all repo-relative. Docs say walks from workspace root up to nearest `.git` boundary (same as instruction files).
4. **Plugin** — plugin registry skills — via `muse skills list --source plugin` — not a plain filesystem path but a managed registry on top of the same storage.

Order: not explicitly stated as priority number, but `muse skills inspect` source flag and enable/disable scoping suggest **project overrides user** analogous to instruction file rule ("Project rules win over user rules") — **documented** for instructions; for skills the manage/list ordering implies same, but not verbatim.

Trust caveat (see §7): project skills are **policy-gated** workspace tools at a path; they load only after you trust the workspace (see `muse-configuration.html: Project rules load only after you trust the workspace`; `muse-extending.html: skills via trust`). The same text applies to `.codex/skills`, `.claude/skills` branches.

**Reads `~/.agents/skills`? Yes** — explicitly listed as "(and `~/.agents/skills`)" alongside `$XDG_CONFIG_HOME/muse/skills`. **Reads `.agents/skills`? Yes** — primary project location `<repo>/.agents/skills/<skill-id>/SKILL.md`.

### 2. Instruction files

`AGENTS.md` with `CLAUDE.md` fallback — **documented** [scratchpad/muse-configuration.html: How Muse Code loads instruction files]:

- "From your workspace root, Muse Code walks up to the nearest `.git` boundary. It loads one instruction file per directory level, and prefers `AGENTS.md` over `CLAUDE.md` when both exist."
- Precedence when guidance conflicts: "Project rules win over user rules. Among project files, the deeper file wins over a shallower one."
- "Your machine-wide user rules always load. Project rules load only after you trust the workspace. On an untrusted checkout, Muse Code ignores project `AGENTS.md` and `CLAUDE.md` until you trust it."
- Local memory `MEMORY.md` variant separate, but instruction files are `AGENTS.md`/`CLAUDE.md` only; no `.claude/rules/` equivalent.
- Project instructions seeded via `muse init` into `AGENTS.md`.

`--workspace <path>` flag: roots policy-gated workspace tools at alternative path — likely changes root used for instruction file walk — **observed** `muse --help`.

### 3. Config/home directory variable

No dedicated `MUSE_CONFIG_DIR` env var — **documented as silent**. Docs list only `XDG_CONFIG_HOME`-derived path and fixed `~/.config/muse/settings.json`.

- Settings file path — **documented** [scratchpad/muse-configuration.html: The settings file]: "User settings live at `~/.config/muse/settings.json`. The file holds: model defaults ... schema_version must be 1". This is implicitly `$XDG_CONFIG_HOME/muse/settings.json` when `XDG_CONFIG_HOME` is set, else `~/.config/...`, per XDG Base Directory Spec. Docs enumerate alternative as `$XDG_CONFIG_HOME/muse/skills` — so `XDG_CONFIG_HOME` **is** the relocating variable for both user settings and user skills.

What it relocates: **user state** — settings JSON (`settings.json`), user skills (`muse/skills`), and by convention `agent` memory. It does NOT relocate project `.agents/skills` or `.codex/skills` / `.claude/skills` (repo-relative) nor built-in skills.

Effect on skill discovery when set: `XDG_CONFIG_HOME=/tmp/stage` moves user skills from `~/.config/muse/skills` to `/tmp/stage/muse/skills` and also moves user instruction files if any; but `~/.agents/skills` is **independent** of `XDG_CONFIG_HOME` — documented as alternative user path "(and `~/.agents/skills`)". So staging only `XDG_CONFIG_HOME` does not hide `~/.agents/skills`.

There is no `PI_CODING_AGENT_DIR`-like monolithic relocator for all state including sessions/logs; session logs live elsewhere (likely under cache). No env var akin to `CODEX_HOME`/`CLAUDE_CONFIG_DIR` that collapses everything was found in help or docs — **unverified** after search (docs not exposing one; `muse --help` shows no `--config-dir` flag).

### 4. HOME relocation

Plain `HOME` relocation **is viable** for `~/.agents/skills` and for `~/.config` when `XDG_CONFIG_HOME` not set (since `XDG_CONFIG_HOME` defaults to `$HOME/.config`). Moving HOME therefore:

- Moves `~/.config/muse/settings.json` (if `XDG_CONFIG_HOME` unset or derived from HOME) — **inferred from XDG spec**, not explicitly documented in muse docs but documented that user settings live at `~/.config/muse/...` implies HOME-derived.
- Moves `~/.agents/skills` user skills — **documented** as user path alternative.
- Does NOT move repo `.agents/skills` (project-relative) — still visible.
- Project skills remain gated on trust regardless.

What else breaks when HOME moves — **documented / expected**:

- Credentials / OAuth tokens: Muse Code docs mention authentication via provider API credentials stored per provider docs but not where file lives; expected at `~/.config/muse` or cache; moving HOME would relocate file-backed credentials if they reside under HOME. No Keychain vs file distinction documented; docs say settings must include `"schema_version": 1` else every command fails — moving HOME to empty temp yields defaults (valid because missing file is fine) but loses provider auth — requires re-auth via `muse auth`/`muse login`. Not explicitly documented as breaking.
- Session storage: transcript/session logs not documented; likely under platform cache, not HOME move sensitive.
- Trust decisions: workspace trust remembers per workspace root — stored under user config location, so moving HOME clears trust database, causing untrusted checkout to block project skills until re-trusted or `--trust-workspace` passed.

Viability: **Viable but requires both `HOME` and optionally `XDG_CONFIG_HOME`** to be set together for completeness. The single `XDG_CONFIG_HOME` surgical knob is more precise than a full HOME move; a caller who can stage a temporary HOME does not need a per-skill allowlist for user skills, but project skills still survive unless workspace is left untrusted and not passed `--trust-workspace`.

### 5. Flags/settings that turn skill discovery OFF entirely

- No `--no-skills` or `--disable-skills` flag in `muse --help` — **observed** absent. But `muse exec` has `--no-foreign-personal-context` — **observed** [scratchpad/muse-configuration.html: Launch flags — Headless only (muse exec …): --no-foreign-personal-context Exclude foreign personal rules and skills from this run]. This suppresses foreign personal (user) skills in `exec`; not a full OFF.
- Workspace trust is the gate: project skills disabled when workspace not trusted and neither `--trust-workspace` nor `--yolo` passed — **documented** [scratchpad/muse-configuration.html: Project rules load only after you trust the workspace] + `muse-permissions.html`.
- `--yolo` implicitly enables project skills (trusts) rather than disabling.
- `--disable-approval`, `--disable-sandbox`, `--disable-write`, `--disable-shell` — constrain approvals/sandbox, not skill load — **observed**.
- Skill-level toggle: `muse skills disable <skill-id> --scope user|project|built-in|plugin` and `muse skills enable …`; also `muse skills user-only` — **observed** `muse skills --help`.
- No settings.json key documented that disables all skills at once; `enable-?` not found. The only disablement knobs are per-skill `disable` command or trust gate.
- For headless, `--no-session-log` does not affect skills.

### 6. Per-run allowlist

- No `--skill` path / `--skills` enumeration flag for one run — **observed** absent from `muse --help` and `muse exec --help`. The per-run skill surface is controlled via trust + `muse skills enable/disable` persisted state, not a flag.
- Whether `Skill` is a tool name gateable by tool permission: **Silent / unlikely.** Muse docs enumerate tools but not a `Skill` tool; slash commands like `/plan`, `/grilling` are built-in skills invoked via slash, not via a generic `Skill` tool permission. No docs show `permissions.allow/deny` or `XDG_CONFIG_HOME/muse/settings.json` permission rules naming `Skill:foo`. Therefore **no documented per-skill tool-permission deny**.

- Closest per-skill gating is persistent: `muse skills enable <id> --scope user|project|built-in|plugin` / `disable` / `user-only` — these write to scope storage and persist beyond the run — not per-run. For a true one-run subset the caller must invoke `disable` before and `enable` after, or rely on workspace partitioning (`--workspace <path>` with fewer skills committed).

- Observer / skill recall: a background observer surfaces a relevant project skill automatically (on by default; `observer-agents` toggles via `settings.json runtime_capabilities`) — but not an allowlist.

Conclusion: **No supported per-run allowlist that names one skill**. `muse skills disable` is persistent-state gating, not a one-run flag. Null result should be reported as absent source.

### 7. Headless mode (`muse exec`)

- **Does load skills** — but **trust-dependent**. Docs: "Project rules load only after you trust the workspace. On an untrusted checkout, Muse Code ignores project `AGENTS.md` and `CLAUDE.md` until you trust it." Same applies to skills. Headless invocation without `--trust-workspace` or `--yolo` on an untrusted checkout **will NOT load** project skills/memory/rules — project memory is the exception: "Muse Code reads committed project memory into the model's context even in an untrusted workspace. Skills, rules, and hooks differ: they load only after you trust it." — **documented** [scratchpad/muse-configuration.html: memory note box].

- `muse exec --trust-workspace` — "Trust this workspace for this run (load its skills and rules); does not save trust" — **observed** `muse exec --help`. `muse exec --yolo` also trusts plus disables guardrails.

- `muse exec --no-foreign-personal-context` — excludes foreign personal rules/skills (used to isolate from user skills when running on another user's repo) — **observed** `muse exec --help`. Implies by default headless **includes** foreign personal skills unless told not to.

- Headless-specific flags that affect skills: `--workspace <path>` changes the workspace root that skills resolve against; `--disable-write`, `--disable-shell` constrain what skills can do but not whether they load.

- So: **Interactive and headless both load skills, but headless defaults to untrusted (project skills hidden) unless `--trust-workspace`/`--yolo` supplied.** In interactive mode the UI prompts for trust once and remembers; in headless there is no prompt.

### 8. Settings-file keys

From [scratchpad/muse-configuration.html + muse-extending.html] — **documented**:

- `~/.config/muse/settings.json` (also `$XDG_CONFIG_HOME/muse/settings.json`) — must include `"schema_version": 1` else malformed — **documented**.
- Keys bearing on discovery/trust:
  - No `disableBundledSkills` / `skillOverrides` equivalent at per-skill granularity; instead `muse skills disable` manipulates scoped enablement out-of-band.
  - `runtime_capabilities` map toggling observer agents (`memory recall`, `skill recall`, `goal tracking` on by default; `verification` off) — influences **auto-skill recall** but not discovery roots.
  - Hooks: `hooks` block + `managed_hooks_path` pointer — not skills but adjacent.
  - `mcp_servers` block — not skills.
- CLI flags mapping to env not via settings file: `--trust-workspace`, `--yolo`, `--disable-approval`, `--disable-sandbox`, `--workspace`, `--no-foreign-personal-context` — **observed** `muse exec --help`.

---

## 5. agentskills.io cross-harness convention

### Specification ([agentskills.io/specification] fetched 2026-08-22 via `curl -sL https://agentskills.io/specification.md`)

**Status: documented** (primary source is spec markdown + client-implementation guide).

- Spec defines **directory structure**: a skill is a directory containing at minimum `SKILL.md`; optional `scripts/`, `references/`, `assets/` — **documented** [spec: Directory structure].
- Spec defines **frontmatter** fields: `name` (1–64 chars, lowercase a-z0-9 hyphen, no leading/trailing/consecutive hyphens, **must match parent directory name**), `description` (1–1024 chars), `license`, `compatibility` (≤500), `metadata` (map<string,string>), `allowed-tools` (space-separated) — **documented** [spec: Frontmatter table]. Spec mandates `name` matches parent dir — **documented** "Must match the parent directory name" under name field (pi explicitly relaxes this).
- Spec defines **SKILL.md body** as markdown with no format restrictions; progressive disclosure tiers 1–3 described in client guide but mentioned in spec as file references — **documented**.
- Spec **does NOT define search locations** ("where to scan"). The spec text says: "A skill is a directory containing, at minimum, a `SKILL.md` file" and validation examples — no mention of `~/.agents/skills` or `.agents/skills` or `$XDG_CONFIG_HOME/...`. The normative location list lives in the **client-implementation guide**, not the spec — **documented as silent in spec** (verified by absence in spec markdown; search for `.agents` yields 0 hits in spec).

### Client-implementation guide ([agentskills.io/client-implementation/adding-skills-support]) fetched 2026-08-22 via curl — **documented**:

- Recommended scan scopes: **project-level** (relative to working directory) and **user-level** (relative to home) — "Most locally-running agents scan at least two scopes: Project-level … User-level".
- Recommended paths: suggests scanning **both** client-native and cross-harness: table [Client-implementation: Where to scan]:

  | Scope | Path | Purpose |
  | Project | `<project>/.<your-client>/skills/` | Your client's native location |
  | Project | `<project>/.agents/skills/` | Cross-client interoperability |
  | User | `~/.<your-client>/skills/` | Your client's native location |
  | User | `~/.agents/skills/` | Cross-client interoperability |

  Quote: "The `.agents/skills/` paths have emerged as a widely-adopted convention for cross-client skill sharing. While the Agent Skills specification does not mandate where skill directories live (it only defines what goes inside them), scanning `.agents/skills/` means skills installed by other compliant clients are automatically visible" — **documented**.

- Also notes: some implementations also scan `.claude/skills/` for compat; other additions: ancestor directories up to git root (monorepos), XDG config dirs, user-configured paths — **documented**.

- **Selection / allowlist mechanism?** Spec defines **no allowlist mechanism**. Client guide mentions **Filtering**: "Some skills should be excluded from the catalog. Common reasons: The user has disabled the skill in settings … Hide filtered skills entirely from the catalog rather than listing them and blocking at activation time." and **Trust considerations**: "Project-level skills come from the repository … Consider gating project-level skill loading on a trust check." But no spec-level `allowlist` field or per-run allowlist grammar. The `disable-model-invocation` flag is not in the spec; it's a vendor extension. Therefore: **spec defines zero selection/allowlist fields** — spec silent — the guide describes vendor-side filtering as implementation choice.

- `llms.txt` index fetched 2026-08-22 lists: Specification, Client Showcase, Quickstart, Best practices, Optimizing descriptions, Evaluating skills, Using scripts, How to add skills support — confirming `specification.md` and `client-implementation/adding-skills-support.md` are canonical — **documented**.

---

## Comparison table

| harness | skill search roots (in discovery order) | disable-all flag | per-run allowlist | config-directory variable | reads `~/.agents/skills` | HOME relocation viable |
|---|---|---|---|---|---|---|
| **claude** 2.1.239 | Enterprise `/etc/claude-code/.claude/skills`; `~/.claude/skills` → `~/.claude/skills/synced`; `.claude/skills` per ancestor up to repo root; nested `.claude/skills` (lazy); `--add-dir` `.claude/skills`; plugin `<plugin>/skills` (namespaced); bundled — **does not include** `~/.agents/skills` | `--disable-slash-commands`; `--safe-mode`; `--bare` (skip auto-discovery; `--add-dir` skills still load; `/skill-name` explicit still resolves); settings `disableBundledSkills:true` / env `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` | **No per-run flag.** Closest is persistent `skillOverrides: {name:"off"}` or `disable-model-invocation:true` frontmatter/`paths:` narrowing; `Skill` is **not** a tool-permission name; `allowedTools` is per-skill post-activation, not a gate | `CLAUDE_CONFIG_DIR` (default `~/.claude`) — relocates **all** state: settings, history, plugins, skills (`$dir/skills`), credentials on Linux/Win, sessions `projects/` | **No** — only `~/.claude/skills` | Via `CLAUDE_CONFIG_DIR` is supported; bare `HOME` move **not documented**, works as side effect of tilde expansion but leaves macOS Keychain behind and relocates unrelated HOME state; caller who can stage `CLAUDE_CONFIG_DIR` does not need per-skill allowlist, and `HOME` staging also empties skills but is blunt |
| **codex** 0.147.0 | Repo ancestors `<project_root>/.agents/skills` … `CWD/.agents/skills`; `~/.codex/skills` (legacy deprecated); `~/.agents/skills`; `system_cache_root_dir` (bundled SYSTEM); `/etc/codex/skills` (ADMIN); config-layer `<repo>/.codex/skills`; plugin roots; `--add-dir` extra roots | **No global disable-all flag.** `--ignore-user-config` drops user/system layers only; repo `.agents/skills` still loads; `skills.bundled.enabled=false` disables bundled; per-path `[[skills.config]] enabled=false`; trust gate disables repo if untrusted | **`-c skills.config=[{path|name, enabled=false}]`** or `-c skills.bundled.enabled=false` plus `--profile <name>` overlay `$CODEX_HOME/<name>.config.toml` — per-run via CLI. No `Skill` tool-permission gate; `policy.allow_implicit_invocation:false` in `agents/openai.yaml` disables implicit use per skill | `CODEX_HOME` (default `~/.codex`) — relocates **all user state**: `config.toml`, per-profile configs, `auth.json` (file backend), `history.jsonl`, `log/`; **not** repo `.agents/skills` or admin path | **Yes** — `$HOME/.agents/skills` resolved via `dirs::home_dir()`; also `CWD/../.agents/skills` chain | `HOME` move hides `$HOME/.agents/skills`; `CODEX_HOME` move hides user config-layer skills. **Highly viable:** docs endorse `CODEX_HOME=$(pwd)/.codex codex exec …`; staging `HOME=$(mktemp -d)` (empty) + `CODEX_HOME=$HOME/.codex` yields empty user skill set; repo + `/etc` skills survive unless repo untrusted |
| **pi** 0.84.2 | `~/.pi/agent/skills` (root `.md` + recursive `SKILL.md`); `~/.agents/skills` (recursive `SKILL.md` only); `.pi/skills` (trust-gated, same as global); `.agents/skills` per ancestor up to git root or fs root (recursive, ignores root `.md`); package `skills/` dirs / `pi.skills`; `settings.json` `skills:[]` paths; CLI `--skill <path>` repeatable (additive) | `--no-skills` (`-ns`) — full OFF (explicit `--skill` still additive); `--no-context-files` disables instruction files only; trust gate (`defaultProjectTrust ask/never` + `--no-approve`) disables project skills | **`--no-skills --skill <path>`** repeatable — `pi --no-skills --skill ./a --skill ./b` is the **supported per-run allowlist**. No `Skill` tool gate; frontmatter `disable-model-invocation:true` hides from model (explicit `/skill:name` still works) | `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) — relocates **all global state**: `settings.json`, `auth.json`, `sessions/`, `skills/`, `extensions/`, `AGENTS.md`; secondary `PI_CODING_AGENT_SESSION_DIR` for sessions only; `~/.agents/skills` independent of this var | **Yes** — `~/.agents/skills` (recursive, no root `.md`); `.agents/skills` per ancestor | `PI_CODING_AGENT_DIR` is surgical; plain `HOME` move hides both `~/.pi/agent/skills` and `~/.agents/skills` (both via `homedir()`) — **viable** for user skills. Project skills survive HOME move; need `--no-skills` or untrusted project to hide. Caller who can stage `PI_CODING_AGENT_DIR` or temporary HOME has complete isolation without per-skill list |
| **muse** 0.2.1 | Built-in; `$XDG_CONFIG_HOME/muse/skills` (and `~/.agents/skills` — both user); `<repo>/.agents/skills/<id>/SKILL.md` plus compat `.codex/skills`, `.claude/skills` (project); plugin registry | **No dedicated flag.** Project skills gated by workspace trust (untrusted → project skills hidden; `--trust-workspace`/`--yolo` re-enables). No `disableAllSkills` setting; per-skill persistent `muse skills disable --scope` only | **No per-run flag.** No `--skill` / `--skills` allowlist. Persistent `muse skills disable <id> --scope user|project|built-in|plugin` survives run; no `Skill` tool-permission name; closest per-run is `--no-foreign-personal-context` (drops foreign personal skills) or `--workspace <path>` isolation — but not a skill-name allowlist | **No `MUSE_CONFIG_DIR`.** Surgical knob is `XDG_CONFIG_HOME` (relocates `muse/skills` + `settings.json`) — documented via `$XDG_CONFIG_HOME/muse/skills`. No env that relocates all state; project skills are repo-relative and unmovable. `~/.agents/skills` independent of `XDG_CONFIG_HOME` | **Yes** — `~/.agents/skills` listed as user alt path "(and `~/.agents/skills`)"; `.agents/skills` as primary project path | `XDG_CONFIG_HOME=$(mktemp -d)` isolates user `muse` skills but not `~/.agents/skills`; plain `HOME=$(mktemp -d)` isolates both `~/.agents/skills` and (when `XDG_CONFIG_HOME` unset) `~/.config/muse/skills`. Project skills still survive unless workspace left untrusted. **Viable for user skills**; for full isolation caller adds `--no-foreign-personal-context` and avoids `--trust-workspace` |
| **agentskills.io spec** | **Spec defines no location.** Recommended implementation (guide): `<project>/.<client>/skills` + `<project>/.agents/skills` (project); `~/.<client>/skills` + `~/.agents/skills` (user); plus ancestor up to git root, XDG, `.claude/skills` compat — convention, not normative | None defined | None defined by spec; guide notes vendor filtering (disabled-in-settings, permission deny, trust gate, `disable-model-invocation` equiv) but no grammar | N/A — spec is harness-agnostic | Convention is `~/.agents/skills` + `.agents/skills` — spec silent but guide recommends it | N/A |

Notes on HOME row: see §4 answers below for per-harness credential/keychain/session side-effects.

---

## Open — every question the sources did not answer

Organized by the 8 numbered questions in the brief; entries are "source silent" with what was checked.

### For claude

- **Q2 silent detail**: exact ancestor walk limit for `CLAUDE.md` (filesystem root vs XDG? repo root?) — docs say "every directory above working directory" but not whether it stops at `/` or HOME boundary; not needed for skill knobs.
- **Q6 gap**: whether `Skill(<name>)` would be respected as a permission rule — docs do not list `Skill` in permission syntax; help does not enumerate Skill tool; inferred absent but not explicitly denied by source.
- **Q7 nuance**: whether `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` differs in headless vs interactive — docs imply same.
- **Q8 completeness**: full set of managed-settings keys that also relocate via `CLAUDE_CONFIG_DIR` — env-vars doc says "All settings, session history, and plugins are stored under this path" but not whether telemetry or update caches also move — truncated.

### For codex

- **Q1 hidden-directory policy nuance**: whether `.agents/skills` hidden-ancestor skipping uses basename check below root only — confirmed in code (`has_hidden_ancestor_below_root`) but not in docs prose — docs silent on dot-directory exclusion in user-facing table.
- **Q3 silent**: whether `CODEX_HOME` also relocates `$HOME/.agents/skills` — code shows it does not; docs table assigns that to `$HOME`, not `$CODEX_HOME`, but does not explicitly confirm independence.
- **Q5 silent**: whether any undocumented env like `CODEX_DISABLE_SKILLS` exists — not found via `cx-env` dumps; treated as absent after checking `codex --help` and `cx-config-reference.md` key enumeration.
- **Q6 silent**: whether `Skill` appears as a tool name in the permissions system — no source confirms; help does not list it.
- **Q7 silent**: whether `codex exec --ephemeral` skips persisting but still warms skill cache — not relevant.

### For pi

- **Q2 silent**: exact ancestor discovery for `AGENTS.md`/`CLAUDE.md` beyond cwd — docs say pi loads `~/.pi/agent/AGENTS.md` plus project file, but not whether it walks ancestors like skills do — unverified; assumed single-level but source silent.
- **Q3 silent but verified via observed**: whether `PI_CODING_AGENT_DIR` affects `PI_PACKAGE_DIR` — `PI_PACKAGE_DIR` env exists but doc does not tie it to agent dir; observed source shows separate handling.
- **Q5 silent edge**: whether `disableSkillShellExecution`-equivalent exists in pi — not documented; docs mention `allow_implicit_invocation` only.
- **Q8 silent**: whether `defaultProjectTrust` interacts with `sessionDir` persistence — unrelated.

### For muse

- **Q1 ordering**: numeric precedence among built-in / user / project / plugin when same skill id exists at multiple project compat paths (`.agents/skills` vs `.codex/skills` vs `.claude/skills`) — docs not enumerating; listing order inferred but not cited.
- **Q3**: no source defines a relocator for all muse state; `XDG_CONFIG_HOME` is the documented user-scope relocator; there is no `MUSE_HOME` or `MUSE_CODE_HOME` — search of `muse --help` and `muse-configuration.html` confirms absence (silent).
- **Q4 HOME breakage**: credential storage file path for OAuth/API keys not explicitly documented as `~/.config/muse/auth.json` vs OS Keychain — inferred from XDG but not proven; marked unverified.
- **Q5**: docs list no skills-off flag — help confirms absence; not clear whether `muse skills disable` writes to `settings.json` or separate manifest — silent.
- **Q6**: no per-run `--skill` allowlist; silent confirms via help dump.
- **Q7**: exact session-log / trust-db location that survives HOME move — silent.
- **Q8**: `runtime_capabilities` key schema and whether `skill recall` toggle disables discovery or just observation — silent beyond "on by default".

### For agentskills.io

- **Q3–Q8 analog not applicable**: spec defines no config dir / env / flags — intentionally silent; client guide defines conventions only, not normative knobs.
- Spec silent on **search locations** (normatively) — confirmed via `curl specification.md` search for `.agents` returning 0 hits; guide provides recommendation table but explicitly notes "While the Agent Skills specification does not mandate where skill directories live".
- Spec silent on **selection/allowlist mechanism** — no `allowlist`, `include`, `enabled` grammar in spec fronmatter table; only `allowed-tools` (experimental) relates to tool allowlist, not skill allowlist.

---

*Written for machine consumption. Prefer this file over the scraped indexes when citing paths.*

