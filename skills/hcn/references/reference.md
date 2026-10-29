# hcn reference

Detail behind the SKILL.md body. On-demand only; verify living truth
with `hcn --help` and `hcn inspect <harness>`. Issue numbers refer to
the upstream tracker, dungle-scrubs/harness-cli-normalizer.

## Flag table

On builds whose descriptor includes `launch.stdinPrompt`, Claude requests
above 65,536 UTF-8 bytes travel to the native print-mode process through stdin,
including resumed turns. Small prompts retain their ordinary argv shape.
Use `--prompt-file` to avoid shell argument limits before hcn itself starts.
Claude's native piped-input cap still applies; an input pipe failure is a
typed transport failure, never permission to start an empty task.

| Flag | Scope | Notes |
|---|---|---|
| `--prompt <text>` / `--prompt-file <path\|->` | all | one prompt source; `-` reads stdin |
| `--model <id>` | per-harness vocab | validated; aliases resolve; on cursor only listed slugs run - a bare family stem (e.g. `claude-opus-4-8`) without `--effort` refuses naming that family's slugs |
| `--effort <level>` | all | ladder per harness; profile defaults medium; on cursor the level resolves into the `--model` slug through per-family ladders and only arg-tier `--effort` enforces (profile/config values report divergence) |
| `--sandbox <mode>` | codex, antigravity | codex: read-only, workspace-write, danger-full-access; antigravity: normalized workspace-write renders its boolean `--sandbox`; profile: workspace-write; cursor refuses any value |
| `--context-window <tokens>` | codex, popeye (1-10000000), claude (100000-1000000); run and session | integer 1-272000 on codex (launch default 272000); popeye 1-10000000; claude renders native `--autocompact` (builds whose run help lists it) - an auto-compact window; hcn adds no request-token or cost enforcement - with NO launch default (the profile window does not transfer; claude's native default applies unless a flag or config sets it); native env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` overrides the flag; Claude also provides `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT` (interaction with the flag untested); native percentage controls can trigger compaction earlier; config key `contextWindow` on run launches only (resume and session spawns use explicit flags) |
| `--provider <id>` | pi | pi routes providers; Pi 1.0 requires an accompanying model, or use a provider/model selector; provider-only failures stay native; others refuse with hint |
| `--agent <name>` | claude, antigravity, popeye (codex, muse, cursor refuse exit 2); pi extension-registered (ADR 0010) | select a named agent the harness defines natively - hcn selects, never defines; the name passes through beyond the selector rule, so an unknown name is the harness's own native error (antigravity tolerates one and runs with its default; popeye and claude strictly reject with a typed error and the roster of valid agents); popeye reads from ./.popeye/agents and ~/.popeye/agents (POPEYE_AGENTS_DIR overrides); no stable machine roster exists across harnesses, so `hcn inspect <harness>` `namedAgents` (and `--capabilities`) is the planning surface ; pi's roster fact is machine-conditional: `hcn inspect pi --runtime` runs the declared probe and answers expressible-here / not-here (ADR 0010) |
| `--tools <a,b>` | claude, pi, popeye (muse via category switches; codex, cursor, antigravity refuse) | claude renders an `--allowedTools` grant plus a `--disallowedTools` deny complement; pi and popeye render a strict `--tools` allowlist; canonical names only (`read write edit shell grep glob list web-fetch web-search subagent skill`); `native:<name>` passes through; a configured toolset name expands; `toolMap` config maps canonical -> extension names; cursor allow/deny lives in config files, named in the refusal hint |
| `--exclude-tools <a,b>` | claude, pi, popeye (muse via category switches; codex, cursor, antigravity refuse) | canonical names; complement over the harness's known names; mutually exclusive with --tools |
| `--isolation <tool-free>` | claude, builds listing it in help | fresh turn only; no tools, MCP, instruction files, hooks, or extensions; refuses resume/session/native passthrough and grants; requires bare-mode authentication; invocation-only |
| `--access <read\|write>` | claude, codex, pi, muse, cursor, popeye (antigravity refuses) | preset grant: `read` = read, grep, glob, list, web-fetch, web-search; claude read -> closed `--tools Read,Grep,Glob,WebFetch,WebSearch` set + `--permission-mode dontAsk` + `--disallowedTools mcp__*` (no allow rules; unmatched calls deny; every MCP tool denied, overriding native MCP pre-approvals; the web tools keep native approval semantics - the inventory pre-approves no web requests and confines neither files nor network), write -> `--permission-mode acceptEdits` plus strict native Bash sandbox ([limits](harness-notes.md#claude-write-access)); pi/popeye -> `--tools`, codex -> `--sandbox read-only`/`workspace-write`, muse -> `--disable-write --disable-shell`; cursor read -> `--mode ask --sandbox enabled`, write -> `--force` (unconfined commands, bypasses trust; human authorization required); no default; mutually exclusive with --tools/--exclude-tools (and --sandbox on codex); honors --no-tools |
| `--skills <a,b>` | claude, codex, pi; `hcn run` and `hcn session` | caller-directed skills allowlist; names resolve against the registry root ($HCN_SKILLS_ROOT, default ~/.agents/skills); unknown names refuse exit 2 listing the registry; on a session the allowlist is a spawn property and holds across every turn (resume included); muse, cursor, antigravity, and popeye refuse with a hint (antigravity and popeye sessions refuse the same way rather than open with the full set) |
| `--autonomy` / `--no-autonomy` | claude, codex, muse, cursor, antigravity | profile: off; on antigravity renders `--dangerously-skip-permissions`; on cursor renders `--force`, which also bypasses the workspace-trust gate per run without persisting trust |
| `--questions <ask\|assume\|none>` | all (hcn-owned), run and session | default ask; assume instructs the worker to state assumptions and continue; none injects nothing; question detection only in ask; config key `questions` |
| `--system-prompt <text>` | claude, codex, pi, popeye | replace the built-in prompt; codex accepts text or a path; muse refuses; opt-in |
| `--append-system-prompt <text>` | claude, pi, popeye | append to the built-in prompt; opt-in |
| `--write` / `--no-write` | muse | profile: true (emits nothing) |
| `--shell` / `--no-shell` | muse | profile: true (emits nothing) |
| `--max-steps <n>` | muse, 1-10000 | opt-in; no default |
| `--timeout <s>` | all (hcn-owned) | wall clock, opt-in, 0 disables; SIGTERM then SIGKILL |
| `--no-tools/--no-instruction-files/--no-extensions/--no-skills` | discovery facets | per-harness spellings differ; refusals hint |
| `--cwd`, `--env K=V`, `--resume <uuid>`, `--json` | run control | `--resume` is also the question-escalation answer path |
| `--resume-last` | claude, codex, pi, cursor, antigravity (muse refuses) | most-recent session in the exact spawn cwd, no id; mutually exclusive with `--resume`/`--session-id`; refused on `session`, with `--native-approvals`, and with `--native-settings-fingerprint`; preview with `inspect <harness> --argv --resume-last --prompt "preview only"` |
| `-- <args>` | passthrough | verbatim to harness at the descriptor placement, no separator rendered; failures are native-labeled; a `prompt-joins` harness refuses any tail instead of rewriting the prompt (none today) |

## Defaults, config and tool grants

Every launch resolves through one chain:

```
args  >  .hcn/config.json (git root)  >  ~/.config/hcn/config.json  >  profile  >  harness
```

The profile pins: effort medium, sandbox workspace-write (codex and
antigravity) and context window 272000 (codex and popeye; claude keeps its
native default), discovery on, autonomy off, memory off, write/shell true
(named, emitting nothing). Timeout and maxSteps are opt-in only - no
default, caller's number. Model is permanently out of profile scope.
`hcn run --help` restates the profile in its Defaults section.

Tool grants use hcn's canonical names only. hcn maps them to each harness
(`read` is claude `Read`, pi `read`; `glob` is claude `Glob`, pi `find`).
A native name passed bare (`Read`, `find`) refuses exit 2 listing the
canonical set. `native:<name>` passes a harness-native or extension tool
through untouched and shows up in provenance. A canonical name the
requested harness cannot express refuses with the nearest control (codex
`--sandbox`, muse category switches, cursor config-file allow/deny lists) -
never a silent narrowing. Extension tools get a name through config:
`"toolMap": {"pi": {"web-search": "web_search"}}` in either tier; the
refusal hint names the key to add. `--access read` never re-enables tools
switched off by `--no-tools`.

Project `tools` is grant AND floor: a `--tools` grant exceeding it
refuses naming both sets; an empty floor refuses every grant. Named
toolsets (`"toolsets": {"review": [...]}`) expand from a bare `--tools
review` before the floor check.

`--isolation tool-free` (builds whose `hcn run --help` lists it) rejects
resume, sessions, native passthrough, and explicit tool, skill, access,
autonomy, or discovery overrides. Config defaults for those dimensions
yield to isolation; model and effort still resolve normally. Bare-mode
authentication is required; an OAuth-only setup may fail. An optional
naming caller keeps its fallback. Older builds refuse the unknown flag.

## Resume-last render and hazards

One flag, a different native grammar on each harness. hcn only renders;
the harness picks the session.

| Harness | Rendered most-recent grammar | No prior session in scope |
|---|---|---|
| claude | `--continue --fork-session` | fresh session, exit 0, native defaults |
| codex | `exec resume --last` | fresh session, exit 0, native defaults |
| pi | `--continue` | fresh session, exit 0, native defaults |
| cursor | `--continue` (`--force` joins after `--model` when autonomy is on) | exit 1, `No previous chats found.` (also the wrong-store-root symptom), classified native before the trust gate |
| antigravity | `--continue` | reuses the most-recent native conversation; starts fresh when the workspace cache is missing or stale |
| muse | refuses: `unsupported-option`, option `resumeLast` | re-enter with `hcn run muse --resume <id>` from the stored identity id |

Every resume-last turn is resume-semantics (no defaults profile, so a
silently created session runs native defaults). Scope is the exact
spawn cwd: a subdirectory run never sees the parent directory's
session, and sibling repositories never cross. A run from inside a
live session in the same directory re-enters that session on codex,
pi, and cursor; claude forks under a new id instead, so the parent
file is never written, though the child still inherits its history.
Callers that need strict continuation store ids and use `--resume`.
Cursor `--effort` needs a slugged `--model` alongside it.

On Antigravity, a named unknown conversation ID was observed to start fresh
and announce a different ID.

## Runtime inspection

The operation admission described below applies when Claude descriptor
inspection declares `native-session-auto-compaction`. Earlier builds can
return `unverified-adapter`; consume their actual operation result.

On builds whose inspect help lists `--context`,
`hcn inspect claude --context --model opus --prompt-file request.txt --json`
returns a native estimate of the complete staged prompt, plus executable,
version, observed model, and input-limit provenance. `--resume ID` counts a
non-persistent fork of that native session; it does not alter the original.
The assistant is not queried, although native startup hooks can run. This
supports the Claude headless-turn operation independently of version metadata, including fresh
`--isolation tool-free` summary requests. It does not establish accounting for
an already-running persistent process. Unknown adapters or unusable responses
return unavailable. Callers own their reserve and dispatch policy. The bound
is 8 MiB of serialized prompt, with a 30-second default probe deadline and
bounded cleanup. A positive `--timeout` or configured timeout overrides the
deadline; zero retains the default. Interruption cleans up and exits 1. Native
passthrough and other inspection flags are refused. Usage stays provisional
until output drains and cleanup settles. Query activity, unknown frame
categories, malformed usage and incomplete output invalidate the count.
Known lifecycle frames and successful zero-turn results are permitted,
including nonzero aggregate usage. Startup hooks can still have effects.
Invalid requests exit 2 with the standard failure/done JSON pair. An ordinary
inspection returns one version-1 object with `accounting.status`:
`available` carries `method: "native-context-estimate"`, `model`,
`totalTokens`, `contextWindowTokens`, and `inputLimitTokens`; `unavailable`
carries its typed reason. The input limit respects the native enabled
automatic-compaction threshold. No unavailable result authorizes dispatch.

Codex 0.156.1 supports verified native resume, but its context inspection
returns `unsupported-adapter`. Its native usage updates describe executed
turns, not a preflight count of the pending prompt. Version verification
alone does not establish context-accounting support. Descriptor inspection separately declares `nativeContextManagement`. Every
harness except popeye (null) carries a probed value: claude
`{ kind: "native-session-auto-compaction", modes: ["headless-turn"] }`; codex,
muse and cursor `{ kind: "auto-compaction", modes: ["headless-turn"] }`; pi
`{ kind: "auto-compaction", modes: ["headless-turn", "headless-session"] }`;
antigravity `{ kind: "auto-compaction", modes: ["headless-session"] }`. A mode
absent from `modes` was not probed, so it is not claimed - `interactive` is
absent everywhere. Read descriptor inspection for the actual declaration.
Claude's narrower kind covers native session growth. Callers must still prepare
imported history, and oversized incoming content can fail natively.
Compaction does not promise lossless recall.
Callers may choose native management after executable and mode verification.
This declaration is not a preflight count or a successful budget check.
It is a curated descriptor fact, not an observation that native compaction is enabled.

On builds whose `hcn inspect --help` lists `--runtime`, inspect the selected
executable before a native resume with `hcn inspect <harness> --runtime
--resume <session-id> --prompt <validation-text>`. Pass the intended model,
effort, provider, working folder, and environment overrides. The version-1
JSON response includes redacted argv, the resolved executable path and
version, the adapter's verified version, and resume compatibility.

This runs the executable's version probe, without sending a model turn.
On builds whose runtime help states that all harnesses use invocation support,
resume admission requires a resolved executable and a supported invocation in
the requested mode. Missing or different version metadata does not reject it,
including supported persistent sessions. Older builds can still reject version
drift; read the operation result. Native execution can fail even after admission.
No admission result proves that the native session exists
or contains the caller's expected context. Recheck before each new process.
For persistent resume, add `--mode headless-session`; this uses session
argv and requires a resume ID. It needs no prompt. Only model, effort,
provider, and working folder are accepted for that preview. Unsupported
turn options, environment overrides, interactive mode, and persistent
passthrough are refused. Runtime inspection is mutually exclusive with
`--capabilities`. Its argv is labelled `redacted-preview`, not an executable
command. The version probe has bounded time and output.

## Dimension support matrix

| Dimension | claude | codex | pi | muse | cursor | antigravity | popeye |
|---|---|---|---|---|---|---|---|
| effort | --effort | -c model_reasoning_effort | --thinking | --reasoning-effort | resolves into --model slug (per-family ladders) | --effort | --effort |
| sandbox | - | --sandbox | - | - (on by default, no mode selector) | - (refuses, no headless confinement) | --sandbox for workspace-write | - (refuses) |
| context window | --autocompact (no default) | -c model_context_window | - | - | - | - | --context-window |
| provider | - | - | --provider | - | - | - | - |
| agent | --agent | - (refuses) | --agent (extension-verified) | - (refuses) | - (refuses) | --agent | --agent |
| tools include | --allowedTools (grant) + deny complement | - (refuses, --sandbox hint) | --tools (strict) | category switches (--disable-write/--disable-shell/--disable-web-tools) | - (refuses, config-file hint) | - (refuses) | --tools (strict) |
| tools exclude | --disallowedTools | - (refuses, hint) | --exclude-tools | category switches | - (refuses, hint) | - (refuses) | --exclude-tools |
| access | read: --tools Read,Grep,Glob,WebFetch,WebSearch + --permission-mode dontAsk + --disallowedTools mcp__* (closed set, MCP denied); write: acceptEdits + strict native Bash sandbox | --sandbox | --tools (read subset) | --disable-write --disable-shell | --mode ask --sandbox enabled (read); --force (write, unconfined) | - (refuses) | --tools (read subset) |
| autonomy | --dangerously-skip-permissions | --yolo | - | --yolo | --force (also bypasses trust per run) | --dangerously-skip-permissions | - |
| write | - | - | - | --disable-write | - | - | - |
| shell | - | - | - | --disable-shell | - | - | - |
| maxSteps | - | - | - | --max-model-steps | - | - | - |
| skills allowlist | skillOverrides complement | -c skills.config disable-set | --skill (exact set) | - (refuses, hint) | - (refuses, hint) | - (refuses, hint) | - (refuses, hint) |

Tools defaults: a bare pi run emits no tool list, preserving its native
defaults and any extension or MCP tools. Any rendered pi list (an explicit
grant or `--access read`) is a strict allowlist that drops the extension
and MCP tools pi registered at run time; a pi delegation that needs
`web_search`, `background_task`, or tool-proxy under a grant must name
them through `toolMap` or `native:<name>`.
Skills allowlist rendering:
pi gets `-ns` plus one `--skill <path>` per pick (only those load); claude
gets `--settings '{"skillOverrides":{"<name>":"off",...}}'` turning off
every registry skill except the picks. With explicit Claude write access,
hcn combines this and its sandbox fields in one owned settings object.
Caller-provided inline settings, file paths and passthrough stay unchanged.
[Claude write access](harness-notes.md#claude-write-access) explains native precedence.
Codex gets one
`-c skills.config=[...]` pair per skill, `{path="<root>/<n>/SKILL.md",
enabled=false}` plus `{name="<n>", enabled=false}` for the complement and
the same two entries with `enabled=true` restating the picks (the path
selector covers a frontmatter name that differs from the basename; the
name selector also kills duplicate copies at paths HCN does not know;
restating the picks shields them from a user-level config.toml disable).
Muse, cursor, antigravity and popeye refuse with a hint. Registry names
come from the top level of the root, so a skill that only exists at a
nested path is unknown to the allowlist on every harness. The allowlist
governs the harness's skill-loading surface, not the filesystem: pi and
codex have no runtime skill tool, so a worker with file tools can still
read skill files off disk.

Claude include is a permission grant, not a visibility filter: hcn
renders an exact allowlist there as grant + deny-complement. Pi include
is strict over built-ins; its exclude subtracts from defaults, so hcn
renders pi excludes as computed includes.

## Command ledger

Every invocation appends a start and an end line to `hcn/commands.jsonl`
under `$HCN_STATE_DIR`, else `$XDG_STATE_HOME`, else `~/.local/state`.
A start with no end is the trace of a killed invocation. This diagnostic
ledger is not conversation state.

## Run lifecycle observer (0.9.0+)

Off by default. When `HCN_OBSERVER` names an executable file, `hcn run`
streams `hcn-observer/1` NDJSON to that command's stdin: one `started` line
(invocation id, timestamp, harness, cwd, hcn version), one line per run event
(the `--json` objects minus token and progress), and a terminal `done` (exit
code plus hcn's exit cause, `killed` included). The harness child gets
`HCN_INVOCATION_ID` for correlation. The observer is detached and
fire-and-forget: a missing, failing or slow observer never fails or delays
the run, and an unset variable leaves the run unchanged. Contract:
https://github.com/dungle-scrubs/harness-cli-normalizer/blob/main/docs/observer.md.

## Event schema (NDJSON, --json)

```
{"kind":"identity","sessionId":..,"authority":..,"resumeLast":?,"capabilities":{..}}
{"kind":"token","text":..}              # delta
{"kind":"message","role":..,"text":..}  # complete message
{"kind":"progress","label":..}
{"kind":"tool","name":..,"input":?,"callId":?}
{"kind":"tool-result","name":?,"callId":?,"result":?,"isError":?}
{"kind":"usage","scope":..,"inputTokens":?,"outputTokens":?,"cacheReadTokens":?,"cacheWriteTokens":?,"reasoningTokens":?,"totalTokens":?,"costUsd":?,"inputIncludesCache":?,"callId":?,"model":?}
{"kind":"compaction","state":..,"trigger":?,"tokensBefore":?,"tokensAfter":?,"durationMs":?,"detail":?}
{"kind":"limit","code":..,"message":..}
{"kind":"warning","message":..}       # advisory, not a failure
{"kind":"error","message":..,"denial":?}  # {tool, reason, callId?, inputSummary?}; non-terminal observation
{"kind":"failure","class":..,"retryable":..,"message":..}
{"kind":"question","question":..,"options":[..],"recommended":?}  # issue #41
{"kind":"done","exitCode":..,"cause":..,"failure":?,"completion":?,"denialCount":?}
```

On a nonzero `run` exit, `done.completion` separates delivered output from
process failure: `"native-terminal"` means a successful native turn delimiter
was read, while `"message-delivered"` means assistant text arrived without
confirmed successful turn end. A message can be intermediate; only the former
establishes completion. Neither judges the correctness of the work. Preserve
the delivered result rather than treating the crash as proof no work happened.
Conflicting turn-failure evidence leaves `message-delivered` when assistant
text was observed.
The process still reports its failure (`cause`, `failure`), and hcn exits 1.
`done.exitCode` is the harness's actual exit code, including native failures;
hcn's CLI status is separate. Native detail prefers the first stderr Error
headline (including `Error [ERR_MODULE_NOT_FOUND]:`) over stack frames,
redacted and bounded, with tail lines as fallback.
Persistent sessions keep the existing separation: a completed turn's `done`
stays completed and a later process crash is reported by `closed`.

For a named `--resume` on a create-on-missing harness (pi, muse, cursor),
hcn refuses a checkable missing id before spawn. A confirmed existing id
emits no unknown-id notice. If existence cannot be checked, an early
`warning` with `message` asks the caller to verify the id; it establishes no
failure and does not change `done.cause`. Text mode renders it as an advisory,
not a red error.

A resume-last turn carries `"resumeLast": true` on `identity` (first
announce and attestation re-emit alike): the announced id was picked by
the harness as most-recent, never requested by the caller, and MAY be a
fresh session or another run's session. The fixed pre-spawn warning,
the `store root <root> for scope <cwd>` diagnostic, and the
absent-directory warn (claude, pi, and cursor only) arrive as early
non-terminal `error` events before any harness output. Text mode renders
`forked most-recent session as <id>` on claude (the announced id is the
fork id, never the source id) and `resumed most-recent <id>` elsewhere,
each with `(exact-cwd scope)`.

`compaction` reports that the harness compacted its own context. `state` is
a closed union - `started`, `compacted`, `noop`, `failed`, `aborted` - so
branch with no default arm. `trigger` (`auto`, `manual`, `overflow`),
`tokensBefore`, `tokensAfter` and `durationMs` are present only where the
harness itself reported them; hcn derives none of them, and no harness pushes
a context-occupancy percentage on a live signal. `detail` is the harness's own
reason or error text, so branch on `state` and never on it. `compaction` is
never droppable: `DROPPABLE_KINDS` is `token` and `progress` only.

**Count `compacted`, not `started`.** hcn reports each record the harness
sends, and claude has been observed sending two `compacting` records for one
compaction. A compaction can also arrive BETWEEN turns: pi checks its
threshold before a new prompt, and muse compacts before the turn and blocking,
so in a session the event can reach the caller on a later turn than the one
that triggered it.

Which harnesses report is `capabilities.compactionReporting` on the `identity`
event, and `hcn inspect <harness> --json` prints the same field:

| Harness | Source | States | Tokens |
|---|---|---|---|
| claude | stream | `started`, `compacted`, `failed` | yes |
| pi | stream | `started`, `compacted`, `failed`, `aborted` | yes |
| antigravity | stream | `compacted` | no (duration only) |
| muse | MSP view | `compacted`, `noop`, `failed`, `aborted` | yes |
| codex | - | none | - |
| cursor | - | none | - |
| popeye | stream | `started`, `compacted` | no |

**Null means the harness reports nothing, not that it never compacts.** Codex
and cursor both compact natively and neither says so on any channel hcn reads,
so silence from them is absence of reporting. No per-run `divergence:` line is
written for this.

**Compaction pauses the stream, so set `--stall` above these bands.** Measured:
25-47 s claude, 24-33 s codex, 25-39 s cursor, 4.5-18 s antigravity, 7-10 s pi,
about 7 s muse. A `--stall` inside those bands kills a healthy run
mid-compaction. `--stall` is opt-in and unset by default.

`question` fires when the final assistant message carries a fenced
`hcn-question` block (`{"question","options":[..],"recommended":..}`)
and escalation is on. It always precedes `done`, which then carries
cause `awaiting-input` with exit 0 - the turn succeeded at asking.
Resume with the answer as the prompt; the session id came from the
`identity` event. A malformed block is not a question: hcn emits an
`error` event and fails the turn with a non-retryable `failure.class:
"task"`, so `done` carries cause `failed` and a run exits 1. Do not treat
that turn's text as an answer; wait for `done` and branch on its cause.
Detection is armed
only in `ask` mode - a block emitted under `--questions assume` or
`--questions none` produces no question event.

Failure classes: rate-limit, usage-limit, quota, auth, budget, task,
transport (includes provider WebSocket closes with codes 1001, 1006,
1011, 1012, 1013 and codeless closes; 1000, 1008 and 1009 are not
transport. From hcn 0.9.6 also pi's `WebSocket idle|connect timeout after
<n>ms`, codex's `stream disconnected before completion:` (both at line
start or after an error colon; an auth or limit cause inside still wins),
and an `overloaded_error` / HTTP 529 provider error; from hcn 0.9.8 also
OpenAI's `Our servers are currently overloaded` and `The server is
overloaded`, at line start or after an error colon; also the bare
`terminated` stream error and `An error occurred while processing your
request`, at line start or after an error colon, not mid-sentence prose), unavailable (the
provider cannot serve the requested model or route - model not found, not
loaded, or `'<id>' model is not supported`; retryable, route elsewhere.
Also LM Studio's over-context refusal `number of tokens to keep from
the initial prompt is greater than the context length` only at the start
of the message body - bare, after pi's stopReason error relay, or after
its failed overflow-compaction wrapper; prose that mentions or even
quotes the clause mid-message is not a refusal and stays task),
trust-refused (cursor workspace-trust gate - untrusted directory with no
bypass; retryable, route elsewhere or to a trusted directory; `--force`
bypasses per run), rejected (hcn refusal - see fields
issue/option/supportedBy/hint), native (harness's own error;
nativeExitCode as data), timeout (hcn's wall clock; raise the budget or
split the task), internal (hcn's own bug, not a harness outcome;
non-retryable; the process exits 4 and a `--json` stream gets the
`failure`/`done` pair with cause `crash`).

Codex nonfatal error items remain informational `error` events without
`terminal: true`. Native `turn.failed` and top-level `error` records are
terminal. A warning alone does not make the final `done` fail.

Headless resume passes explicit turn options. Omitted model and effort
follow native behavior; Codex can use current configuration. A confirmed
session ID does not prove that the original model or effort was retained.

Done causes: clean, limit, crash, stall, killed (timeout or signal
death), failed, awaiting-input (issue #41: the turn ended by asking;
exit 0 - resume with the answer). In sessions the same
awaiting-input cause ends the ASKING TURN while the session stays
live (hcn >= 0.4.3, claude + pi; Antigravity in builds whose `hcn ls` reports `antigravity@1.2.7`) - answer via the next send, not a
resume.

### Denial observations

Structured native tool denials emit non-terminal `error.denial` observations.
`tool` is the native tool name. `reason` is native text, or an empty string when
absent, as in Claude's final `permission_denials` entries. Optional `callId`
preserves the native call ID. Optional `inputSummary` is hcn's JSON preview of
native input, bounded to 512 characters. A truncated preview may not be valid
JSON. Assistant prose never establishes a denial.

On builds whose JSON help advertises `done.denialCount`, a positive count
reports emitted denial observations for that turn. Zero is omitted. Repeated
native reports count again, even with the same call ID; this is not a unique-call
count. Session counts reset each turn. Text mode adds `[denials: N]` to the
usual terminal line for a positive count.

Denials do not by themselves fail a turn. Native exit status and `done.cause`
remain unchanged, and a count can also accompany a failed turn. Neither a clean
turn nor a missing count proves tool or work success: the native tool result can
still report failure without a structured denial. Older builds can omit these
fields. The caller owns any judgment or continuation decision.

### Tool results and usage

On builds emitting these kinds, `tool-result` preserves the native result,
including structured extension details; use native `callId` to associate it
with `tool`. Names and error flags can be absent. A clean turn can contain
failed tools; inspect `isError` and the tool's native result contract rather
than treating `done.cause: clean` as workflow success.

`usage.scope` is `message`, `tool`, `compaction`, `turn`, or `session`.
Pi reports completed assistant messages, nested-tool usage and compaction
separately. Claude turn tokens cover the main loop; its session cost and
per-model (`model`) counts include subagents and restored spend. Codex exec
and app-server both report cumulative session snapshots, including earlier
turns on resume; keep the latest snapshot rather than summing or deriving deltas.
Cursor reports turn usage; Antigravity reports cumulative session usage.
Muse and Popeye currently report none. Keep the latest session value for
each metric and model (or overall), never a sum of cumulative snapshots.
Avoid combining overlapping scopes or per-model totals.

Count and price fields are optional. Missing reporting is unknown, not
zero. hcn derives no totals or prices. `costUsd` is a native estimate,
not billing truth. `reasoningTokens` is part of output; cache counts overlap
input when `inputIncludesCache: true` (Codex), are separate when false,
and have an unknown relationship when absent. Results and usage are
lossless; only `token` and `progress` are droppable. Text mode does not dump
the result payloads or usage. Older builds can omit these event kinds.

## Session machine surface (`hcn session <h> --json`)

Turn events are the schema above, unchanged. `--json` adds session
framing around them: NDJSON events on stdout, NDJSON commands on stdin,
for a consumer that owns its input timing. The human REPL without
`--json` is unchanged. First stdout line is `session`; the last is
`closed`.

`hcn session --help` lists the harnesses with a session mode; the others
use the run/resume protocol. Native transports: pi sessions run over
`--mode rpc`; claude and Antigravity sessions run over stream-json (JSONL
both directions); codex sessions run `codex app-server` (newline-delimited
JSON-RPC over stdio, one process, many `turn/start` calls). In the human
REPL a worker's question renders as a pickable menu (recommended
starred); the answer flows back as the next message on the same session.

Control events (stdout):

```
{"kind":"session","sessionId":..,"harness":..,"hcn":..,"questions":"ask|assume|none","origin":"fresh|resumed"}  # first line
{"kind":"turn","turnId":"<sid>:turn-<n>","id":..}   # id = the send that opened the turn
{"kind":"disposition","id":..,"disposition":"started|rejected","reason":?}
{"kind":"closed","exitCode":..,"cause":"clean|limit|crash|stall|killed|failed","failure":?}  # last line
```

Commands (stdin, one JSON object per line; blank lines ignored):

```
{"op":"send","id":..,"text":..}
{"op":"answer","id":..,"text":..}
{"op":"close"}
```

| Rule | Detail |
|---|---|
| disposition | every well-formed send/answer gets exactly one, in command order: `started` (accepted by the harness), or `rejected` with reason `closed` \| `no-open-question` \| `native-rejected` \| `write-failed`. Pi and codex wait for their native command response before reporting the disposition; a busy Pi send uses native `steer` and joins the current turn; a busy codex send uses `turn/steer` under codex's `expectedTurnId` precondition and also joins the RUNNING turn, so a send arriving after the native turn ended reports `rejected`/`native-rejected` (codex's out-of-band `codex queue` CLI is not reachable from the session protocol, so no queue disposition exists). Other harnesses report after their input write and keep their native busy-input behavior. hcn has no send queue; a send that opens a turn carries the input id |
| answer | hcn composes the preamble (`The user answered the question: "<q>" with: <text>. Continue accordingly.`); a plain `send` after a question adds none |
| malformed | not JSON / unknown op / bad id / non-string text -> `error` event, no disposition, session continues |
| close | `close` op or stdin EOF; turn-scoped `done` never ends the process |
| harness exit | a turn still open when the harness exits nonzero with no failure yet gets run mode's stderr-tail classification: cursor's locked-keychain auth phrasing first (`auth` with `authKind: credential-access`, the native sentence and `nativeExitCode` kept - the owner must restore cursor credential access in the context the run executed in; hcn never unlocks keychains), then a transport, unavailable or trust phrasing, else `native` with the tail, else `transport` on empty stderr. The detail is bounded with secret-shaped tokens masked. The `failure` lands in that turn before its `done` (cause stays `crash`), and `closed.failure` carries it. From hcn 0.9.6 a nonzero exit with no open turn also puts a failure on `closed.failure`: one hcn already read from stderr (an auth or limit wall; a limit keeps cause `limit`) first, else the same stderr-tail classification. A codex crash before the session opens creates no turn for its rejected sends |
| refusals | from hcn 0.9.6. A harness that refuses the command that opened a turn, before acknowledging it (pi `prompt` with `success:false`, a popeye prompt error), ends that turn with the classified failure and `done` cause `failed`; a refused later send, even one reusing the id, leaves the turn running. A refused session open (codex `thread/start` error, popeye `create` error) ends the session: codex rejects the waiting sends with `native-rejected`, popeye ends the first waiting send's turn with the failure, and `closed` reports cause `failed` (exit 1) with the failure. A refusal is classified like a terminal error, except that a generic one is `native`, not `task`. A codex app-server that never answers still waits on the caller |
| ids | `session.sessionId` = caller-side handle; `identity.sessionId` (first turn) = harness-confirmed id (pi and codex: minted; codex mints the thread id at open, `--resume <id>` reopens it via `thread/resume`) |
| exit codes | 0 `closed.cause` clean, 1 any other harness or session outcome, 2 refusal before the stream opens, 4 hcn internal crash (an `internal` failure and `closed` with cause `crash`; an hcn bug - report it, do not retry or reroute). A refusal still writes `failure` + `closed cause=failed` on stdout (prose to stderr); a spawn failure writes a `transport` failure + the same `closed`, exit 1. The exit code is set after the terminal line flushes. EPIPE on stdout: hcn closes the session (grace, then signal) and exits 1 |
| flags | `--stall <s>` per-turn inactivity budget (0 disables, no default; expiry ends the turn `stall` and closes the session `stall`); `--provider` pi only, same validation as run; `--agent <name>` claude, antigravity, popeye, and pi (extension-verified at open), rendered at spawn exactly as run renders it; `--effort <v>` (>= 0.6.0) validated against the ladder for the picked `--model` exactly as on run - no default, the harness's own effort applies without it; `--skills <a,b>` (issue #332) the run allowlist at session spawn through the same resolution and render, holding across every turn, antigravity/popeye refusing exit 2 before spawn; `--model` renders per harness (codex sessions take `-c model=<id>` - app-server has no `--model` flag - and sessions render no sandbox flag, so codex's own sandbox default applies). Run-only permission flags (`--access`, `--tools`, `--exclude-tools`, `--no-tools`, `--write`/`--no-write`, `--shell`/`--no-shell`, `--sandbox`, `--autonomy`/`--no-autonomy`) refuse with exit 2 and a typed failure before spawn instead of being dropped silently (issues #386 and #392) |

## Native memory controls

In builds whose help lists `--memory`, `--no-memory` is the launch and
session profile default. Claude renders
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child environment, and Codex
renders `--disable memories`. `inspect --argv` includes an `env:` diagnostic
for descriptor environment settings. HCN stores no memory.

`--memory` and config `memory: true` remove HCN's disable override; they
do not force native memory on. Pi's built-in memory is absent and custom
extensions remain outside this control. Popeye declares memory a no-op:
both values emit nothing. Muse, cursor, and antigravity have no declared
off switch: profile defaults report divergence and explicit values refuse. Resumed
runs bypass the profile and config defaults; session memory resolves once
at spawn through arg, project config, user config, then profile.

## Config files

`~/.config/hcn/config.json` (XDG) and `<git-root>/.hcn/config.json`:

```json
{
  "version": 1,
  "effort": "high",
  "timeout": 1800,
  "tools": ["read", "grep"],
  "toolsets": { "review": ["read", "grep"] },
  "questions": "assume"
}
```

Keys mirror the arg surface (`questions` selects the preamble;
`contextWindow` sets the Codex context window). Project tools = default
grant + floor.
Whole-key precedence; nothing deep-merges. Hard-fail on anything
unknown or malformed, exit 2 naming the key.

## Provenance and divergence (stderr)

```
provenance: effort = "medium" (profile)
provenance: tools = ["read","grep"] (project-config)
divergence: profile "sandbox" not expressible on pi; harness default applies
```

Tiers: arg, project-config, user-config, profile, harness. Divergence
appears only where the profile attempts a dimension the harness lacks -
never for opt-in dimensions, never silently.

## Installed pi models

On builds whose inspect help lists `--models`,
`hcn inspect pi --models --json` prints one JSON line with the installed
provider/model pairs read from pi's registry stores (`models.json` plus
`models-store.json` under `PI_CODING_AGENT_DIR`):
`{ v: 1, source: "stores" | "unavailable", models: [{ provider, model }],
skipped: [...] }`. Per-entry drops are silent; per-store skips are named.
No credentials enter the output. Other harnesses refuse the mode. The
list aids choice; only the native spawn decides availability.

## Saved native transcripts

For inspecting or exporting saved messages and tool results without resuming a
model, read [transcripts.md](transcripts.md). It covers capability inspection,
JSONL framing, native identities, caller-held bookmarks, and source limitations.
