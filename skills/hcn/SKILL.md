---
name: hcn
description: "Operate hcn across Claude, Codex, Pi, Muse, Cursor, Antigravity and Popeye: headless runs, native terminal resume, saved transcripts, event streams and invocation refusals."
metadata:
  upstream: https://github.com/dungle-scrubs/harness-cli-normalizer
---

# hcn

One CLI, seven harnesses. `hcn run <harness> "prompt"` launches claude,
codex, pi, muse, cursor (Cursor CLI, binary `agent`), antigravity
(Antigravity CLI, binary `agy`), or popeye (binary `popeye`) headless with
normalized flags, a ratified defaults profile, and a single NDJSON event
stream out.

Use **hcn 0.6.21 or newer**, the verified compatibility baseline for the
five previously shipped harnesses. Antigravity requires a build whose run
help lists `antigravity` and whose `hcn ls` output includes that harness.
The version in `hcn ls` identifies the descriptor verification anchor; it
is not an exact version requirement for support.
On a new installation or after an upgrade, run
[scripts/check-claims.sh](scripts/check-claims.sh). Resolve any failed or
blocked check before relying on this skill. To check a local build directly,
run `HCN_BIN=/absolute/path/to/dist/cli.js scripts/check-claims.sh`. Keep the
per-feature support checks below.

**This skill runs the CLI; it never shells out to a harness directly.**
A raw `claude -p` / `codex exec` call forfeits the defaults profile,
provenance, refusal diagnostics, tool floors, and the unified exit-code
contract - everything below exists so the caller does not re-derive it.

For native terminal resume or launch provenance, read
[interactive control](references/interactive.md) before invoking the operation.

Saved model settings can be inspected and fingerprint-checked on Codex and Pi
in builds whose native-settings help lists both. Read
[saved settings](references/interactive.md) before using either operation.
Pi 1.0 requires a model when a provider is supplied: use
`--provider <provider> --model <model>`, or a provider/model selector.
A provider-only invocation remains a native failure.

Before selecting a newer Claude model, check `hcn inspect claude --json`:
`vocabulary.models` lists explicit IDs, and `vocabulary.aliases` shows each
alias's current target. An alias can move between generations; use a listed
explicit ID to retain an older generation. Native CLI version and account
access still determine whether the provider accepts that model.

For permission-preserving headless continuation or answering a live native
approval, read [native approvals](references/native-approvals.md). The opt-in
transport retains its own exact-session admission and decision channel.

## The headless command shape

```bash
hcn run <harness> [flags] "prompt" [ -- <native harness args> ]
```

Read stderr alongside stdout: provenance lines (`provenance: key = value
(tier)`) and divergence reports (`divergence: profile "sandbox" not
expressible on pi`) land there in both render modes, never on stdout.

Headless exit codes: **0** clean (including a turn that ended by ASKING - done
cause `awaiting-input`), **1** any failure (native, timeout, limit,
transport), **2** hcn refused the invocation itself (structured - never
parse prose; the hint and support list are fields), **4** hcn's own crash
(internal bug): an `internal` failure plus a `done` pair with cause
`crash` reach stdout when `--json` was set, and the process exits 4. A
dispatch-level usage error (unknown command or harness) with `--json` in
argv also writes the `failure`/terminal pair (exit 2), so a parser never
sees an empty stream. Every invocation appends a start and end line to a
durable command ledger (`hcn/commands.jsonl` under `$HCN_STATE_DIR`, else
`$XDG_STATE_HOME`, else `~/.local/state`); a start with no end is the
trace of a killed invocation.

## Defaults and config

Every launch resolves through one chain:

```
args  >  .hcn/config.json (git root)  >  ~/.config/hcn/config.json  >  profile  >  harness
```

The profile pins: effort medium, sandbox workspace-write (codex and
antigravity) and context window 272000 (codex and popeye; claude keeps its
native default), discovery on, autonomy
off, memory off, write/shell true (named, emitting nothing). Codex accepts
`--context-window <tokens>` from 1 through 272000 (config: `contextWindow`).
In builds whose run help lists `--autocompact`, Claude accepts 100000 through
1000000 and renders that native flag. It sets an auto-compact window;
hcn adds no request-token or cost enforcement. There is no launch default. A bare
claude run keeps claude's native default unless a flag or config sets it.
Native env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` overrides the flag;
Claude also provides `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT`; their interaction
with this flag was not tested. Native percentage controls can trigger compaction
earlier. Popeye accepts 1 through 10000000.
In those builds, `hcn session` spawns also accept the flag, with the same
validation and no default. Resume and session spawns use explicit flags,
not the config's `contextWindow`.
Timeout and maxSteps are opt-in only - no default, caller's number
(`--timeout <s>`, 0 disables). Model is
permanently out of profile scope. `hcn run --help` restates all of this
in its Defaults section - quote that, not memory.

Memory controls (builds listing `--memory` in help): Claude disables native
auto-memory through its spawn environment; Codex uses `--disable memories`.
Pi has no built-in memory control, and this does not disable custom memory
extensions. Popeye declares memory a no-op: both values emit nothing. Muse, cursor, and antigravity report divergence for the default and refuse explicit
values. `--memory` removes HCN's disable override; native settings still apply.
Sessions resolve memory at spawn. Resumed runs apply only explicit flags.

Question mode defaults to `ask` (config key `questions`, flag
`--questions ask|assume|none`). See the section
below before delegating judgment-sensitive work.

Delegating work with a specific skill set? `--skills <a,b>` passes the
caller's picks: pi loads exactly those, claude and codex narrow their
registries to them, while muse, popeye, cursor, and antigravity refuse with a hint. Names come from the registry root.
It works on `hcn run` and on `hcn session` too - same
resolution, same refusals; the allowlist is a spawn property, so on a
session it holds across every turn, resume included. The allowlist governs
the harness's skill-loading surface, not the filesystem: pi and codex have
no runtime skill tool, so a worker with file tools can still read skill
files off disk.

Tool grants use hcn's canonical names only: `read`, `write`, `edit`,
`shell`, `grep`, `glob`, `list`, `web-fetch`, `web-search`, `subagent`,
`skill`. hcn maps them to each harness (`read` is claude `Read`, pi
`read`; `glob` is claude `Glob`, pi `find`). A native name passed bare
(`Read`, `find`) refuses exit 2 listing the canonical set. `native:<name>`
passes a harness-native or extension tool through untouched and shows up
in provenance. A canonical name the requested harness cannot express
refuses with the nearest control (codex `--sandbox`, muse category
switches, cursor config-file allow/deny lists) - never a silent narrowing.
Extension tools get a name through
config: `"toolMap": {"pi": {"web-search": "web_search"}}` in either tier;
the refusal hint names the key to add. `--access read` is the preset
read-only grant (`read, grep, glob, list, web-fetch, web-search`) rendered
per harness (claude/pi `--tools`, codex `--sandbox read-only`, muse
`--disable-write --disable-shell`; cursor and antigravity refuse - no access arm); it is
mutually exclusive with `--tools` and never re-enables tools switched off
by `--no-tools`.
On pi, `--tools` is a strict allowlist: any rendered list (an explicit
grant or `--access read`) drops the extension and MCP tools pi registered
at run time. A bare pi run renders no list, so a worker keeps them; a pi
delegation that needs `web_search`, `background_task`, or tool-proxy under
a grant must name them (`toolMap` or `native:<name>`).

Project `tools` is grant AND floor: a `--tools` grant exceeding it
refuses naming both sets; an empty floor refuses every grant. Named
toolsets (`"toolsets": {"review": [...]}`) expand from a bare `--tools
review` before the floor check.

Config files hard-fail: unknown key, malformed JSON, or version mismatch
exits 2 naming the offender. Never warn-and-continue a config.

For tool-free naming, first check whether `hcn run --help` lists
`--isolation`. Builds with that option support `--isolation tool-free` on
fresh Claude turns only. It rejects resume, sessions, native passthrough,
explicit tool, skill, access, autonomy, or discovery overrides. Config
defaults for those dimensions yield to isolation; model and effort still
resolve normally. Bare-mode
authentication is required; an OAuth-only setup may fail. An optional
naming caller keeps its fallback. Older builds refuse the unknown flag.

## Reading saved transcripts

For saved messages or tool results, use the passive transcript commands.
`hcn transcript ls` lists saved sessions newest first; `hcn transcript read`
exports one. Narrow a listing with `--since-time <utc-instant>`, the one flag
that makes the call cheaper rather than only the output smaller. Read [references/transcripts.md](references/transcripts.md)
before selecting a native source or consuming bookmarks. Inspect installed
support first; a resume operation is not a transcript read.

## Reading events

Pipe `--json` and consume NDJSON: `identity`, `token`, `message`,
`progress`, `tool`, `compaction`, `question`, `limit`, `error`, `failure`,
`done`. Branch on `failure.class` and `done.cause` (clean, limit, crash,
stall, killed, failed, awaiting-input). The full failure-class list lives
in [references/reference.md](references/reference.md); the branching rule:
a provider-unavailable class reached no verdict on the work, so routing
the same work elsewhere is safe; a work-verdict class (task, budget) means
the model answered and rerouting would hide the error. A `native` failure
is the harness's own error - labeled, with `nativeExitCode` as data; never
confuse it with an hcn refusal (exit 2). An `internal` failure is an hcn
bug, not a harness outcome: non-retryable, process exits 4, report it
rather than rerouting or retrying.

When a turn reports that a native approval, input, or control request
cannot be handled headlessly, report the failure and let the human decide
before retrying. Do not add `--autonomy` on your own and do not
automatically retry to clear it: `--autonomy` grants unattended approvals,
which is the human's call.
Builds with interaction detection stop Claude control requests and Pi RPC
dialogs; Muse uses its read-only pending-request API because exec can omit
requests from stdout. A muse approval whose command asked to run outside
the muse sandbox (a sandbox escalation) ends the turn on the first sample;
its failure names `-- --sandbox-network enabled` first - that passthrough
keeps approvals and the filesystem sandbox - before answering in muse or
`--autonomy`. Codex exec rejects unsupported requests itself, and
Pi print mode returns noninteractive dialog defaults. A completed tool
denial is not a pending approval. Only terminal native outcomes establish
turn failure; informational notices remain notices.

Cursor runs behind a workspace-trust gate: an untrusted directory fails
the turn with failure class `trust-refused` (retryable - route the work
elsewhere or to a trusted directory). Trust a directory by running
`agent` there once outside hcn; `--autonomy` renders `--force`, which
bypasses the gate per run without persisting trust. hcn never passes
`--trust`. Tokens after hcn's bare `--` render as native harness flags
past hcn's own argv with no separator, on every harness; a wrong-harness
flag fails natively (exit 1, native-labeled). Effort on cursor resolves into the
`--model` slug through per-family ladders (`--model gpt-5.2 --effort high`
runs `gpt-5.2-high`); a bare family stem without `--effort` refuses, and
only arg-tier `--effort` enforces. `--sandbox` has no cursor spelling and
refuses; denied tool calls arrive as non-terminal `error` events carrying
a structured `denial` field (`tool`, `reason`) with exit 0.

Antigravity uses `agy --print <prompt> --output-format stream-json` and
maps `--sandbox workspace-write` to its boolean native `--sandbox` flag.
Its model vocabulary is extensible. The listed models were captured on a
free Individual plan and do not claim paid-plan eligibility. Native
non-success `result.status` values fail the turn even when the process
exits 0. Structured `tool_info.error` permission failures emit
non-terminal `error` events with `denial`; model prose never establishes
a denial. HCN caller cancellation outranks Antigravity's shutdown
`context canceled` result, and an HCN wall-clock timeout remains a timeout.
Quota error records remain unqualified because qualification did not
deliberately exhaust the free allowance.

## Delegating with question escalation

A headless worker can ask YOUR user when a genuine decision blocks it:
hcn prepends a protocol contract to the prompt (the transport IS the
prompt - no harness has native question conveyance), and a worker that
must ask ends its turn with a fenced `hcn-question` block. You receive
a typed `question` event (fields `question`, `options`, `recommended` -
structured-first, render prose FROM them), `done` arrives with cause
`awaiting-input`, and the process exits 0: asking is a successful turn.

The doctrine:

1. Read the `question` event's fields; render them through your own
   question tool, or ask in prose when a human is present without that tool.
   Without a human, use the recommended answer only for reversible work
   already within the caller's authority, and record it as machine-made
   wherever the caller's decisions live (the caller's existing decision
   ledger at its known path, when it keeps one), and say where. Shared
   writes or missing authority wait; do not turn a
   recommendation into permission.
2. Resume with the chosen answer:
   `hcn run <harness> --resume <id> --prompt "<answer>"`. The id came
   from the `identity` event of the asking turn; use that confirmed id
   rather than inferring it from the launch arguments.
3. Pass the user's answer verbatim as the resume prompt. hcn prepends
   the preamble again automatically; never re-compose it yourself.
   There is no answer timer: the asking process has already exited and
   the id stays resumable for as long as the harness keeps the session.
   In `hcn session` the process stays alive while it waits, with no idle
   budget of hcn's own - the caller owns any timeout. hcn does not
   validate the answer against `options`, and a resumed turn may ask
   again; cap the ask cycles you are willing to serve (three is a sane
   default). At that cap, return an unresolved owner action or request
   for new authority to the caller. Resume with `--questions assume` only
   for decisions the caller has already authorized the worker to make
   unattended.
4. `--questions assume` (or config `"questions": "assume"`)
   flips the contract to: never ask, state the assumption, continue.
   Use it for fully unattended chains. No `question` event ever fires
   in that mode. `--questions none` injects no preamble and also disables
   question detection. Use it when the caller owns the prompt protocol.

Escalation is independent of `--autonomy` by design: autonomy covers
interrupts the harness raises (permission gates), escalation covers
interrupts the model raises (judgment gaps). "Tools free, judgment
supervised" is `--autonomy --questions ask`; fully unattended is
`--autonomy --questions assume`. Never read a question event as a
permission request - the preamble forbids the worker that confusion.

The same protocol works in LIVE sessions with hcn >= 0.4.3:
`hcn session <claude|pi|antigravity|popeye|codex>` keeps ONE process for the whole conversation,
and a worker's ask does not exit it. The turn ends `awaiting-input`,
the CLI renders the question as a pickable menu (recommended starred),
you pick a number or type an answer, and it flows back as the next
message on the same session - no exit, no resume, no context reload.
pi sessions run over `--mode rpc`; claude and Antigravity sessions run
over stream-json (JSONL both directions); codex sessions run `codex
app-server` (newline-delimited JSON-RPC over stdio, one process, many
`turn/start` calls). A program driving a session from another
process uses `hcn session <h> --json` instead of the REPL: NDJSON commands
on stdin, control events (`session`, `turn`, `disposition`, `closed`) on
stdout - schema in [references/reference.md](references/reference.md).
If a program sends while a Pi turn is live, HCN maps that send to Pi's native
`steer` command, so it changes the current turn. The machine surface waits for
Pi's command response before reporting `started`; a native refusal reports
`rejected` with reason `native-rejected`. HCN does not queue it.
Codex sessions do the same with `turn/steer`: a mid-turn send joins the
RUNNING turn under codex's `expectedTurnId` precondition, and a send that
arrives after the native turn ended reports `rejected` (`native-rejected`)
- codex has an out-of-band `codex queue` CLI for next-turn messages, but it
is not reachable through the session protocol, so HCN never reports a queue
disposition.
Take the live channel when you have it;
the run/resume protocol remains the cross-harness baseline (muse/cursor
have no session mode).

## Resume-last

`hcn run <harness> --resume-last "prompt"` resumes the harness's most
recent session in the exact spawn cwd without naming an id. Per-harness
render: claude `--continue --fork-session`, codex `exec resume --last`,
pi `--continue`, cursor `--continue` (`--force` joins after `--model`
when autonomy is on); muse refuses exit 2 (`unsupported-option`, option
`resumeLast`) - re-enter with `hcn run muse --resume <id>` using the
stored identity id. Mutually exclusive with `--resume` /
`--session-id`; refused on `hcn session`, with `--native-approvals`,
and with `--native-settings-fingerprint`.

Antigravity also renders `--continue`. Google documents a fresh
conversation when its workspace cache is missing or stale. A named unknown
conversation ID was observed to start fresh and announce a different ID.

Every resume-last turn emits the fixed pre-spawn warning plus a
`store root <root> for scope <cwd>` diagnostic as early non-terminal
`error` events before any harness output, and warns (never refuses)
when the per-cwd store directory is absent (claude, pi, and cursor
only - codex files no per-cwd directory). The `identity` event carries
`resumeLast: true`: the announced id MAY be a fresh session or another
run's session. On claude the announced id is the fork id
(`forked most-recent session as <id>`); elsewhere the render reads
`resumed most-recent <id>`. Scope is the exact spawn cwd - a
subdirectory run never sees the parent directory's session. A run from
inside a live session in the same directory re-enters that session;
claude forks instead, so the parent file is never written, though the
child still inherits its history.

No-session shapes: claude, codex, and pi start a fresh session with
exit 0 under native defaults (no profile); cursor fails exit 1 with
`No previous chats found.` (also the wrong-store-root symptom),
classified native before the trust gate. Callers that need strict
continuation store ids and use `--resume`. Preview with
`hcn inspect <harness> --argv --resume-last --prompt "preview only"`; cursor `--effort` needs
a slugged `--model` alongside it.

## When a flag refuses

A refusal is a diagnostic that names its remedy. Read the `hint:` line
first - the nearest control on YOUR current harness - then
`supported on:` for the cross-harness list. A native spelling typed before `--` gets
recognized and redirected (`--allowedTools` on codex points back to
`--tools`). Do not switch harnesses on a refusal unless the work
genuinely needs the other harness.

## Output

**Artifact:** one completed harness turn. **Where:** stdout carries the
NDJSON event stream (`--json`) or rendered text; stderr carries the
provenance lines and divergence reports; the exit code carries the
verdict (0 clean, 1 failure, 2 hcn refusal, 4 internal crash - an
`internal` failure with `done.cause: "crash"`). **Contains:** the events
above, ending in `done` with its cause, and the session id in the
`identity` event for resumes. **Not:** any judgment on the worker's
answer, and no state of hcn's own between runs - session continuity
belongs to the harness, reached through `--resume`, `--resume-last`,
or `hcn session`.

## Reference

For the full flag table, per-dimension support matrix, event schema,
and failure taxonomy: [references/reference.md](references/reference.md).
Verify against the installed CLI with `hcn <cmd> --help` and the
descriptor dump `hcn inspect <harness>` - the skill's copy can drift
behind a release; the CLI cannot.
