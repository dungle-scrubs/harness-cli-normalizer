# Hook enforcement: can each harness gate a subagent spawn?

Research date: 2026-08-22. Harness versions observed on this machine: claude 2.1.239, codex-cli 0.147.0, pi 0.84.2, Muse Code 0.2.1. Standing words: **documented** (owning source states it), **observed** (ran on this machine and saw it), **unverified** (no source found). Silence is reported where a source does not address a question.

---

## 1. Claude Code (2.1.239)

### 1.1 Pre-tool hook that can block

**Documented.** Event `PreToolUse` fires before a tool call executes and can block it.

- Event table in `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/cc-plugins-reference.md:110` lists: "`PreToolUse` | Before a tool call executes. Can block it".
- Permission narrative in `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/cc-permissions.md:440` states: "When Claude Code makes a tool call, PreToolUse hooks run before the permission prompt, for every tool except `EndConversation`."
- Same file at line 446: "A blocking hook also takes precedence over allow rules. A hook that exits with code 2 stops the tool call before permission rules are evaluated".

Registration:

- File: any settings file in the precedence chain (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed `managed-settings.json`) under key `hooks` (observed, `~/.claude/settings.json` contains `"hooks": { "PreToolUse": [...] }`; documented in `cc-plugins-reference.md` hooks section as `"hooks": { "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "..."}]}]}` pattern and in `cc-settings.md:638` noting hooks reload on file change).
- Also via plugin `hooks/hooks.json` with same event schema (documented, `cc-plugins-reference.md` Plugin components > Hooks).
- Matcher: string regex against tool name, e.g. `"Bash|Read"` (observed in `~/.claude/settings.json`).

Blocking contract (documented + observed):

- Shell command hook: exit 2 with reason on stderr blocks; exit 0 allows. Stated in `~/.agents/hooks/tool-use/secret-file-gate.sh:16` ("Contract: exit 2 + a reason on stderr == BLOCK. exit 0 == allow") and in `cc-permissions.md:446` as "exits with code 2 stops the tool call". The `cc-agent-sdk_claude-code-features.md:198-207` SDK hook example shows the equivalent programmatic return discriminated on `hookEventName: "PreToolUse"` with a decision payload.

**Standing: documented that PreToolUse exists and can block; observed registration file and exit-2 contract on this machine.**

### 1.2 Spawns subagents

**Documented and observed.** Tool names `Task` (alias `Agent`) spawn subagents. Described across `cc-settings-reference.md`, `cc-cli-reference.md:63` (`--agents` defines custom subagents), and `cc-env-vars.md:192-196` (subagent stall timeout, auto-backgrounding). `~/.claude/settings.json` contains `SubagentStart` hook registrations, confirming the lifecycle. Model per spawn is expressible: agent frontmatter supports `model: sonnet` (documented, `cc-plugins-reference.md` Agents section frontmatter fields `name`, `description`, `model`, `effort` ...), and CLI `--agents '{...}'` JSON accepts the same fields (documented, `cc-cli-reference.md:63`).

### 1.3 Can the pre-tool hook see the spawn's parameters including model?

**Documented that the hook receives full tool input; per-spawn model visibility follows from that.**

- Claude Code PreToolUse stdin is JSON with `tool_name`, `tool_input`, and related fields. The working `secret-file-gate.sh` extracts `tool_input` strings via `jq -r '[ (.tool_input // .input // .arguments // {}) | .. | strings ] | join("\n")'` (observed, `secret-file-gate.sh:20-23`), demonstrating that argu­ments are present. The SDK hook input is a discriminated union on `hook_event_name` carrying `tool_input` (documented, `cc-agent-sdk_claude-code-features.md:239-248`).
- For the spawn tool specifically, the scraped SDK pages do not show the Task tool's JSON schema in full (silence on exact field list). The agent definition docs show that `model` is a first-class field wherever an agent is defined (documented, `cc-plugins-reference.md`). Whether the Task tool's `tool_input` echoes that `model` verbatim per invocation was not found in the scraped settings pages, but the general contract is that `tool_input` contains the tool's parameters, so a `model` parameter when supplied would be visible. No scraped source states that PreToolUse receives only a tool name without arguments (the gate script would not function if it did).

**Standing: documented that PreToolUse receives tool arguments at `tool_input`; unverified by direct Task-tool schema scrape whether a `model` field is always present (it is present when the caller supplies it). The negative condition - "hook only receives tool name" - is false for Claude Code.**

### 1.4 Nearest enforcement point if no pre-tool hook (not applicable)

Claude Code has a blocking pre-tool hook, so the fallback ranking is moot. For completeness, other gates documented in `cc-permissions.md` are: permission `deny` rules under `permissions` (config-level tool denial), `PermissionRequest` hook (fires when a permission decision is needed), wrapper binary on PATH (unhardened; bypassed by direct tool name), and `SessionStart`/`SubagentStart` instruction injection (advisory, not blocking). Rank by bypass hardness: PreToolUse exit 2 (hardest, evaluated before permissions; `cc-permissions.md:446`) > `permissions.deny` > `PermissionRequest` > `SessionStart` prompt injection > PATH wrapper.

---

## 2. Codex CLI (0.147.0)

### 2.1 Pre-tool hook that can block

**Documented in the 0.147.0 checkout and in config reference.** Event `PreToolUse` exists and can block.

- File listing at `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/codex-tree.txt` shows a dedicated hooks subsystem: `codex-rs/hooks` (lines 3910-3948), `codex-rs/core/src/hook_runtime.rs` (line 2758), `codex-rs/config/src/hook_config.rs` (line 2355), and `codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json` plus `.output.schema.json` (lines 3923-3924). The listing itself is evidence the subsystem shipped before 0.147.0.
- Config reference at `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/cx-config-reference.md:430` lists `hooks.<Event>` with examples "`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`...". It defines `hooks.<Event>[].hooks` as "Hook handlers for a matcher group. Command hooks are currently supported" and notes `features.hooks` gating.
- Core dispatch at `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/codex-src/codex-rs/core/src/tools/registry.rs` implements the gate: `PreToolUsePayload { tool_name, tool_input: Value }` (lines 236-243), `PreToolUseHookResult::Blocked(String)` vs `Continue` (observed via `hook_runtime.rs:53-55` and consumed at `registry.rs:576-614`). On `Blocked`, dispatch returns `FunctionCallError::RespondToModel(message)` without executing the tool (line 579-585).

Registration (documented):

- Inline in `config.toml` under `[hooks]` / `hooks.<Event>` (documented, `cx-config-reference.md:hooks` keys), or via `hooks.json` file referenced by config (documented, `hooks.<Event>` keys plus `features.hooks`).
- Managed layer at `hooks.managed_dir` for admin-enforced hooks (documented, `cx-config-reference.md` `hooks.managed_dir` / `allow_managed_hooks_only`).
- Trust/approval semantics similar to Claude Code are implied by `allow_managed_hooks_only` but not separately scraped for PreToolUse.

Blocking contract (observed in source, documented via schema):

- The harness runs command hooks with a `PreToolUseRequest` payload and interprets `PreToolUseOutcome` as either blocked or continue, with optional `updated_input`. The registry mapping to `Blocked` vs `Continue` is at `registry.rs:576-614`. The output schema file name `pre-tool-use.command.output.schema.json` indicates a JSON output contract, but the file was not present on disk in the partial checkout (observed missing at `/private/tmp/.../codex-src/codex-rs/hooks/schema/generated/`). The source enum is the authoritative contract in this checkout.

**Standing: documented that PreToolUse exists and can block in the 0.147.0 source tree; observed that the blocking branch is `PreToolUseHookResult::Blocked` in `registry.rs`; the exact shell exit-code vs JSON field for external command hooks is documented as a `PreToolUseOutcome` JSON schema in the tree listing but unverified on disk due to partial checkout.**

### 2.2 Spawns subagents

**Documented.** `agents.enabled` (default true), `agents.default_subagent_model`, and per-spawn model precedence are in `cx-config-reference.md:609` ("Default model for spawned agents. An explicit spawn model takes precedence") and `cx-cli.md:130` ("`subagents`: Ask Codex to delegate focused work to specialized agents"). Session DB tables and rollout handling for subagents are present in the tree listing. Model per spawn is expressible: the config distinguishes default vs explicit spawn model (documented, same file).

### 2.3 Can the pre-tool hook see the spawn's parameters including model?

**Documented for the general case; unverified for the spawn tool's exact field set.**

- `PreToolUsePayload` carries `tool_name: HookToolName` and `tool_input: Value` described as "Tool-specific input exposed at `tool_input`. Shell-like tools use `{ \"command\": ... }`; MCP tools use their resolved JSON arguments." (observed, `registry.rs:238-243` comment). `registry_tests.rs:452-540` constructs `PreToolUsePayload { tool_name, tool_input }` with concrete JSON (e.g. `{"command": [...]}`), confirming that arguments are serialized to hook stdin.
- For a subagent-spawn tool (whatever its `HookToolName` is in 0.147.0), `tool_input` would contain its JSON arguments, including `model` when an explicit model is supplied (follows from payload definition). No scraped schema lists the spawn tool's field names, so the field name `model` for that specific tool is unverified, but the mechanism (tool_input contains the tool's arguments) is documented.

**Standing: documented that PreToolUse sees the full `tool_input`; unverified by direct spawn-tool schema scrape that a `model` field is named `model` on that tool. The "hook only receives tool name" negative is false per `PreToolUsePayload`.**

### 2.4 Nearest enforcement point if no pre-tool hook (not applicable)

Codex has PreToolUse, so the fallback is moot, but the nearest non-hook controls documented are: `notify` (array of commands) and `[hooks]` alternatives.

- `notify` at `cx-config-reference.md:180` is "Command invoked for notifications; receives a JSON payload from Codex" with `config.schema.json:notify` described as "Optional external command to spawn for end-user notifications" (`/private/tmp/.../codex-src/codex-rs/core/config.schema.json` lines ~6165). It fires after the fact (notification), not before a tool call, and cannot block (silence in docs on blocking, consistent with observed registry where `notify` is not consulted in `dispatch_any_with_terminal_outcome`). Rank: PreToolUse > config-level `permissions`/`agents.enabled` > `notify` (post-hoc, non-blocking) > PATH wrapper > `SessionStart` prompt injection.

### 2.6 notify vs hooks - explicit finding

**Documented that `notify` is not a gate.** Config reference `cx-config-reference.md:180` type `array<string>` description "Command invoked for notifications; receives a JSON payload from Codex" and schema `config.schema.json:notify` "Optional external command to spawn for end-user notifications" both place `notify` in the notification family. No field on `notify` indicates a blocking outcome. Hooks at `cx-config-reference.md:hooks.<Event>` are the lifecycle hook system; `notify` is a separate key. Searching the config reference for interaction between `notify` and `PreToolUse` finds none (silence). Source confirms separation: `codex-rs/app-server/src/bin/notify_capture.rs` and `hooks/src/legacy_notify.rs` are distinct binaries/modules in `codex-tree.txt`.

**Standing: documented that `notify` fires after and cannot block; documented that `PreToolUse` under `[hooks]` can block.**

---

## 3. Pi (0.84.2)

### 3.1 Pre-tool hook that can block

**Documented, but under a different event name.** Pi has no `PreToolUse` by that string (silence in `docs/extensions.md` on that literal). Its equivalent is `tool_call` on the ExtensionAPI, explicitly marked "(can block)" in the lifecycle diagram.

- Lifecycle diagram in `/Users/kevin/.local/share/mise/installs/node/lts/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:304` shows: "`tool_call (can block)`" between `tool_execution_start` and `tool_execution_update`.
- Section "Tool Events #### tool_call" at same file lines 751-765 states: "Fired after `tool_execution_start`, before the tool executes. **Can block.**" and "Return values from `tool_call` control blocking via `{ block: true, reason?: string, terminate?: boolean }`". Lines 759-766: `event.input` is mutable; mutations affect execution; later handlers see earlier mutations.
- Registration: an extension TypeScript module exporting `default function (pi: ExtensionAPI) { pi.on("tool_call", async (event, ctx) => { ... }) }` (documented, `docs/extensions.md:62-75` example and `docs/extensions.md:751` header). Extension locations: `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project-local) plus `settings.json` `extensions` array (documented, `docs/extensions.md` Extension Locations table).

Blocking contract (documented):

- Return `{ block: true, reason: "Blocked by user", terminate: true }` from a `tool_call` handler. Example at `docs/extensions.md:70-74` blocks `bash` containing `rm -rf`. The `terminate` sub-field stops the agent early only when every finalized result in the batch is terminating (line 765).

**Standing: documented that `tool_call` fires before execution and can block via `{ block: true }`; observed that `pi --help` lists extension flags (`--extension`, `--no-extensions`) but does not enumerate events, consistent with extension-registered hooks.**

### 3.2 Spawns subagents

**Documented that pi does not ship subagents.** `/Users/kevin/.local/share/mise/installs/node/lts/lib/node_modules/@earendil-works/pi-coding-agent/README.md:500` states: "**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way." The `pi --help` output (observed) lists no subagent command, and `docs/extensions.md` Table of Contents has no subagent entry. An extension could register a custom tool that spawns work, but no built-in spawn tool exists to gate.

Per-spawn model is therefore not applicable for built-in behavior. Custom tools would expose per-spawn model only if the extension author defines a `model` parameter in `Type.Object({...})` (documented, `docs/extensions.md` Custom Tools example at line ~78). That is extension-defined, not harness-defined.

**Standing: documented that pi ships without subagents.**

### 3.3 Can the pre-tool hook see the spawn's parameters including model?

**Conditional.** The `tool_call` handler receives `event.toolName`, `event.toolCallId`, `event.input` (documented, `docs/extensions.md:771-778`), with typed narrowing via `isToolCallEventType`. `event.input` is the tool's parameters. If a spawn tool exists (extension-provided), `event.input` would contain its fields including any `model` the tool declares (follows from `pi.registerTool` parameter schema at `docs/extensions.md` lines ~78-90). For built-in tools (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`), `event.input` is documented per tool (e.g. `bash: { command: string; timeout?: number }` at `docs/extensions.md:778`). No built-in spawn tool's schema exists to quote.

**Standing: documented that `tool_call` sees full `tool_input` (`event.input`); for the hypothetical spawn gate, unverified because no built-in spawn tool exists. The "hook only receives tool name" negative is false per `docs/extensions.md:771`.**

### 3.4 Nearest enforcement point

Pi has a blocking pre-tool hook (`tool_call`), so the fallback ranking is for alternative surfaces:

- `tool_call` `{ block: true }` (hardest; in-process, before exec, fail-safe if handler throws at `docs/extensions.md:2894` "tool_call errors block the tool").
- `bash` `spawnHook` on `createBashTool` to adjust `command`/`cwd`/`env` before spawn (documented, `docs/extensions.md:2116-2130`; narrower than full veto).
- `before_agent_start` / `before_provider_request` for prompt/payload mutation (advisory, not tool-level veto).
- `SessionStart` injection of instructions (unhardened).
- `--tools` / `--exclude-tools` allowlist/denylist at CLI (`pi --help` observed `--tools <list>`, `--exclude-tools <list>`) - config-level denial but bypassable by re-invoking pi without flags.
- Wrapper binary on PATH (softest).

### 3.5 Can an extension intercept or veto a tool call?

**Documented yes.**

- `docs/extensions.md:751` "Can block" plus contract at line 765 (`{ block: true, ... }`) directly answers yes.
- Additional interceptor: `tool_result` at `docs/extensions.md:815` "can modify" results, and `tool_execution_*` lifecycle hooks observe but do not veto (post-hoc).
- File location for authority: `/Users/kevin/.local/share/mise/installs/node/lts/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:751-810` (extension guide installed with pi 0.84.2), corroborated by the observed `secret-file-gate.sh:8` comment noting "pi: the secret-file-gate extension, which execs this with the tool input as argv (tool_call -> {block:true, reason})".

**Standing: documented.**

---

## 4. Muse Code (0.2.1)

### 4.1 Pre-tool hook that can block

**Documented.** Event `PreToolUse` exists and can block.

- Lifecycle events at `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/c8338134-6439-49b4-91ea-ae34d7ca797d/scratchpad/muse-extending.html` section "Lifecycle events {#hook-events}" list: "The available events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreLLMCall`, `PostLLMCall`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and `Stop`."
- Same file section "## Hooks {#hooks}" paragraph: "Wire your own shell commands into Muse Code's lifecycle. A hook binds a shell command to a lifecycle event. When the event fires, Muse Code runs the command and acts on its result: enforce a check, format code, or block an action before it happens".
- Registration (documented, same file): three sources - Project at `<project-root>/.muse/hooks.json`, User at settings file (`muse-configuration.html` notes "a first-class `hooks` block" in settings), and Managed at `managed_hooks_path`. Trust gating: `muse hooks trust <key>` before they run (plus `muse hooks list`/`validate`/`run <key> --fixture`). Observed `muse --help` lists no top-level `hooks` subcommand in this build's help snapshot (observed output showed only `resume, exec, config, export, trace, skills, sandbox, session-message, auth, login, logout, init`), but `muse-extending.html` documents `muse hooks list|validate|trust|run` (documented precedence over observed CLI help truncation).
- The `muse-configuration.html` scraped at `/private/tmp/.../scratchpad/muse-configuration.html` line ~3 lists "- a first-class `hooks` block, plus a `managed_hooks_path` pointer (see [hooks](/docs/muse-code/extending.md#hooks))".

Blocking contract:

- The extending guide states the hook can "block an action before it happens" (documented above) but the scraped excerpt does not list the shell exit-code / JSON-field contract for Muse Code PreToolUse at the granularity Claude Code does. The fixture shape `{"event": "PreToolUse", "stdin": {}}` is given at `muse-extending.html` for `muse hooks run`. The exact "exit 2 blocks" vs `{"decision":"block"}` field was not found in the scraped `muse-permissions.html` or `muse-configuration.html` (silence in those slices). Muse Code's hook runner may follow the same Claude-like exit-code convention or a JSON decision; the source was not scraped here. The capability to block is documented; the per-byte contract is unverified in the scraped HTML.

**Standing: documented that PreToolUse exists and can block; registration files and `hooks` key documented; exact blocking contract (exit code vs JSON field) unverified in the scraped slices.**

### 4.2 Spawns subagents

**Documented.** Section "## Subagents and multi-agent {#multi-agent}" at `muse-extending.html:73` defines subagent, and line 84 lists internal tools: "`subagent_spawn`, `subagent_status`, `subagent_send_message`, `subagent_cancel`, `subagent_wait`, and `subagent_read_result`". Steering commands `/agent` and `/agent-*` are documented at same location. Children are one level deep, with cooperative cancellation, and worktree isolation via `--subagent-worktree-isolation` (documented, same section).

Per-spawn model: **silence in the scraped pages.** The `muse-extending.html` subagent section does not show a `model` parameter for `subagent_spawn`, and `--model` is documented as a top-level CLI flag for the lead session (observed, `muse --help: --model <MODEL>`). No line states "subagent_spawn accepts model". The observer agents note that each makes its own model calls (documented, `muse-extending.html:105`), but that does not establish per-spawn model expressibility. Treat per-spawn model as unverified/silent.

### 4.3 Can the pre-tool hook see the spawn's parameters including model?

**In general, documented that hooks receive a payload; for the spawn gate specifically, unverified whether model is present.**

- The only payload detail scraped is the fixture shape `{"event": "PreToolUse", "stdin": {}}` at `muse-extending.html` (the `stdin` object holds the payload the hook receives). No scraped slice enumerates `stdin.tool_input` fields for `subagent_spawn`.
- By analogy with Claude Code and Codex, a PreToolUse payload should carry tool name and input, but the Muse scraped docs do not state that explicitly (silence on `tool_input` key for Muse).
- For the spawn gate to be meaningful, the hook must see a `model` field per spawn; the scraped Muse docs are silent on whether `subagent_spawn` exposes `model` at all (see 4.2), so visibility of that field cannot be claimed.

**Standing: documented that PreToolUse fires before tool use and receives a `stdin` payload; unverified whether that payload includes full tool arguments for `subagent_spawn`, and unverified/silent whether `subagent_spawn` has a `model` field to see. The negative "hook only receives tool name and not its arguments" is not stated, but also not disproven by the scraped Muse slices - report as silence on argument-visibility detail.**

### 4.4 Nearest enforcement point if no pre-tool hook (not applicable, but alternatives)

Muse Code has PreToolUse, so the primary gate is that. Nearest alternatives documented:

1. `PermissionRequest` hook (fires when tool needs permission decision) - can influence approval but after PreToolUse.
2. `mcp` / tool sandbox (`muse-permissions.html` and `muse-configuration.html` reference sandbox/approval; hooks section warns "Hooks run outside the sandbox").
3. Config-level tool denial via disabled tools / MCP `enabled_tools`/`disabled_tools` (documented, config keys for MCP server tool filtering, analogous to `--tools`).
4. `SessionStart` / `UserPromptSubmit` injection of system context (advisory).
5. Wrapper binary on PATH (softest; Muse Code's CLI help shows no hook for PATH override).

Rank preTool veto > permission/sandbox > config denial > session-start injection > PATH wrapper.

---

## Summary table

| Harness | Pre-tool hook | Can block | Sees tool arguments | Spawns subagents | Per-spawn model | Nearest enforcement point (if no hook, or next-hardest) |
|---|---|---|---|---|---|---|
| Claude Code 2.1.239 | `PreToolUse` (documented, `cc-plugins-reference.md:110`, `cc-permissions.md:440`) | yes - exit 2 + stderr reason (documented, `cc-permissions.md:446`; observed, `secret-file-gate.sh:16`, `~/.claude/settings.json`) | yes - `tool_input` with full arguments (documented, SDK inputs; observed, gate script jq over tool_input) | yes - `Task`/`Agent` tool (documented) | yes - agent `model` frontmatter/CLI JSON (documented) | PreToolUse (hardest) > `permissions.deny` > `PermissionRequest` > SessionStart injection > PATH wrapper |
| Codex 0.147.0 | `PreToolUse` via `[hooks]` (documented, `cx-config-reference.md:hooks.<Event>`, `codex-tree.txt:hooks/schema/generated/pre-tool-use.*`) | yes - `PreToolUseHookResult::Blocked` / `PreToolUseOutcome` (observed, `registry.rs:576`) | yes - `PreToolUsePayload { tool_name, tool_input: Value }` (observed, `registry.rs:236`) | yes - `agents` multi-agent tools (documented, `cx-config-reference.md:agents.*`) | yes - `agents.default_subagent_model` with explicit spawn model precedence (documented) | PreToolUse (hardest) > `notify` is post-hoc non-blocking (`cx-config-reference.md:180`, `config.schema.json:notify`) > PATH wrapper > SessionStart injection |
| Pi 0.84.2 | `tool_call` on ExtensionAPI (documented, `docs/extensions.md:304` "(can block)", `:751` "Can block") - no `PreToolUse` literal | yes - `return { block: true, reason, terminate }` (documented, `docs/extensions.md:765`) | yes - `event.input` mutable with typed inputs (documented, `docs/extensions.md:771-778`) | no - "**No sub-agents.**" ships without them (documented, `README.md:500`) | n/a - custom tools define own `model` param if desired (extension-defined) | `tool_call` block (hardest, fail-safe on throw, `docs/extensions.md:2894`) > `bash.spawnHook` > `--tools`/`--exclude-tools` (`pi --help` observed) > SessionStart injection > PATH wrapper |
| Muse Code 0.2.1 | `PreToolUse` (documented, `muse-extending.html#hook-events`) | yes - "block an action before it happens" (documented, `muse-extending.html#hooks`); exact exit/JSON contract unverified in scraped slices | payload is `stdin` object (documented, `muse-extending.html` fixture `{"event":"PreToolUse","stdin":{}}`); full `tool_input` visibility not enumerated in scraped slices - unverified | yes - `subagent_spawn` family (documented, `muse-extending.html:84`) | silent in scraped pages whether `subagent_spawn` accepts `model` - unverified | PreToolUse (hardest) > `PermissionRequest` > sandbox/MCP `enabled_tools` > SessionStart/UserPromptSubmit injection > PATH wrapper |

Notes on silence:

- Claude Code: Task tool's JSON field list including exact `model` key name not scraped, but the general `tool_input` contract is documented, so per-spawn model visibility follows when the caller supplies it.
- Codex: spawn tool's field name not scraped; the `tool_input: Value` mechanism guarantees whatever field the tool declares is visible, but the field name for this tool is unverified.
- Muse Code: both "does `subagent_spawn` accept `model`" and "does PreToolUse stdin contain full arguments" are silent in the scraped HTML slices retrieved; the fixtures show structure but not spawn-specific fields.

---

## Open

- Exact Muse Code PreToolUse blocking contract (exit code vs JSON `decision`) - scraped `muse-extending.html` gives the fixture shape but not the stdout/exit interpretation. Read `muse` source or capture a `muse hooks run` execution to confirm bytes. Withheld pending source read; do not infer from Claude Code's exit-2.
- Codex command-hook output contract in 0.147.0 - `pre-tool-use.command.output.schema.json` listed in `codex-tree.txt:3924` but missing on disk in the partial checkout at `/private/tmp/.../codex-src/codex-rs/hooks/schema/generated/`. Confirm against the installed binary or a full checkout whether the hook blocks via JSON `outcome` vs shell exit code, and whether `updated_input` JSON round-trips the modified `tool_input`.
- Whether `notify` registration changed in 0.147.0 from notification-only to a gated hook - checked `cx-config-reference.md` and `config.schema.json:notify` ("Optional external command to spawn for end-user notifications"): both describe it as notification-only, but a runtime behavior change between scraped docs and installed binary remains open until `codex --help` / `codex exec --help` output for `notify` vs `hooks` is captured verbatim from 0.147.0.
- Pi extension distribution for a `tool_call` gate - `secret-file-gate.sh:8` claims "pi: the secret-file-gate extension, which execs this with the tool input as argv (tool_call -> {block:true, reason})" implying an extension exists that bridges the script. The extension file itself was not located on this machine (`~/.pi/agent/extensions/` not listed) and is not in the scraped pi docs - existence and deployment path remain unverified.
- Cross-harness model-registry enforcement shape - even where PreToolUse can see `model`, the registry against which to validate is not defined in any harness. Whether the gate should block absence of `model` vs validate its value against an allowlist is a policy decision upstream of the gate mechanism, not answered by hook existence.
