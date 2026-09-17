# Adding Cursor CLI and Grok Build CLI as hcn harnesses

> Research date: 2026-09-16. Versions: Cursor CLI `2026.09.10-fd3934a`
> (darwin/arm64 tarball), Grok Build `grok 1.0.30 (04b7ffed98c6)`, Grok source
> `xai-org/grok-build` at `482711333c7195dc16a272777f86086d615e2afb`.
>
> Produced by two independent researchers on the same brief,
> `muse-spark-1.3-contributor@muse` and `opus-5@claude`, then reconciled by the
> session. Where they disagreed, the session re-ran the binaries; section 1
> records each dispute and how it was settled.
>
> Note: Grok Build is deferred. The owner has no Grok subscription, so no
> logged-in Grok run is possible. The Grok sections below are unchanged.
>
> Cursor facts come from Cursor's public docs and from logged-in runs of the
> CLI on 2026-09-16 (agent `2026.09.10-fd3934a`). The pre-auth runs used a
> throwaway `HOME`; the capture spike ran logged in and past the auth gate.

Standing labels (Cursor parts use only these three):

- **documented** - the vendor's docs say it.
- **observed** - a researcher or the session ran the binary and saw it.
- **unverified** - not established.

Grok sections additionally cite its Apache-2.0 open-source code as
`(source <path>:<line>)`. No Cursor claim rests on shipped code.

Citation shorthand:

- `cursor:<page>` = `https://cursor.com/docs/<page>`
- `xai:<page>` = `https://docs.x.ai/<page>`
- `grok-guide:<file>:<line>` = `crates/codegen/xai-grok-pager/docs/user-guide/<file>` in the Grok repo at the commit above
- `grok-src:<path>:<line>` = a source path in the same repo

## 0. Findings that change the plan

1. **Both CLIs are real, official, and have documented headless NDJSON
   streams.**
   - Grok Build is published by xAI, open source under Apache-2.0
     (`github.com/xai-org/grok-build`), and on npm as `@xai-official/grok`.
   - Cursor CLI is closed source and ships only through an install script.
2. **The Cursor binary is now `agent`.** `cursor-agent` is a legacy symlink.
   The install script at `https://cursor.com/install` says "primary: agent,
   legacy: cursor-agent" (documented).
3. **Grok Build copies Claude Code on purpose.**
   - `--output-format streaming-messages-json` is in the Anthropic Messages /
     Claude `stream-json` shape.
   - It accepts Claude flag names (`--allowedTools`,
     `--dangerously-skip-permissions`) and Claude `--permission-mode` values.
   - By default it reads `CLAUDE.md`, `~/.claude` rules, skills, hooks, MCP
     configs, and `.claude/settings.json` `defaultMode`.
   - hcn's claude decoder may be reusable for that stream (unverified).
4. **ACP (Agent Client Protocol) is the only way a caller can answer a tool
   approval or question on either CLI.**
   - The entry points are `agent acp` and `grok agent stdio` (also
     `serve`).
   - In print mode neither CLI hangs, and neither lets the caller answer. Both
     deny or cancel approvals unless the run uses the yolo flag, and both
     reject the model's questions automatically.
   - hcn has no ACP support: `SESSION_INPUT_KINDS` and
     `NATIVE_APPROVAL_PROTOCOLS` have no ACP member. One ACP client would give
     both harnesses persistent sessions and native approvals. One-shot turns do
     not need it.
5. **Both CLIs need new descriptor vocabulary before a descriptor can be
   written.** Section 5 lists the gaps. The largest:
   - Grok takes the prompt as the value of `-p`. The descriptor's
     `launch.promptStyle` can only be the literal `"positional"`.
   - Neither CLI's session store matches a `CWD_SLUGS` member. Grok uses a
     URL-encoded cwd; Cursor uses an md5 hex of the cwd plus a separate dash
     slug (both sides observed for Cursor: spike probes 30, 36, 37, 38).
6. **Cursor facts in this doc come from Cursor's public docs and from
   logged-in runs of the CLI; no claim rests on the shipped code.**
   - Logged-in runs on 2026-09-16 (agent `2026.09.10-fd3934a`) observed the
     events the docs omit (`thinking`, `interaction_query`), a `usage` object
     on `result`, the md5-hex store layout, and resume-on-unknown-id creating
     a session (spike probes 10, 11, 11b, 13, 15, 19, 20, 24, 30, 36-38).
   - The docs are wrong in two places the spike settled: thinking is not
     suppressed in print mode (spike probe 11b), and edits run without
     `--force` in a trusted workspace (spike probe 13).
   - Bracket model params from the `--help` example do not work at runtime
     (spike probes 27/28); effort rides slug suffixes.
   - An undocumented `--new-session-id` flag exists but is absent from visible
     help (spike Q16); hcn will not rely on it.
7. **Recommended order: Grok Build first, Cursor second.** Section 6 gives the
   reasons. Adding either harness widens hcn's scope, so it is the owner's
   call.

## 1. Disputes between the two researchers, and how they were settled

| Question | Muse said | Opus 5 said | Settled by | Result |
|---|---|---|---|---|
| Grok `-p` prompt shape | positional prompt | `-p <PROMPT>`, the prompt is the flag's value | session ran `grok -p --output-format json` | **Opus 5.** Output: `error: a value is required for '--single <PROMPT>' but none was supplied`. `--help` line: `-p, --single <PROMPT>` |
| Grok `--trust` | absent from `--help`, unverified | hidden flag | session ran `grok --trust --version` | **Opus 5.** The flag is accepted (exit 0) and hidden from help |
| Grok resume of an unknown id | `onMissing: "error"` (docs) | tries a remote restore, then starts a device-code login, even under `-p` | observed run, evidence `obs/grok-resume-unknown.stderr` | **Opus 5.** stderr: `Session "..." not found locally, restoring conversation from remote...`, then a device URL at `accounts.x.ai`, `Waiting for authorization...`, then `Error: Failed to authenticate for session restore` |
| Grok identity authority | minted by default and caller-assignable; proposes a new authority member | caller-assigned via `-s` | both describe the same facts | No conflict. `caller-assigned` fits when hcn always passes `-s`, which is how claude works today |
| Cursor caller-assigned id | none; `create-chat` mints ids | undocumented `--new-session-id` flag | session ran `agent -p --new-session-id notauuid hi` and saw a UUIDv4 validation error | Settled by that observed run, narrowed by spike Q16 (flag absent from visible help). Owner decision: hcn will not rely on it |
| Cursor session store | unknown (server-side suspected) | `~/.cursor/chats/<md5(cwd)>/<id>/store.db` plus `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | settled by spike probes 30, 36, 37, 38 | **Opus 5.** Store is `$XDG_CONFIG_HOME/cursor/chats/<md5(cwd)>/<id>/` with md5 over the physical absolute cwd; transcripts under `<dash-slug>/<id>/<id>.jsonl` |
| Cursor token usage | none anywhere (docs) | optional `usage` on `result` | settled by spike probe 10 | **Opus 5.** `json` output carries `usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`; the docs list no usage |
| Cursor stdin prompt | none found | stdin is read to EOF when there is no positional prompt | settled by spike notes-session probe 05 | **Opus 5.** Piped stdin with no positional prompt is used as the prompt |
| Cursor headless approvals | writes proposed only; hang/deny unknown | reads, writes and allowlisted shell run without `--force`; web fetch/search denied without it | settled by spike probes 13, 14, 15, 16, 17 | **Opus 5, narrowed.** Edits run without `--force` in a trusted workspace; web fetch and non-allowlisted shell are auto-denied unless `--force` |
| Cursor exit codes | 0 / non-zero; auth = 1 | 0, 1, 130 (SIGINT), 143 (SIGTERM) | settled by observed runs plus spike probes 33b, 34 | Auth = 1 observed; 130 on SIGINT and 143 on SIGTERM observed |

## 2. Cursor CLI

### 2.A Identity and distribution

- **Name and publisher:** "Cursor CLI" / "Cursor Agent CLI", by Cursor
  (Anysphere). The package inside the tarball is `@anysphere/agent-cli-runtime`,
  marked private (observed).
- **Not this harness:** `origin` (Cursor's git-hosting CLI) and `@cursor/sdk`
  (an in-process library) (documented: `cursor:origin/cli`,
  `cursor:sdk/typescript`).
- **Binary:** `agent`, with `cursor-agent` as a legacy symlink. The tarball's
  entry point is a bash script that runs a bundled Node runtime (observed).
  The unpacked tree is about 736 MB (observed).
- **Install:** script only.
  - Unix: `curl https://cursor.com/install -fsS | bash`. Windows: PowerShell.
  - It unpacks to `~/.local/share/cursor-agent/versions/<ver>/` and links it
    into `~/.local/bin` (documented: `cursor:cli/installation`).
  - Tarball URL pattern:
    `https://downloads.cursor.com/lab/<ver>/<os>/<arch>/agent-cli-package.tar.gz`
    (observed).
  - The installation page lists no npm package and no brew formula.
- **Platforms:** macOS and Linux on x64 and arm64, WSL, native Windows
  (documented).
- **Version:** `agent --version` / `-v` prints the bare string
  `2026.09.10-fd3934a`: a date plus a short hash, not semver (observed).
- **Release cadence:** about weekly. `cursor:cli/changelog` has entries on
  Jun 9, 22, 29, Jul 6, 13, 20, Aug 11 and 26, 2026 (documented).
- **Auto-update:** on by default (documented: `cursor:cli/installation`).
  There is no documented or observed way to turn it off (spike Q11).
- **License:** closed source; no public repo. The Terms of Service (updated
  2026-09-03) forbid reverse engineering (documented).
- **This machine:** `~/.cursor/agent-cli-state.json` exists and holds only
  self-hosted worker ids. No `agent` binary is on PATH (observed).

### 2.B Auth

- **Ways to authenticate** (documented: `cursor:cli/reference/authentication`):
  - `agent login` in a browser; `NO_OPEN_BROWSER=1` prints the URL instead.
  - `CURSOR_API_KEY` or `--api-key <key>`, created on the dashboard API Keys
    page.
- **Status:** `agent status` / `agent whoami` with `--format text|json`.
  Without auth it prints `Not logged in` and exits 0 (observed).
- **Undocumented auth options:**
  - `--auth-token` / `CURSOR_AUTH_TOKEN`, named in the `--list-models` auth
    error (observed).
  - `-e/--endpoint <url>` / `CURSOR_API_ENDPOINT`, default
    `https://api2.cursor.sh`. It is in `--help` but not in the parameters page
    (observed).
- **Credential storage:** login persists without re-login across store moves
  (observed: spike probe 36). `AGENT_CLI_CREDENTIAL_STORE=file` switches to an
  owner-only file (documented: changelog 2026-06-29). The file path is
  unverified.
- **No auth, observed** (`-p` with `text`, `json` and `stream-json`):
  - Exit code 1. Stdout is empty; no JSON object is written.
  - Stderr: `Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.`
  - This matches `cursor:cli/reference/output-format`: "On failure, the
    process exits with a non-zero code and writes an error message to stderr.
    No well-formed JSON object is emitted."
- **Fake API key, observed:** exit 1. Stderr starts with
  `⚠ Warning: The provided API key is invalid.` in yellow ANSI even with
  `TERM=dumb`, then `Please check you have the right key...`.
- **Expired stored login:** no observed text. The phrasing is unverified.
- **`models` / `--list-models` without auth, observed:** exit 1 with
  `Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.`
- **Order of checks, observed:** auth is checked before output-format
  validation, prompt presence and model name.

### 2.C Headless mode

- **Entering print mode:** `-p/--print` turns it on. A non-TTY stdout also
  turns it on (documented: `cursor:cli/reference/output-format`; observed:
  spike notes-session probe 06). So any spawn with piped stdio runs headless
  even without `-p`.
- **Prompt:** the positional words joined by spaces (documented).
  - With no positional prompt, piped stdin is used as the prompt (observed:
    spike notes-session probe 05).
  - A positional prompt with stdin left open emits `result` and then never
    exits; the caller must close stdin (observed: spike notes-session
    probe 07).
- **Workspace trust:** an untrusted workspace in print mode prints
  "Workspace Trust Required ... Pass --trust, --yolo, or -f if you trust this
  directory" and exits 1 with empty stdout (observed: spike notes-session
  probes 01/02). `--trust` persists trust by writing `.workspace-trusted`
  (observed: spike notes-session probes 03/04). `--force` and `--yolo` bypass
  the gate per-run without persisting anything (observed: spike probes 31/32).
- **Output formats** (`--output-format`, only with `--print`; documented):
  - `text` (default): only the final assistant text (observed: spike probe 09).
  - `json`: one object at the end:
    `{type:"result", subtype:"success", is_error:false, duration_ms, duration_api_ms, result, session_id, request_id?, usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}`
    (observed: spike probe 10).
  - `stream-json`: NDJSON, with `--stream-partial-output` for token deltas
    (observed: spike probes 11, 11b).

**`stream-json` events** (all rows observed in the spike unless noted).

| Line | Fields | Standing |
|---|---|---|
| `system/init` | `apiKeySource` (`login` observed), `cwd` (physical dir), `session_id` (UUID), `model` (display name, not the slug), `permissionMode` (`default`) | documented + observed (spike Q3) |
| `user` | `message: {role: user, content: [{type: text, text}]}` = the prompt, `session_id` | documented + observed (spike Q3) |
| `assistant` | `message.content[].text`, `session_id`. With `--stream-partial-output`: each text delta carries `timestamp_ms` and no `model_call_id`; the end-of-turn flush repeats the full text with no `timestamp_ms` and no `model_call_id` | documented + observed (spike probe 11) |
| `tool_call/started`, `tool_call/completed` | `call_id`, `tool_call` (observed variants: `readToolCall`, `editToolCall`, `shellToolCall`, `webFetchToolCall`, `webSearchToolCall`, `askQuestionToolCall`, `createPlanToolCall`), `model_call_id`, `session_id`, `timestamp_ms`. `started` also carries `toolCallId`, `startedAtMs` (string) and `hookAdditionalContexts`; `completed` adds the result object and `completedAtMs` (string) | documented (read/write) + observed (spike probes 12-15, 19, 20) |
| `result/success` | as the `json` object; `result` is all text concatenated. `result` stays `success` with exit 0 even when tool calls are denied and questions auto-rejected | documented + observed (spike probes 15, 20) |
| `result.usage` | `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` | observed (spike probe 10); the docs list no usage |
| `thinking/delta`, `thinking/completed` | delta carries `text` + `timestamp_ms`; `completed` carries only `timestamp_ms` (no text). Thinking is not suppressed in print mode; the docs say it is | observed (spike probes 11, 11b) |
| `interaction_query/request`, `/response` | observed `query_type` values: `webFetchRequestQuery` (auto-rejected without `--force`), `createPlanRequestQuery` (auto-approved in plan mode), `askQuestionInteractionQuery` (auto-rejected with "Questions skipped by the user, continue with the information you already have") | observed (spike probes 15, 19, 20) |

Documented example line (`cursor:cli/reference/output-format`):

```json
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/Users/user/project","session_id":"c6b62c6f-...","model":"Claude 4 Sonnet","permissionMode":"default"}
```

- **No error event.** Failures end the stream and write stderr (documented).
  Every failure mode the spike hit has empty stdout and plain-text stderr
  (observed: spike Q14).
- **No cost field** in any format (documented).
- **Consumers must ignore unknown fields** (documented).

### 2.D Sessions and resume

- **Id:** a UUID, on every stream line as `session_id` (documented +
  observed: spike Q3; the same id is re-emitted on every line including
  resume).
- **Caller-assigned id:** an undocumented `--new-session-id` flag exists. It
  is absent from visible help (observed: spike Q16). hcn will not rely on it.
- **Resume flags** (documented: overview and parameters pages):
  - `--resume [chatId]`, `--resume=-N` (the Nth most recent), `--continue`
    (same as `--resume=-1`).
  - `agent resume` resumes the latest; `agent ls` is an interactive picker.
  - `agent ls` and `agent resume` take no id argument; headless resume uses
    `--resume` / `--continue` (observed: spike Q16).
- **`-p --resume <id>` works headless.** Init carries the same `session_id`
  and the model recalls earlier-turn facts (observed: spike probes 21a/21b).
  `-p --continue` and `-p --resume=-1` resume the most recently touched
  session (observed: spike probes 22, 23). `--model`, `--output-format`,
  `--mode` and `--force` are all accepted alongside `--resume` (observed).
- **Resuming an unknown UUID creates a session.** `--resume
  <random-unknown-UUIDv4>` exits 0, the stream uses the given id throughout,
  and a fresh session is created under it (observed: spike probe 24).
  `--resume not-a-uuid` fails fast with exit 1, empty stdout and stderr
  `Failed to claim persistent session for chat "not-a-uuid":
  Persistent-session chat ID must be a UUID` (observed: spike probe 25).
- **A SIGTERM-killed session resumes cleanly** with full history (observed:
  spike probe 35).
- **`agent ls` without a TTY** crashes with the Ink error "Raw mode is not
  supported on the current process.stdin" (observed).
- **`agent create-chat`** prints a new id and then does not exit; a 90 s alarm
  killed it (observed by Opus 5).
- **On-disk state (observed: spike Q1, Q2, probes 30, 36, 37, 38):**
  - Resume state:
    `$XDG_CONFIG_HOME/cursor/chats/<md5 hex of cwd>/<id>/{store.db, meta.json}`.
    The md5 covers the physical absolute cwd (no symlink, no trailing slash);
    a `--workspace <dir>/` with trailing slash is normalized to the same md5.
    Setting `XDG_CONFIG_HOME` moves the whole store. `CURSOR_CONFIG_DIR` is a
    documented custom-directory override
    (`cursor:cli/reference/configuration`); its precedence over
    `XDG_CONFIG_HOME` is unverified.
  - `meta.json` keys are exactly `schemaVersion, createdAtMs,
    hasConversation, updatedAtMs, cwd`.
  - `store.db` (SQLite) has exactly two tables: `blobs (id TEXT PRIMARY KEY,
    data BLOB)` and `meta (key TEXT PRIMARY KEY, value TEXT)`.
  - Transcripts: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
    The slug replaces every character that is not a letter or digit with `-`,
    collapses runs, and trims dashes, with no truncation and no hash suffix
    (space and dot both become `-`).
  - Transcript records are `{role, message}` plus a terminal `{type:
    turn_ended, status}` line. The user record wraps the prompt in
    `<timestamp>` / `<user_query>` tags. The assistant record uses
    Anthropic-style content blocks (`{type: text}` and `{type: tool_use,
    name, input}`). The edit tool name is `StrReplace` with `input: {path,
    old_string, new_string}`; the read tool name is `Read`. No
    `tool_result` / `tool_calls` records exist; tool results live only in the
    stream-json `tool_call/completed` events. The records carry no uuids, no
    timestamps and no per-record session id, so the transcript is not the same
    record envelope as Claude Code's JSONL; the changelog
    "Claude Code-compatible JSONL" claim holds at most for the content blocks.
  - This machine's `~/.cursor/projects/*/agent-transcripts` holds IDE-written
    transcripts (observed), which fits the transcript path.
- **Fork:** `/fork` exists in interactive mode. Headless fork support is
  unverified.
- **`agent persist`** (documented: changelog Aug 26, 2026): keeps sessions
  alive after the terminal detaches (`persist attach|list|stop`). It outlives
  the spawned process and is outside hcn's scope (ADR 0007).

### 2.E Models

- **Selection:** `--model <model>`. `agent models` and `--list-models` list
  the account's models and need auth (documented + observed). There is no
  `--effort` flag and no `--provider` flag.
- **Bracket params are rejected at runtime.** `--help` shows a bracket example
  (`'claude-opus-4-8[context=1m,effort=high,fast=false]'`), but both
  `--model 'claude-opus-5-low[effort=high]'` and
  `--model 'gpt-5.2[effort=low]'` fail with `Cannot use this model: ...`
  (exit 1, empty stdout; observed: spike probes 27/28).
- **Effort rides slug suffixes.** The model list holds 110 models with
  per-family suffix ladders (`low/medium/high/xhigh/max`,
  `low/medium/high/xhigh`, `low/medium/high`, `none/low/medium`,
  `none/low/medium/high/extra-high`, bare slugs with no effort variant), a
  `-fast` doubling on most entries, and infixed `thinking` for Claude thinking
  variants. There is no uniform ladder; per-family suffix sets must be
  enumerated, not derived (observed: spike Q10, `out/models.txt`).
- **Default:** `Auto` for new installs (documented: changelog 2026-07-06).
  The spike ran `--model composer-2.5-fast` throughout; `system/init.model`
  shows the display name (`Composer 2.5 Fast`, `GPT-5.2 Medium`), not the slug
  (observed: spike Q3, probe 29).
- **Invalid model:** `--model not-a-model` fails before inference with exit 1,
  empty stdout and stderr `Cannot use this model: not-a-model. Available
  models: <110-entry slug list>` (observed: spike probe 26).
- **No JSON model listing:** `agent models` is text-only (`Available models`
  plus `<slug> - <display name>` lines); `--format json` is not accepted
  (observed: spike Q9).

### 2.F Tools and permissions

- **Allow/deny lists live only in config** (documented:
  `cursor:cli/reference/permissions`):
  - Files: `~/.cursor/cli-config.json` (global) and `<project>/.cursor/cli.json`
    (project).
  - Tokens: `Shell(cmd[:args])` with globs, `Read(glob)`, `Write(glob)`,
    `WebFetch(domain)`, `Mcp(server:tool)`. Deny wins.
- **Per-call tool lists:** no CLI flag observed. Allow/deny lives in config
  only (unverified beyond the config file).
- **Modes:**
  - `--mode plan|ask`: read-only (documented).
  - `approvalMode`: `allowlist`, `auto-review`, `unrestricted` (documented:
    configuration page).
- **Flags** (documented + observed): `-f/--force` (alias `--yolo`),
  `--auto-review`, `--sandbox enabled|disabled`, `--approve-mcps`, `--trust`.
- **Sandbox:** `--sandbox` with a network toggle; `agent sandbox run <cmd>`
  runs one command (documented).
- **Headless approvals (observed: spike probes 13-17, 19, 20):**
  - In a trusted workspace without `--force`, the model reads freely
    (`readToolCall`), edits files (`editToolCall` with `args: {path,
    streamContent}`), and runs allowlisted shell (`shellToolCall`; bare `ls`
    runs since `Shell(ls)` is in the default allow list).
  - Without `--force`, web fetch, web search and non-allowlisted shell are
    auto-denied: `tool_call/started` is followed by an `interaction_query`
    request/response pair in the same millisecond with a `rejected` result,
    then `tool_call/completed` with the same `rejected` result. The run does
    not hang.
  - With `--force`, edits and non-allowlisted shell (`echo hello-force`)
    execute with exitCode 0 and no `interaction_query` lines appear.
  - Questions are rejected with "Questions skipped by the user, continue with
    the information you already have" (`askQuestionToolCall` still completes;
    the run continues with exit 0).
  - Plan creation is auto-approved in plan mode (`createPlanToolCall` with an
    `interaction_query` request/response pair carrying
    `createPlanRequestResponse: {result: {success: {}}, planUri: ""}`; the file
    is not edited).
  - In ask mode the model refuses the edit itself: no `editToolCall` is issued
    and no `interaction_query` appears (spike probe 18).
- **Docs on writes:** `cursor:cli/headless` says "Without `--force`, changes
  are only proposed", but the spike observed edits running without `--force`
  in a trusted workspace, so that sentence is wrong as observed. The `-p` help
  text says "Has access to all tools, including write and shell" (observed:
  spike Q16), which matches the observed behavior. Whether `permissions.allow`
  entries beyond the default run under headless deny-by-default is unverified.
- **The caller can answer only over ACP** (documented: `cursor:cli/acp`):
  - `session/request_permission` with `allow-once`, `allow-always` or
    `reject-once`.
  - The blocking extensions `cursor/ask_question` and `cursor/create_plan`.

### 2.G Configuration and context

- **Config file:** `~/.cursor/cli-config.json`, JSON, schema version 1, repairs
  itself. `CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME` move it (documented:
  `cursor:cli/reference/configuration`; XDG move observed: spike probe 36).
  - A first run writes `approvalMode: allowlist`, `sandbox.mode: disabled`,
    `allow: ["Shell(ls)"]` (observed).
- **Instruction files:** `.cursor/rules` (`.mdc`) plus project-root
  `AGENTS.md` and `CLAUDE.md`; nested `AGENTS.md` is supported (documented:
  `cursor:cli/using`, `cursor:rules`).
- **Skills:** `.cursor/skills`, `.claude/skills`, `.agents/skills`,
  `.codex/skills` (documented: changelog). Managed skills are written under
  `~/.cursor/skills-cursor`. There is no CLI flag to load a skill.
- **MCP:** `~/.cursor/mcp.json` and `.cursor/mcp.json`, plus
  `agent mcp {login,list,list-tools,enable,disable}` (documented).
- **Hooks:** `hooks.json`, with Claude `settings.json` hooks merged
  in (documented: changelog).
- **Working directory:** `--workspace <path>`, repeatable `--add-dir`, and
  `-w/--worktree [name]` (documented + observed: spike Q16). The run's
  `system/init.cwd` is the workspace dir, not the process cwd, and the session
  is stored under `chats/md5(<workspace-dir>)` (observed: spike probe 30).
- **Environment variables:** `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`,
  `CURSOR_API_ENDPOINT`, `CURSOR_CONFIG_DIR`, `NO_OPEN_BROWSER`,
  `AGENT_CLI_CREDENTIAL_STORE` (documented or observed as noted above).
  The full list is unverified.

### 2.H Limits and failures

- **Limit errors:**
  - Headless surfacing of limits is not documented. The headless,
    output-format and troubleshooting pages say nothing about it.
  - The spike hit no limit, so no `limitMatchers` can be written from this
    evidence (unverified).
  - The stderr text of limit, pricing and conversation-too-long errors is an
    open question (see 7).
- **Exit codes (observed: spike Q14):**

  | Situation | Exit | stdout | stderr |
  |---|---|---|---|
  | success (text/json/stream) | 0 | format payload | empty |
  | untrusted workspace, no bypass (probes 01/02) | 1 | empty | `Workspace Trust Required ...` |
  | invalid model / bracket model (26/27/28) | 1 | empty | `Cannot use this model: ...` |
  | malformed resume id (25) | 1 | empty | `Failed to claim persistent session ...` |
  | SIGTERM mid-turn (33b) | 143 | truncated stream, no `result` | empty |
  | SIGINT mid-turn (34) | 130 | truncated stream, no `result` | `Aborting operation...` |
  | denied tool calls, rejected questions (15/20) | 0 | normal `result/success` | empty |

  The SIGTERM/SIGINT runs ended at `tool_call/started` with no `completed` and
  no `result` line; no loop child processes survived either kill; the killed
  session stays resumable (observed: spike probes 33b, 34, 35).
- **Status and about (observed: spike Q15):** `agent --version` prints the bare
  string `2026.09.10-fd3934a`. `agent status --format json` top-level keys are
  `status, isAuthenticated, hasAccessToken, hasRefreshToken, userInfo` with
  `userInfo: {email, userId, firstName, createdAt}`. `agent about --format
  json` keys are `cliVersion, latestStatus, latestVersion, model,
  subscriptionTier, osPlatform, osArch, userEmail, terminalProgram, shell,
  lastRequestId`. Both contain the account email and are not fixture-safe.
- **Context overflow:** manual `/summarize` (alias `/compress`) in interactive
  mode (documented). Headless overflow and automatic compaction are
  unverified.
- **Auto-update during CI runs:** no documented or observed way to turn it off
  (spike Q11). This is a supervision risk.

### 2.I Interactive mode

- **Start:** `agent` or `agent "initial prompt"`.
- **Resume:** `agent --resume <id>`, `--continue`, `agent resume`.
- **Modes:** `--mode`, `--plan`, Shift+Tab, `/plan`, `/ask`.
- Needs a TTY (documented + observed).

## 3. Grok Build CLI

### 3.A Identity and distribution

- **Name and publisher:** "Grok Build", binary `grok`, by xAI (documented:
  `xai:build/overview`).
- **Source:** `github.com/xai-org/grok-build`, Rust, Apache-2.0, created
  2026-07-14.
  - The README calls the publisher "SpaceXAI" and says the tree is "synced
    periodically from the SpaceXAI monorepo". `CONTRIBUTING.md` says external
    contributions are not accepted (observed in the clone).
- **Three unrelated version ids:** GitHub sync commit (`4827113`), `SOURCE_REV`
  monorepo sha (`be7ce6e8`), and the binary's build hash (`04b7ffed98c6`). Cite
  all three when pinning (observed).
- **npm package `@xai-official/grok` is official.**
  - xAI's enterprise docs recommend `npm install -g @xai-official/grok`
    (documented: `xai:build/enterprise`).
  - The registry maintainer is `xai-security <security@x.ai>` (observed).
  - The npm package declares license `Proprietary` while the source repo is
    Apache-2.0. This is recorded, not resolved.
- **Look-alikes that are not xAI's:**
  - npm `grok-cli`, which starts an anthropic-proxy and then runs Claude Code.
  - `superagent-ai/grok-cli`.
  - Several GitHub forks named `grok-build`.
  - This is inferred from xAI's docs never naming them. That is absence, not
    proof.
- **Install:** `curl -fsSL https://x.ai/cli/install.sh | bash`, PowerShell, or
  npm (documented).
  - Channels `stable|alpha|enterprise` via `GROK_CHANNEL`.
  - Installs to `~/.grok/bin` (`GROK_BIN_DIR` overrides).
  - The npm package pulls a per-platform package with a brotli-compressed
    binary for linux, darwin and win32 on x64 and arm64 (observed).
- **Versions** (observed):
  - `https://x.ai/cli/stable` returns `1.0.30`; `alpha` is `1.0.34`.
  - npm `latest` is `1.0.30` even though 1.0.31 to 1.0.34 are published, so the
    npm `latest` tag trails published versions.
  - 368 releases since 2025-10-22; v1.0.22 to v1.0.30 shipped between Sep 7 and
    Sep 11, 2026 (documented: `https://x.ai/build/changelog`).
- **Version query:** `grok --version` and `grok version` print
  `grok 1.0.30 (04b7ffed98c6)` (observed).
- **Auto-update off switches** (documented: `grok-guide:14-headless-mode.md`):
  `--no-auto-update`, `GROK_DISABLE_AUTOUPDATER=1`, `[cli] auto_update = false`.
  It is also suppressed when stderr is not a TTY. Update notices go to stderr.
- **Platforms:** macOS, Linux, Windows (documented). Windows builds are best
  effort.

### 3.B Auth

- **Ways to authenticate** (documented: `grok-guide:02-authentication.md`;
  source: `grok-src:crates/codegen/xai-grok-login/src/auth_method.rs:11-27`):
  - OAuth at `auth.x.ai`, on first TUI launch or via `grok login`.
  - `grok login --device-auth` (alias `--device-code`).
  - `XAI_API_KEY` (legacy name `GROK_CODE_XAI_API_KEY`).
  - OIDC (`GROK_OIDC_*`), an external auth command, and deployment keys
    (`GROK_DEPLOYMENT_KEY`).
  - A stored OAuth session takes priority over the API key.
- **Storage:** `~/.grok/auth.json` (mode 0600) and `mcp_credentials.json`.
  `GROK_HOME` replaces `~/.grok` (documented). A fresh `GROK_HOME` run created
  `config.toml`, `agent_id`, `active_sessions.json`, `sessions/`, `logs/`,
  `docs/` (observed).
- **No auth, observed** (exit 1 in every format):
  - `plain`: the message on stdout and an `Error: `-prefixed copy on stderr.
  - `json` and `streaming-json`: stdout is exactly
    `{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."}`.
    `streaming-json` writes **no `end` line**, although the docs say `end` is
    always last.
  - `streaming-messages-json`: a `system/init` line with `session_id:""` and
    `model:"unknown"`, then a `result` with
    `subtype:"error_during_execution"`, `is_error:true`, zero usage and
    `errors:["Not signed in. ..."]`.
  - Source: `grok-src:crates/codegen/xai-grok-pager/src/headless.rs:466-480`.
- **Fake key, observed:** `XAI_API_KEY=xai-not-a-real-key` gives the same
  "Not signed in" output. The cause is unverified. The invalid-key and
  expired-key phrasings are unverified.
- **`grok models` without auth, observed:** exit 0, `You are not authenticated.`,
  default `grok-4.6`, also `grok-4.5`.

### 3.C Headless mode

- **Entering headless mode:** `-p, --single <PROMPT>`. The prompt is the
  flag's value (observed by the session; see section 1). `--prompt-file <PATH>`
  and `--prompt-json` (ACP content blocks) also enter headless mode. A bare
  `grok "prompt"` opens the TUI (documented).
- **Stdin is not read.** "Headless mode does not read piped stdin into the
  prompt. Pass external content through command substitution or
  --prompt-file" (documented: `grok-guide:14-headless-mode.md:397`). This is a
  deliberate absence, stronger than silence.
- **Flags** (observed in `--help`):
  - Location, model and permissions: `--cwd`, `-m/--model`,
    `--reasoning-effort` (alias `--effort`), `--permission-mode`,
    `--always-approve` (aliases `--yolo`, `--dangerously-skip-permissions`),
    `--allow` / `--deny` (aliases `--allowedTools` / `--disallowedTools`).
  - Headless-only tool and turn limits: `--tools`, `--disallowed-tools`,
    `--max-turns`.
  - Prompt and output shaping: `--agents`, `--rules`,
    `--system-prompt-override` (alias `--system-prompt`),
    `--append-system-prompt`, `--json-schema` (implies `--output-format json`).
  - Feature switches: `--no-plan`, `--no-subagents`, `--disable-web-search`,
    `--sandbox <PROFILE>`, `--worktree [NAME]`, `--no-memory`,
    `--no-auto-update`.
  - `--trust` is accepted but hidden from help (observed; source
    `cli.rs:451-453`). It saves trust permanently.
- **Output formats** (documented: `grok-guide:14-headless-mode.md`,
  `xai:build/cli/headless-scripting`): `plain` (default), `json`,
  `streaming-json`, `streaming-messages-json`.

**`json` object** (documented: `grok-guide:14-headless-mode.md:129-208`):

- Main fields: `text`, `thought?`, `stopReason` (snake_case: `end_turn`,
  `max_tokens`, ...), `sessionId`, `requestId`.
- Spend fields:
  - `num_turns`.
  - `usage{input_tokens (uncached only), cache_read_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens}`.
  - `modelUsage{<model>:{inputTokens, outputTokens, cacheReadInputTokens, modelCalls, costUSD}}`.
  - `total_cost_usd` and `total_cost_usd_ticks` (1 USD = 10^10 ticks).
- `cost_is_partial` / `usage_is_incomplete`: an unknown cost is left out,
  never written as zero.
- On failure: `{"type":"error","message":...}` and a non-zero exit, with spend
  fields when usage was recorded.

**`streaming-json` events.** This is xAI's own format, built from ACP updates
(documented; source `grok-src:.../headless/reducer/acp.rs:14-200`).

| `type` | Fields |
|---|---|
| `text`, `thought` | `data` |
| `tool_call` | `toolCallId`, `title`, `kind`, `status`, `toolName`, `rawInput`, `content`, `locations` |
| `tool_call_update` | `toolCallId`, `status`, `content`, `rawOutput`, `locations` |
| `plan` | `entries` |
| `available_commands` | `tools[]`, `commands[]` |
| `usage` | per model response: `messageId`, `stopReason` (e.g. `tool_use`), `usage`, `signature` |
| `max_turns_reached` | none |
| `auto_compact_started` / `_completed` / `_failed` / `_cancelled` | `percentage` on started, `error` on failed |
| `auto_continue_completed` | `total_tokens` |
| `image_compressed` | `message` |
| `memory_flush_started` / `_completed`, `memory_capture_activity` | `result`, `path` |
| `error` | `message` plus spend fields |
| `end` | final: `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`), `sessionId`, `requestId`, spend fields, `structured_output` |

Documented example line:

```json
{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}
```

- The session id appears **only on `end`** in this format. Lifecycle line names
  and text chunk size are unverified.

**`streaming-messages-json` events** (documented:
`grok-guide:14-headless-mode.md:249-325`):

- **`system/init`:** `session_id`, `apiKeySource` (`user|oauth`), `model`,
  `cwd`, `permissionMode`, `tools`, `slash_commands`, `mcp_servers`, `skills`,
  `uuid`.
  - This line is held back until the first output line.
  - `mcp_servers[].status` echoes config and is always `connected`.
  - `system/compact_boundary` marks a compaction.
- **`assistant`:** `message{id, model, content[text|thinking|tool_use|server_tool_use|web_search_tool_result], stop_reason, stop_sequence, usage}`,
  `parent_tool_use_id`, `session_id`, `uuid`.
- **`user`:** carries `tool_result` blocks.
- **`result`:**
  - `subtype` is `success`, `error_max_turns`, `error_during_execution` or
    `error_max_structured_output_retries`.
  - Other fields: `num_turns`, `stop_reason`, `total_cost_usd` (0 when
    unknown), `usage`, `modelUsage` (with `contextWindow`), `errors[]`.
- **`--include-partial-messages`:** adds `stream_event` Messages framing
  (`message_start`, `content_block_*`, `message_delta`, `message_stop`). Each
  tool input arrives as one `input_json_delta`, and there is no
  `citations_delta`.
- **Other notes:**
  - `uuid` is new on every line and cannot link lines together.
  - There is no `permission_denials` field.
  - Placeholder fields are left out, not zero-filled.

**Exit codes** (documented: `grok-guide:14-headless-mode.md:559-566, 677-684`):

- 0: success.
- 1: error, auth, network or runtime failure.
- 130: SIGINT. 143: SIGTERM.
- An interrupt saves session state up to the last finished tool call. File
  changes are not rolled back.

### 3.D Sessions and resume

- **Ids:** Grok mints UUIDv7 (documented).
  - `-s/--session-id <UUID>` names a **new** session only and fails if the id
    exists under the target folder (documented:
    `grok-guide:17-sessions.md:18`; observed in `--help`).
  - With `--resume` or `--continue` it is valid only together with
    `--fork-session`.
- **Store:** `~/.grok/sessions/<URL-encoded cwd>/<session-id>/` (documented:
  `grok-guide:17-sessions.md:22-44`).
  - Files: `summary.json`, `updates.jsonl` (the authoritative ACP log),
    `chat_history.jsonl`, `system_prompt.txt`, `prompt_context.json`,
    `tool_definitions.json`, `plan.json`, `rewind_points.jsonl`,
    `signals.json`, `feedback.jsonl`, `compaction_checkpoints/`, `subagents/`.
  - If the encoded cwd is over 255 bytes, a slug plus hash is used with a
    `.cwd` file.
  - A global `sessions/session_search.sqlite` is created on the first run
    (observed).
  - `14-headless-mode.md:613` says transcripts are "SQLite". The sessions guide
    and the code use JSONL, and the SQLite file is a search index.
- **Resume flags** (documented + observed):
  - `-r/--resume [ID or title]`: titles match within the cwd, ignoring case.
    UUID-shaped values always take the id path. A bare `-r` means the most
    recent session.
  - `-c/--continue`, `--fork-session`, `--restore-code`.
- **Session commands:** `grok sessions list|search|delete`, `grok export`,
  `grok import` (from Claude Code).
- **Resuming an unknown id** (observed; source `session_startup.rs:830, 1098-1200`):
  - Grok first tries a remote restore through the session registry
    (`cli.session_registry`, on by default, waits up to 90 s).
  - With no usable credential it starts a device-code login under `-p`. It
    prints a device URL and code, then fails with
    `Error: Failed to authenticate for session restore`.
  - With the registry off it prints "Session does not exist locally".
  - How to turn the registry off by environment variable is unverified.
- **Id in the stream:** `json` has `sessionId`; `streaming-json` has it only on
  `end`; `streaming-messages-json` has it on every line.
- **Interactive session tools:** `/fork`, `/rewind`, `/compact`, `/resume`,
  `/sessions`.
- **No persistent multi-turn CLI process.** `grok agent {stdio|headless|serve|leader}`
  are ACP / WebSocket entry points (observed in `grok agent --help`), not a
  session prefix.

### 3.E Models

- **Selection:** `-m/--model`. `grok models` lists `grok-4.6` (default) and
  `grok-4.5`, without auth (observed).
- **Custom models:** `[model.<name>]` in `~/.grok/config.toml` with `model`,
  `base_url`, `name`, `env_key`; `[models] default` (documented:
  `xai:build/overview`, `grok-guide:11-custom-models.md`). Provider routing is
  per-model `base_url`; there is no `--provider` flag.
- **Effort:** `--reasoning-effort` / `--effort` with `none, minimal, low, medium, high, xhigh, max`
  (documented: `grok-guide:14-headless-mode.md:37`).
  - Each model accepts only the levels it advertises. Menu ids such as `deep`
    also work.
  - The parser accepts any string; how a bad value is rejected at runtime is
    unverified.

### 3.F Tools and permissions

- **Built-in tool ids** (documented: `grok-guide:14-headless-mode.md:49-60`;
  source `task.rs:1634-1706`, `crates/codegen/xai-grok-tools/src/registry/types.rs`):
  `run_terminal_cmd`, `read_file`, `search_replace`, `apply_patch`, `list_dir`,
  `grep`, `web_search`, `web_fetch`, `todo_write`, `spawn_subagent`, plus the
  MCP meta-tools `search_tool` and `use_tool`.
  - `10-hooks.md:172` says `run_terminal_command`; the code uses
    `run_terminal_cmd`.
  - The full list of tools enabled by default is unverified.
- **Tool lists** (documented):
  - `--tools <csv>` is a strict allowlist of built-ins. MCP meta-tools stay
    unless denied.
  - `--disallowed-tools <csv>` removes tools, including `Agent` and
    `Agent(type)`. It wins over `--tools`.
- **Permission rules:** `--allow` / `--deny <RULE>`, repeatable, with
  `Bash(...)`, `Edit(...)`, `Write(...)`, `Read(...)`, `Grep(...)`,
  `WebFetch(...)`, `MCPTool(...)`. Deny wins (documented:
  `grok-guide:22-permissions-and-safety.md`).
- **Permission modes:** `default` (ask), `acceptEdits`, `plan`, `auto`
  (classifier), `dontAsk`, `bypassPermissions` (documented:
  `22-permissions-and-safety.md:34-41`).
- **Sandbox profiles:** `off`, `workspace`, `devbox`, `read-only`, `strict`, or
  custom, using Seatbelt on macOS and Landlock on Linux. `GROK_SANDBOX` sets it.
  Child-network blocking does nothing on macOS (documented:
  `xai:build/features/sandbox`, `grok-guide:18-sandbox.md`).
- **Headless approvals** (source: `headless.rs:448-465, 1900-1920`,
  `headless/ext_protocol.rs:19-43`; documented in part):
  - Without always-approve, every permission request is answered `Cancelled`.
    With it, the first allow option is chosen.
  - In `auto` mode, a call the classifier would escalate fails and is reported
    to the model: "Auto mode blocked this action ..." (documented:
    `22-permissions-and-safety.md:100`).
  - `x.ai/ask_user_question` is answered `Cancelled`, MCP elicitation is
    cancelled, and `x.ai/exit_plan_mode` is approved.
  - v1.0.25 changelog: "Headless prompts time out cleanly instead of hanging
    when the agent does not respond" (documented).
- **Caller answers:** only over ACP, `grok agent [--always-approve] stdio|serve`,
  with `_meta.yoloMode` on `session/new` (documented:
  `grok-guide:15-agent-mode.md`).
- **Hazards** (documented):
  - Hooks fail open.
  - `requirements.toml` (`~/.grok/` or `/etc/grok/`) can lock always-approve
    off.

### 3.G Configuration and context

- **Config files:** `~/.grok/config.toml` (TOML), project
  `.grok/config.toml`, and managed `requirements.toml` /
  `managed_config.toml` (documented: `grok-guide:26-config-reference.md`).
  `grok inspect --json` shows where each setting came from.
- **Instruction files** (documented: `grok-guide:12-project-rules.md`):
  - In each directory from the git root to the cwd: `Agents.md`, `Claude.md`,
    `CLAUDE.md`, `CLAUDE.local.md`, `AGENT.md`, `AGENTS.md`.
  - Rule folders `.grok/rules`, `.claude/rules`, `.cursor/rules`, plus home
    `~/.grok/rules`, `~/.claude`, `~/.cursor`.
  - Loading project instructions, skills, MCP servers and hooks at startup
    needs folder trust (`22-permissions-and-safety.md:558`).
    `GROK_FOLDER_TRUST=0` turns the check off.
- **Compat switches:** `compat.claude.*`, `compat.cursor.*`, `compat.codex.*`
  all default to true, with environment overrides such as
  `GROK_CLAUDE_AGENTS_ENABLED` (documented: `26-config-reference.md:120-129`).
  - On this machine, `grok inspect` showed it picking up `~/.claude` content
    (observed by Opus 5).
- **MCP:** `[mcp_servers.<name>]` and `grok mcp`. It also reads `.mcp.json` and
  the Claude and Cursor MCP configs (documented).
- **Skills:** `~/.grok/skills/`, with no CLI flag to load one. Plugins:
  `grok plugin` and per-process `--plugin-dir` (documented).
- **Memory:** `~/.grok/memory/`. `GROK_MEMORY=0` or `--no-memory` turns it off
  (documented).
- **Environment variables:** `XAI_API_KEY`, `GROK_HOME`, `GROK_SANDBOX`,
  `GROK_LOG_FILE`, `RUST_LOG` (goes to stderr in headless mode),
  `GROK_DISABLE_AUTOUPDATER`, `GROK_MEMORY`, `GROK_FOLDER_TRUST`, `GROK_OIDC_*`,
  `GROK_AUTH_PROVIDER_*`, `GROK_CHANNEL`, `GROK_BIN_DIR`, `GROK_DEPLOYMENT_KEY`
  (documented).
- **Other commands:** `grok usage` (saved token and cost per session),
  `grok trace`, `grok doctor`, `grok inspect`, `grok setup` (documented +
  observed in help).

### 3.H Limits and failures

- **Rate limits** (source: `sampling/error.rs:13-89`). ACP error code `-32003`
  with message "Rate limited". The user-facing texts use U+2019 apostrophes:
  - Free usage (server code `subscription:free-usage-exhausted`):
    "You’ve reached your free Grok Build usage limit for now. Get SuperGrok..."
  - OAuth: "You’ve hit the rate limit for your plan..."
  - API key: "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits..."
  - Overloaded: "Model is temporarily overloaded. Try again in a moment."
  - Whether headless output shows these strings exactly is unverified. The
    guides are silent on it: `24-monitoring-usage.md` covers only
    OpenTelemetry export.
- **Context overflow:** auto-compaction, reported as `auto_compact_*` events in
  `streaming-json` and `system/compact_boundary` in the messages format
  (documented). `--max-turns` produces `max_turns_reached` / `error_max_turns`.
- **Cancellation:** 130 / 143 with saved state (3.C). This is the clearest
  cancellation contract of the six CLIs.

### 3.I Interactive mode

- **Start:** `grok` (fullscreen TUI; `--no-alt-screen`, `--minimal`) or
  `grok "prompt"`.
- **Resume:** `grok --resume <id>`, `grok -c`, the welcome-screen list,
  `/resume`, `/sessions` (documented + observed).

## 4. How each CLI maps onto `src/knowledge/descriptor.ts`

| Field | Cursor (`agent`) | Grok Build (`grok`) |
|---|---|---|
| `name` | new `HARNESS_NAMES` member, e.g. `"cursor"` | new member, e.g. `"grok"` |
| `bin` | `agent` (documented) | `grok` (documented) |
| `verifiedAgainst` | `2026.09.10-fd3934a`; not semver; facts verified by the logged-in spike | candidate `1.0.30`; must be parsed out of `grok 1.0.30 (hash)` |
| `versionSource` | `installed` only; no registry to poll | `{kind:"npm", package:"@xai-official/grok"}`, but npm `latest` trails published versions (3.A) |
| `launch.baseFlags` | `-p`; do not add `--trust` by default (it persists trust across processes) | `--no-auto-update`; `--trust` saves trust permanently, so do not add it by default |
| `launch.promptStyle` | `positional` fits | **gap:** the prompt is the value of `-p`; `promptStyle` is the literal `"positional"` |
| `launch.stdinPrompt` | piped stdin is read as the prompt when no positional is given (observed: spike notes-session 05); an open stdin hangs the exit (observed: notes-session 07): stdin policy `close-required` | none; large prompts need `--prompt-file` and a temp file |
| `launch.streamFlags` | `["--output-format", "stream-json", "--stream-partial-output"]` for token granularity; `["--output-format", "stream-json"]` for message granularity; bare for none (all observed) | `--output-format streaming-messages-json --include-partial-messages`, or `streaming-json` |
| `launch.idFlag` | `null` in visible help (an undocumented `--new-session-id` exists but hcn will not rely on it) | `--session-id` (UUID, new sessions only) |
| `identity` | `harness-minted`; announced on `system/init.session_id`, re-emitted on every line including resume (observed) | caller-assigned via `-s`; messages format announces on `system/init.session_id`; native format only at `end.sessionId` |
| `resume` | `flag --resume`, alias `--continue`, plus `--resume=-N` most-recent indexing; `UUID_SHAPE`; `onMissing: "create"` (unknown UUID starts a fresh session under that id, exit 0); `--model`, `--output-format`, `--mode`, `--force` all accepted alongside `--resume` (all observed) | `flag --resume`, alias `-r`; accepts titles too; `onMissing` = remote restore that can block up to 90 s and start device auth, then error |
| `resumeLast` | `--continue` (semantics: most recent; equals `--resume=-1`) (observed) | `--continue` (`-c`) |
| `sessionMode` | `null` (persistent sessions only via ACP) | `null` (persistent sessions only via ACP) |
| `output.pins` | token: `--output-format stream-json --stream-partial-output`; message: `--output-format stream-json`; floor: `none` (text/json emit nothing until the end) (all observed) | messages + partial: token; messages: message; floor none |
| `authMatchers` | not-logged-in `Authentication required. Please run 'agent login' first` (observed); invalid-key warning variant (observed); expired phrasing unverified | not-logged-in `Not signed in` (observed); invalid and expired phrasings unverified |
| `limitMatchers` | none observed (no limit hit in the spike); leave empty (unverified) | candidate texts from source (3.H); headless surfacing unverified |
| `autonomy` | `--force` (alias `--yolo`); note it also bypasses the trust gate per-run without persisting (observed) | `--always-approve` (alias `--yolo`) |
| `vocabulary` | `--model`; models = the 110 observed slugs; aliases: none observed; **gap:** effort rides per-family slug suffixes with no uniform ladder (`effortsByModel`-style per-family table needed); `extensible: false` (unknown slugs refused pre-flight) (all observed) | `-m`; `grok-4.6`, `grok-4.5`; 7 effort levels; extensible |
| `store` | **gap:** `{home}/.config/cursor/chats/<md5(cwd)>/<sessionId>/store.db` + `{home}/.cursor/projects/<dashSlug>/<sessionId>/<sessionId>.jsonl`, with XDG/`CURSOR_CONFIG_DIR` relocation of the chats side (all observed); md5-hex and uncapped dash-slug members needed in `CWD_SLUGS` | **gap:** `{home}/.grok/sessions/{URL-encoded cwd}/{id}`, not in `CWD_SLUGS` |
| `stdin` | `"close-required"` (observed: notes-session 07) | `inherit` is safe; stdin is never read |
| `presence.headlessMarkers` | `-p`; print mode also starts from stdio alone (observed: notes-session 06), so argv checks miss some runs | `-p`, `--single`, `--prompt-file`, `--prompt-json` |
| `contextHook` / `contextInspection` | no evidence | no used-percent record; `auto_compact_started.percentage` is only the trigger |
| `nativeContextManagement` | no evidence | auto-compaction documented; needs live evidence per `docs/harness-updates.md` |
| `turnOptions` | sandbox `enabled/disabled`; access read = `--mode ask` (observed); `--mode plan`; `--approve-mcps`; no observed flag for memory, maxSteps, write, shell, effort or system prompt | effort `--reasoning-effort`; sandbox profile enum; memory `--no-memory`; maxSteps `--max-turns`; systemPrompt `--system-prompt-override`; appendSystemPrompt `--append-system-prompt`; discovery via the compat env switches; access read via `--tools` preset or `--sandbox read-only` |
| `tools` | no per-call CLI flag observed; config allow/deny acts as `policy-gate` | include `--tools` (strict), exclude `--disallowed-tools` (`remove-from-set`); `--deny` rules act as `policy-gate` |
| `skills` | `null` (no CLI flag) | `null` (no CLI flag) |
| `escalation` | no evidence; `supported:false` | no evidence; `supported:false` |
| `transcript` | JSONL transcript path observed; record envelope differs from Claude Code's (observed: spike Q2) | `updates.jsonl` is the authoritative log; a `TranscriptKnowledge` entry looks writable (unverified) |

## 5. Vocabulary and scope pressure

**Changes to the closed descriptor vocabulary** that one or both harnesses
need:

1. **`launch.promptStyle`** needs a "prompt as a flag's value" shape (Grok
   `-p <PROMPT>`). A file-path prompt shape (`--prompt-file`) would also cover
   large prompts.
2. **`CWD_SLUGS`** needs `url-encoded` (Grok, with the 255-byte hash fallback),
   an md5-hex member (Cursor chats, observed: spike probes 30, 36, 38), and a
   dash-separator member without length cap or hash suffix (Cursor transcripts,
   observed: spike Q2). Computing md5 must stay out of the pure layers,
   because the purity gate bans `node:` imports.
3. **Cursor effort needs a per-family suffix table, not `OptionRender`.**
   Bracket params are rejected at runtime (observed: spike probes 27/28);
   effort rides slug suffixes with a different ladder per model family
   (observed: spike Q10).
4. **`VERSION_SOURCE_KINDS`** only has `npm` and `installed`. Cursor fits
   `installed`. Tracking the version its install script names would need a new
   kind.
5. **Refusal classes:** Cursor's workspace-trust refusal (observed: spike
   notes-session probes 01/02) is neither an auth nor a limit failure.
6. **Identity timing:** Grok's native `streaming-json` announces the id only
   at `end`. Choosing `streaming-messages-json` avoids this.
7. **ACP:** a `SESSION_INPUT_KINDS` member and a `NATIVE_APPROVAL_PROTOCOLS`
   entry, only if persistent sessions or native approvals are wanted for
   these harnesses.

**Scope under ADR 0007** (one process at a time):

- These are state or processes that outlive the spawned process. hcn must not
  track them:
  - Cursor `agent persist` (documented: changelog Aug 26, 2026) and auto-update
    (documented: `cursor:cli/installation`).
  - Grok's session registry, `grok agent serve|leader`, and `--worktree`.
  - Grok `--trust` and Cursor `--trust`. Both persist trust across processes
    (Cursor observed: spike notes-session probes 03/04), so a descriptor
    should not add them silently.
- Grok's compat switches pull in Claude, Cursor and Codex context by default.
  hcn's discovery defaults would not match unless the descriptor sets them.
- Cursor keeps allow/deny lists in config files. hcn renders argv and env, not
  config files, so the Cursor tool-list turn options stay divergent: there is
  no per-call tool-list flag (unverified beyond the config file).

## 6. Comparison and recommended order

| | Cursor CLI | Grok Build |
|---|---|---|
| Source | closed, minified; Terms forbid reverse engineering | Apache-2.0 Rust, user guide versioned with the code |
| Distribution | install script only | install script and npm |
| Versioning | date + hash, about weekly, auto-update | semver, about daily, auto-update with documented off switches |
| Headless prompt | `-p` or inferred from stdio; positional or stdin | `-p <PROMPT>`, `--prompt-file`, `--prompt-json`; no stdin |
| NDJSON formats | `stream-json` (observed: thinking, interaction_query, usage beyond the docs) | `streaming-json` (ACP-based) and `streaming-messages-json` (Claude shape) |
| Usage / cost in stream | `usage` on `result` (observed), no cost | full per-response usage and turn cost |
| Error in stream | none; empty stdout + stderr text + exit 1 (observed) | `{"type":"error"}` or `result` error subtype, plus stderr |
| Caller-assigned id | undocumented `--new-session-id`; hcn will not rely on it | documented `-s` |
| Resume of unknown id | creates a fresh session under that id, exit 0 (observed) | remote restore, up to 90 s, device auth, then error |
| Effort | slug suffixes per family; bracket params rejected (observed) | `--reasoning-effort`, 7 levels |
| Per-call tool lists | none; config allow/deny only | `--tools` / `--disallowed-tools` |
| Headless approvals | reads, writes and allowlisted shell run without `--force`; web fetch/search and non-allowlisted shell denied without it; questions auto-rejected (observed) | cancel unless `--always-approve` (source + documented) |
| Caller can answer approvals | ACP `agent acp` | ACP `grok agent stdio` |
| Exit codes | 0 / 1 / 130 / 143 (all observed) | 0 / 1 / 130 / 143 documented |

**Order: Grok Build first, then Cursor.** Both researchers reached this
independently.

1. **Grok Build first.**
   - Every fact can be checked in public source, so the implementation settles
     disputes.
   - The stream formats are documented in detail, including known gaps.
   - npm gives drift detection without credentials.
   - Caller-assigned ids, effort, max turns, system prompt and tool lists all
     have documented flags.
   - The Claude-shaped stream may let hcn reuse its claude decoder.
   - The descriptor work is bounded: a flag-value prompt style, a
     `url-encoded` cwd slug, and a deliberate choice of stream format.
2. **Cursor second.**
   - A clean integration depends on an undocumented id flag hcn will not rely
     on, plus events the docs omit (observed, but still undocumented).
   - It needs new vocabulary for per-family effort suffixes and md5 store
     folders.
   - Print mode can start from stdio alone (observed).
   - It has no registry for drift checks.
   - Every fact must come from docs or logged-in runs, never from the bundle.
   - None of this rules it out, but it costs more and pays back less.
3. **ACP for both, only if needed.** One ACP client in the execution layer
   would give both harnesses persistent sessions and native approvals.
   One-shot turns do not need it. This is a separate decision.

## 7. Open questions

All of these need an authenticated, disposable capture unless noted.

**Cursor:**

1. What stderr text do limit, pricing and conversation-too-long errors
   produce in headless output?
2. Do `permissions.allow` entries beyond the default `Shell(ls)` run under
   headless deny-by-default?
3. What is the credential file path when `AGENT_CLI_CREDENTIAL_STORE=file`?
4. Why does `create-chat` print a new id and then not exit?
5. Does headless mode compact automatically on overflow, and what does it emit?
6. What is the full tool list behind the observed `tool_call` variants, and
   the full environment-variable list?
7. Does `CURSOR_CONFIG_DIR` take precedence over `XDG_CONFIG_HOME` for the
   chats store?
8. How do the Terms of Service apply to automated headless use (not read beyond
   the reverse-engineering clause)?

**Grok Build:**

14. Which limit messages appear in headless output, and in which event.
15. The invalid-key and expired-key messages.
16. How to turn off the session registry by environment variable, and resume
    behaviour with a valid credential.
17. Lifecycle event names and `streaming-json` text chunk size.
18. How a bad `--effort` value is rejected; image input through
    `--prompt-json`.
19. The full default-enabled tool list.
20. Whether `-p` goes through a leader process when `use_leader` is on.
21. xAI's Terms of Service. `https://x.ai` legal pages returned HTTP 403 to the
    researcher, so they were not read.
22. The npm `Proprietary` license versus the Apache-2.0 source, for CI
    installs.

**Both:**

23. No questions probe exists yet, so `escalation.observedOn` is unset.
    `bun run smoke:seven` and `bun run smoke:questions` need a real login
    before `verifiedAgainst` can be set (`AGENTS.md`).
24. Whether either ACP implementation offers a context-usage request.

## 8. Sources

All fetched or run on 2026-09-16.

**Cursor:**

- `https://cursor.com/docs/cli/overview`, `.../installation`, `.../using`,
  `.../headless`, `.../changelog`, `.../acp`
- `https://cursor.com/docs/cli/reference/parameters`, `.../output-format`,
  `.../authentication`, `.../permissions`, `.../configuration`
- `https://cursor.com/docs/rules`, `https://cursor.com/llms.txt`
- `https://cursor.com/install` (install script)
- Tarball
  `https://downloads.cursor.com/lab/2026.09.10-fd3934a/darwin/arm64/agent-cli-package.tar.gz`
  (`--help`, `--version` and unauthenticated runs observed)
- Logged-in capture spike 2026-09-16 (agent `2026.09.10-fd3934a`):
  `spike-report.md` (probes 09-38) and `notes-session.md` (probes 01-08),
  with raw captures under `out/`
- Cursor Terms of Service (updated 2026-09-03), reverse-engineering clause

**Grok Build:**

- `https://docs.x.ai/build/overview`, `.../cli/headless-scripting`,
  `.../modes-and-commands`, `.../enterprise`, `.../features/sandbox`
- `https://x.ai/build/changelog`, `https://x.ai/cli/install.sh`,
  `https://x.ai/cli/stable`, `https://x.ai/cli/alpha`
- Binary `https://x.ai/cli/grok-1.0.30-macos-aarch64` and npm
  `@xai-official/grok` platform packages (runs observed)
- `https://github.com/xai-org/grok-build` at `4827113`. User guides under
  `crates/codegen/xai-grok-pager/docs/user-guide/`: 02, 10, 11, 12, 14, 15, 17,
  18, 22, 24, 26. Source: `xai-grok-pager/src/headless.rs`,
  `headless/reducer/acp.rs`, `headless/ext_protocol.rs`, `session_startup.rs`,
  `cli.rs`, `sampling/error.rs`, `xai-grok-login/src/auth_method.rs`,
  `xai-grok-tools/src/registry/types.rs`, `tool_taxonomy.rs`
- `https://registry.npmjs.org/@xai-official/grok`,
  `https://registry.npmjs.org/grok-cli`

**hcn** (not changed): `AGENTS.md`, `CONTEXT.md`,
`docs/adr/0007-narrow-scope-one-process-at-a-time.md`,
`src/knowledge/descriptor.ts`, `src/knowledge/muse.ts`,
`src/knowledge/pi.ts`, `src/knowledge/native-approvals.ts`,
`docs/harness-updates.md`.
