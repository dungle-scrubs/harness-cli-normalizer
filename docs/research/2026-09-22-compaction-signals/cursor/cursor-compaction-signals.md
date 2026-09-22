# What compaction signals does Cursor's live stream emit?

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research ticket [#234](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/234).
Probed 2026-09-22 on this machine against the installed Cursor CLI.

Standing is marked per claim: **documented** (the owning source says it),
**observed** (this probe ran it and saw it), **unverified**.

## The finding that reframes the question

**Cursor's live stream emits no compaction signal at all.** Compaction happens,
and the stream says nothing: no record before it, none during it, none after it.
Across 10 captured compaction boundaries the stream is byte-for-byte silent for
25-39 seconds, then resumes mid-task as though nothing happened (observed).

Two corrections follow, and both change what ticket #236 can build on.

**1. The event names in the brief are Grok's, not Cursor's.** The brief cites
`auto_compact_*` in streaming-json and `system/compact_boundary` in the messages
format as prior Cursor research. Those rows are in the **Grok Build CLI**
sections of `docs/research/2026-09-16-cursor-and-grok-build-harnesses.md`
(section 3.C table at line 567, section 3.H at lines 766-768), not the Cursor
sections. Cursor's own entry, section 2.H lines 422-424, reads: "Context
overflow: manual `/summarize` (alias `/compress`) in interactive mode
(documented). Headless overflow and automatic compaction are unverified." The
Cursor `stream-json` event table in section 2.C lists no compaction row
(documented). No Cursor record named `auto_compact_started`,
`auto_compact_completed`, `auto_compact_failed`, `auto_compact_cancelled`,
`autoCompact` or `compact_boundary` exists anywhere in the installed CLI bundle
(observed; grep over every `*.js` file of both installed versions - 77 files on
`2026.09.15-d2fe57e`, 78 on `2026.09.18-9a7762b` - returned zero hits for each
name).

**2. Cursor does carry a compaction signal - on the hook channel, not the
stream - and its occupancy fields are dead.** The `preCompact` hook fires on
every automatic compaction in headless print mode and delivers a payload whose
schema includes `context_usage_percent`, `context_tokens` and
`context_window_size`. In all 11 live captures **all three are `0`** while
`message_count`, `messages_to_compact` and `is_first_compaction` are populated
(observed). So the occupancy number an hcn `context` event would need is present
in the schema and absent in the data.

The practical consequence for #236: a Cursor compaction-status event cannot
carry a used-percent, and cannot be sourced from the stream at all. What is
available is a hook-channel notification carrying message counts, on the same
channel shape claude uses for its statusline - and, like claude's, it never
appears on stream-json stdout.

## Method

**Versions.** At session start the installed CLI matched the descriptor's
anchor: `agent --version` printed `2026.09.15-d2fe57e`, equal to
`verifiedAgainst` in `src/knowledge/cursor.ts:20` (observed).

**The CLI auto-updated in the middle of the probe run** to
`2026.09.18-9a7762b`, between the calibration run at 09:40 UTC and the first
compaction at 09:42 UTC (observed; `findings/captures/hooks-preCompact.redacted.ndjson`
line 1 reports `cursor_version` `2026.09.18-9a7762b` while the session's own
`sessionStart` payload minutes earlier reported `2026.09.15-d2fe57e`). This is
live evidence of the supervision risk recorded in the prior research (section
2.H: auto-update during CI runs, "no documented or observed way to turn it
off"); a grep of the bundle for update-related environment switches found none
(observed, absence-of-search result, not disproof).

Because of that, the probe was **re-run pinned** to the still-installed
`2026.09.15-d2fe57e` binary by absolute path
(`~/.local/share/cursor-agent/versions/2026.09.15-d2fe57e/cursor-agent`), which
reports its own version correctly when invoked directly. Every substantive
finding below reproduces on the pinned anchor version.

**Triggering compaction.** No client-side threshold mechanism exists. There is
no compaction flag in `agent --help` or in the hidden option set; the model
bracket override documented as `'claude-opus-4-8[context=1m,effort=high,fast=false]'`
is refused pre-flight for the slugs tried (`gpt-5-mini[context=32k]`,
`claude-sonnet-5[context=32k]`, and a bogus-parameter control all exit with
`Cannot use this model: ...` plus the full slug list) (observed). The decision
to compact is not made locally: `context_usage_percent` is read from a
server-supplied value in the hook plumbing, and no threshold constant appears in
the bundle (observed).

So compaction was crossed naturally, with synthetic filler only. Marker-string
filler files (`PROBEMARK FILE nnn BEGIN`, lines tagged `F013L00042`) were
generated by `findings/method/make-filler.py`, and the agent was told to read
them one at a time. Calibration (5 x 20KB) put live context near 47k tokens;
the probe used 14 x 80KB = 1.1MB.

**Commands.** Driver: `findings/method/run-probe.sh`, which runs

```
agent -p --force --output-format stream-json --model gpt-5-mini "<read-every-file prompt>" < /dev/null
```

with stdin closed at spawn (`stdin: "close-required"`), stderr to its own file,
and every stdout line stamped with the millisecond it was received so a pause is
measurable. `AGENT_BIN` pins the version.

**Capturing the hook.** Hooks were installed in the probe workspace at
`.cursor/hooks.json` in the schema the bundle writes,
`{"version":1,"hooks":{"<step>":[{"type":"command","command":"..."}]}}`, for
steps `preCompact`, `sessionStart`, `beforeSubmitPrompt`, `stop`,
`afterAgentResponse`, `sessionEnd`. Each appends its stdin payload to
`findings/captures/hooks-<step>.ndjson` and returns `{}`. Hooks do fire in
headless print mode (observed). `sessionStart`, `sessionEnd` and `preCompact`
fired; `beforeSubmitPrompt`, `stop` and `afterAgentResponse` never fired in
these runs (observed; cause not established).

**Workspace.** A throwaway directory outside the repository, so the session
files under its own `chats/<md5-of-cwd>` slug and no repository file was touched.

**Captures.** `findings/captures/`. Files named `*.redacted.ndjson` have the
account email replaced by `<redacted@example.invalid>`
(`findings/method/redact.py`); the hook payloads carry `user_email`, this
repository is source-public, and the prior research already records these
payload families as not fixture-safe. Nothing else was altered - absolute paths
and session ids are as the harness emitted them. Stream captures are unmodified.

## 1. Every record emitted in the compaction window

**None.** The window is empty.

`findings/method/gap-check.py` correlates each `preCompact` hook timestamp with
the stream and reports every record inside the surrounding gap. Result on the
pinned `2026.09.15-d2fe57e` run (observed):

```
stream gaps longer than 15000 ms: 9

  gap 64204 -> 94898 ms  (30694 ms)
    last record before : tool_call/completed
    records INSIDE gap : 0  []
    first record after : tool_call/started

  gap 137438 -> 169528 ms  (32090 ms)
    last record before : tool_call/completed
    records INSIDE gap : 0  []
    first record after : tool_call/started
```

...and seven more, every one with `records INSIDE gap : 0`. The
auto-updated `2026.09.18-9a7762b` run shows the same shape: its single
compaction sits in a 29,439 ms gap containing zero records.

Verbatim, the two stream lines that bracket the first compaction on the pinned
version (`findings/captures/probe-04-pinned-0915-stamped.ndjson`; the `t_ms`
wrapper is this probe's receive stamp, the `line` value is the harness's own
bytes):

```json
{"type":"tool_call","subtype":"completed","call_id":"call_2odvmM40HDO5naM0msH4AV9R\nfc_0f867451c6cc9a06016ab251068a2c87d28d12486948ca4af8","tool_call":{"readToolCall":{"args":{"path":".../filler/filler-011.txt"},"result":{"success":{"isEmpty":false,"exceed...
```

```json
{"type":"tool_call","subtype":"started","call_id":"call_bD09ZLQZg90VagWkb1Ge28KX\nfc_0e3c66367eccda35016ab25126604887d29eb186481e033e9c","tool_call":{"readToolCall":{"args":{"path":".../filler/filler-001.txt"}},"hookAdditionalContexts":[],"toolCallId":"cal...
```

30,694 ms separate them and nothing is written in between. No field on the
record after the boundary differs in kind from the record before it. The only
visible change is behavioural, not structural: the model resumes at
`filler-001.txt` instead of `filler-012.txt`, because the compaction dropped its
progress.

The record-type census over the whole compacted run confirms no new type
appears (observed):

```
counts: {'system/init': 1, 'user': 1, 'assistant': 16, 'tool_call/started': 15,
         'tool_call/completed': 15, 'thinking/delta': 173,
         'thinking/completed': 2, 'result/success': 1}
```

This matches the emitter in the bundle. The print-mode `sendUpdate` switch
handles eleven ACP cases - `textDelta`, `toolCallStarted`, `toolCallCompleted`,
`failure`, `timeout`, `rejected`, `spawnError`, `permissionDenied`,
`thinkingDelta`, `thinkingCompleted`, `turnEnded` - and writes eight record
shapes: `assistant`, `text`, `tool_call/started`, `tool_call/completed`,
`thinking/delta`, `thinking/completed`, `interaction_query/request`,
`interaction_query/response`. Elsewhere the same module writes `system/init`,
`system/task_notification`, `system/background_shell_timeout`, `retry/*` and
`result/success`. Across that whole module the set of `subtype` string literals
is exactly `{background_shell_timeout, completed, delta, init, request,
response, started, success, task_notification}`, and no `type` or `subtype`
literal names compaction (observed; `7470.index.js` of
`2026.09.15-d2fe57e`). There is no code path that could emit one.

**The signal that does exist is the `preCompact` hook.** Verbatim payload from
the pinned run (`findings/captures/hooks-preCompact.redacted.ndjson` line 2,
email placeholder substituted, otherwise unaltered):

```json
{"conversation_id": "5889b672-714b-4e3d-b33b-759e94aa60da", "generation_id": "cd6f0c30-7c3f-4b5a-a928-e10fbe384269", "model": "gemini-2.5-flash", "trigger": "auto", "context_usage_percent": 0, "context_tokens": 0, "context_window_size": 0, "message_count": 26, "messages_to_compact": 23, "is_first_compaction": true, "session_id": "5889b672-714b-4e3d-b33b-759e94aa60da", "hook_event_name": "preCompact", "cursor_version": "2026.09.15-d2fe57e", "workspace_roots": ["/private/tmp/.../scratchpad/ws"], "user_email": "<redacted@example.invalid>", "transcript_path": "/Users/kevin/.cursor/projects/.../agent-transcripts/5889b672-.../5889b672-....jsonl"}
```

Its schema, transcribed from the protobuf descriptor in the bundle
(`agent.v1.PreCompactRequestQuery`, `index.js` of `2026.09.15-d2fe57e`)
(documented by the implementation):

```
PreCompactRequestQuery
  1  trigger                9   string   "manual" | "auto"
  2  context_usage_percent  1   double
  3  context_tokens         3   int64
  4  context_window_size    3   int64
  5  message_count          5   int32
  6  messages_to_compact    5   int32
  7  is_first_compaction    8   bool
  8  conversation_id        9?  string
  9  generation_id          9?  string
  10 model                  9?  string
  11 model_id               9?  string
  12 model_params           repeated
PreCompactRequestResponse
  1  user_message           9?  string
```

The response arm means a `preCompact` hook may inject a `user_message` into the
compaction. Not exercised by this probe (unverified).

`preCompact` is also the target of Claude-settings hook merging: the bundle maps
Claude's `PreCompact` name onto Cursor's `preCompact` step (observed).

## 2. Every percentage and occupancy field, and what each denotes

All eleven captures, both versions (observed; full table in
`findings/captures/hooks-preCompact.redacted.ndjson`):

| # | version | session | trigger | `context_usage_percent` | `context_tokens` | `context_window_size` | `message_count` | `messages_to_compact` | `is_first_compaction` | `model` |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026.09.18-9a7762b | 0db5b1b9 | auto | 0 | 0 | 0 | 28 | 25 | true | gemini-2.5-flash |
| 2 | 2026.09.15-d2fe57e | 5889b672 | auto | 0 | 0 | 0 | 26 | 23 | true | gemini-2.5-flash |
| 3 | 2026.09.15-d2fe57e | 5889b672 | auto | 0 | 0 | 0 | 28 | 24 | false | gemini-2.5-flash |
| 4 | 2026.09.15-d2fe57e | 5889b672 | auto | 0 | 0 | 0 | 30 | 26 | false | gemini-2.5-flash |
| 5-10 | 2026.09.15-d2fe57e | 5889b672 | auto | 0 | 0 | 0 | 28 | 24 | false | gemini-2.5-flash |
| 11 | 2026.09.15-d2fe57e | 5889b672 | auto | 0 | 0 | 0 | 21 | 17 | false | gemini-2.5-flash |

What each field denotes:

- **`context_usage_percent`** - declared `double`, intended as occupancy at the
  trigger. **Always `0` on the live automatic path** (observed, 11/11, both
  versions). It is not a rounding artefact of a small number: `context_tokens`
  and `context_window_size` are `0` in the same payloads, so the whole occupancy
  triple is unpopulated, not merely small. Whether the manual
  (`trigger: "manual"`) path populates it is **unverified** - that path needs an
  interactive TTY and `/summarize`, which this headless probe did not exercise.
- **`context_tokens`** - declared `int64`, tokens in context at the trigger.
  Always `0` (observed).
- **`context_window_size`** - declared `int64`, the model's window. Always `0`
  (observed). So the payload cannot even be used to derive a percentage
  locally.
- **`message_count`** - messages in the conversation at the trigger. Populated
  and plausible (21-30) (observed).
- **`messages_to_compact`** - how many of those are being compacted away;
  consistently 3-4 fewer than `message_count` (observed).
- **`is_first_compaction`** - `true` on the session's first compaction, `false`
  on every later one (observed; the field works, which is the control showing
  the zeros are real and not a blanket serialisation failure).
- **`trigger`** - `"auto"` in all 11 (observed). The `"manual"` value is
  documented by the implementation but unexercised here.
- **`model`** - **not the session model.** The session ran `gpt-5-mini`; the
  payload reports `gemini-2.5-flash`, the model performing the compaction
  (observed, 11/11). Reading this field as the session's model would be wrong.

No percentage or occupancy field appears anywhere in the stream. `result.usage`
carries `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` and is
**cumulative across the turn's requests**, not a live context measure (observed:
the trivial one-request smoke run reports `inputTokens: 21594`, while the
14-file run reports `inputTokens: 623821, cacheReadTokens: 1200640` - far above
any single request's window). It arrives once, at the end, so it cannot indicate
compaction mid-turn either.

## 3. What the stream shows during the compaction pause

Nothing. Not a heartbeat, not a `retry`, not a `system` liveness line, not a
whitespace byte. stdout is idle and stderr stays empty (0 bytes in both probe
runs, observed). The process does not exit and the turn completes normally
afterwards (`agent_exit=0` on the run that ran to completion, with a final
`result/success`).

**A long gap is not a usable compaction detector.** In the `2026.09.18` run the
compaction gap was 29,439 ms, and a *later* gap in the same run was 757,358 ms
with zero records inside it and **no** compaction - the model was generating a
235KB reply (observed). Both look identical from outside: a silence bounded by
ordinary records. Timing alone cannot separate them.

**Side effects visible only as behaviour.** After each boundary the model
restarted the file sequence from `filler-001.txt`, so the pinned run compacted
nine more times in a loop and never finished; it was stopped deliberately after
11 captures rather than left to burn quota. In one post-compaction record the
model emitted a malformed path blending two session UUIDs. These are model
consequences of losing context, not signals - nothing marks them as
compaction-related.

## The other surfaces, checked

**Saved JSONL transcript.** The hook's `transcript_path` points at
`~/.cursor/projects/<dash-slug>/agent-transcripts/<id>/<id>.jsonl`. Note the
`agent-transcripts/` path segment, which the prior research's recorded shape
(`~/.cursor/projects/<dashSlug>/<sessionId>/<sessionId>.jsonl`) does not have
(observed; whether this is new or was previously mis-recorded is unverified).

The transcript **carries no compaction marker**. A grep for `compact|summar`
returns two hits, both inside this probe's own prompt text (observed). The
boundary is visible only indirectly: at the compaction point two `user` messages
are re-injected - a `<dynamic_tool_catalog>` block and a verbatim repeat of the
original `<user_query>` - and the reads resume after them (observed, lines 14-15
of the 20-line transcript). There is no summary text and no boundary record, and
the same two-message shape is what a session start looks like, so the signal is
ambiguous. The transcript also stores no tool results at all, so what compaction
dropped cannot be read back from it.

**`chats/<md5-of-cwd>/<session>/store.db`.** Resolved through this repository's
own resolver, not a hardcoded path: `transcriptStoreRoot("cursor", ...)` returns
`/Users/kevin/.config/cursor` on this machine (`XDG_CONFIG_HOME` is set), and
the cwd slug is the md5 of the workspace path (observed). The store is SQLite
with two tables, `blobs(id TEXT PRIMARY KEY, data BLOB)` and `meta(key, value)`.

A string search there looks promising and **is a false lead**. The compacted
session's `store.db` contains 312 occurrences of `compaction` and 33 of
`summarized_conversation`. The control disproves it: the trivial smoke session
that never compacted contains the same strings (4 and 1). They are context-
section labels - `system_prompt`, `Tool definitions`, `skills`,
`MCP & dynamic tools`, `subagents`, `summarized_conversation`, `conversation` -
present in every context snapshot, and their count scales with session length,
not with compaction (observed). **No string-level marker distinguishes a
compacted session from an uncompacted one.** The bundle declares a proto field
`message_count_at_last_compaction` on the conversation-state message, which
would be a real marker, but protobuf puts no field names on the wire, so
confirming it means decoding the blobs. Not done (open).

## What this means for the descriptor

Nothing here is a source change; these are the facts a change would rest on.

- **`contextHook`** is `null` for cursor (`src/knowledge/cursor.ts:580`), and
  the live evidence says it should stay `null` **as that field is currently
  typed**. The type is `{ object: string; usedPctField: string }` - a named
  object carrying a used-percent, as claude's statusline
  `context_window.used_percentage` does. Cursor's nearest equivalent has its
  percent field hard-zero, and is a per-compaction notification rather than a
  usage readout, so nothing can be filled in truthfully.
- **`nativeContextManagement`** is `null` (`src/knowledge/cursor.ts:584`) with
  the comment "no window size is known, so no usedPct can be computed". The
  first half now has live evidence: **automatic compaction in
  `headless-turn` is observed**, 11 times, on the anchor version. That matches
  the `{ kind: "auto-compaction", modes: ["headless-turn"] }` shape codex and
  muse already carry. The comment's reasoning about `usedPct` is confirmed and
  now has a sharper cause: the window size is not merely unknown to hcn, the
  harness reports it as `0`.
- **Open question 5** of the prior research ("Does headless mode compact
  automatically on overflow, and what does it emit?") is now answered: yes, and
  it emits nothing on the stream.

## Descriptor drift found while probing

Not part of the question; recorded because the probe established it.

- **Model roster.** Both installed versions list **231** slugs from
  `agent --list-models`; `cursorCli.vocabulary.models` has **223**. The eight
  missing are exactly the `grok-4.7-*` family: `grok-4.7-low`,
  `-low-fast`, `-medium`, `-medium-fast`, `-high`, `-high-fast`, `-xhigh`,
  `-xhigh-fast`. No descriptor slug is absent from the live list. The
  `2026.09.15-d2fe57e` and `2026.09.18-9a7762b` lists are **identical**, so this
  is a server-side roster change under an unchanged `verifiedAgainst`, not a CLI
  version difference (observed).
- **`verifiedAgainst` anchor is not stable under auto-update.** The binary
  behind `agent` moved from `2026.09.15-d2fe57e` to `2026.09.18-9a7762b` mid-probe
  without being asked. Any check that reads `agent --version` can therefore
  disagree with the version that actually served a run minutes earlier.

## Limits of this evidence

- One harness model (`gpt-5-mini`) and one compaction model
  (`gemini-2.5-flash`, chosen by the server). Whether the zeroed occupancy
  fields are model-specific is **unverified**; the compactor was the same in all
  11 captures, so this probe cannot separate "always zero" from "zero for this
  compactor".
- `trigger: "manual"` was never produced. Interactive `/summarize` needs a TTY
  and was out of scope for a headless probe. Whether the manual path populates
  the occupancy fields is **unverified**, and it is the single most likely place
  the fields are live.
- The `PreCompactRequestResponse.user_message` injection arm was not exercised.
- Both probe runs used `--output-format stream-json` without
  `--stream-partial-output`. Token-delta granularity was not captured across a
  boundary; given the emitter has no compaction code path, a compaction record
  appearing only under partial output is very unlikely but **unverified**.
- The ten compactions on the pinned version all come from **one session** in a
  compaction loop, so they are repeated measurements of one situation, not ten
  independent ones. The cross-version replication (captures 1 vs 2) is the
  independent check.
- `store.db` blobs were examined by string search only. A proto-level decode
  could still find `message_count_at_last_compaction` as a genuine post-hoc
  marker. **Open.**
- `beforeSubmitPrompt`, `stop` and `afterAgentResponse` hooks did not fire in
  these headless runs. Cause not established; this probe does not show whether
  they are unsupported headless or misconfigured here. **Open.**
- The probe ran logged in, on a normal account, against `api2.cursor.sh`. No
  limit or error condition was hit.

## Reproducing

```
findings/method/make-filler.py <ws>/filler 14 80
AGENT_BIN=<pinned binary> findings/method/run-probe.sh <ws> <capture-dir> <tag> gpt-5-mini 14
findings/method/summarize-stream.py <capture-dir>/<tag>-stamped.ndjson
findings/method/gap-check.py <tag>-stamped.ndjson <tag>-run.log hooks-preCompact.ndjson <session-prefix>
```

with `findings/method/hooks.json` and `findings/method/hook-capture.sh` copied
into `<ws>/.cursor/`, and `CURSOR_PROBE_CAPTURE` pointing at the capture
directory.
