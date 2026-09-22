# Compaction and occupancy signals in Claude's live headless stream

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research resolution for [What compaction and occupancy signals does Claude's
live headless stream emit?](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/230).
Probed on 2026-09-22 against the installed Claude Code CLI, version 2.1.278.

Every claim below carries its standing. **Observed** means a probe in
`captures/` shows it. **Documented** means a source that owns the behavior
states it; the owning source here is either the shipped 2.1.278 bundle's own
schema text or a page on code.claude.com, named per claim. **Unverified**
means neither.

## The finding that reframes the question

The stream pushes compaction **events** and no occupancy **level**.

A consumer reading `claude -p ... --output-format stream-json` stdout learns
that compaction started, that it finished, and how many tokens it dropped. It
never learns how full the context is until compaction has already happened.
There is no periodic occupancy record, no percentage, and no window size
outside the end-of-turn `result` record.

The occupancy number does exist and is reachable, but as a **pull on a
different channel**: a `control_request` with subtype `get_context_usage`,
answered with a full per-category breakdown including `percentage`,
`maxTokens` and `autoCompactThreshold`. That channel needs
`--input-format stream-json`, which turns the run into a bidirectional
session. It is not available to a plain `-p` caller, and nothing pushes it.

So the shape of any compaction-status event hcn designs (ticket #236) is
constrained by this: on the Claude side, occupancy before the fact is a
request hcn would have to make, not a value hcn can passively observe.

A second thing worth carrying into that design: **the live record and the
saved transcript row disagree on field casing for the same data.** The stdout
record is `compact_metadata` with `pre_tokens` / `post_tokens`; the transcript
JSONL row is `compactMetadata` with `preTokens` / `postTokens`. Same values,
different keys. `src/interpretation/transcript/claude.ts:96` reads the
camelCase form, which is correct for transcripts and wrong for the stream.

## Method

**Version.** Installed CLI `claude --version` reports `2.1.278 (Claude Code)`
at `/Users/kevin/.local/share/claude/versions/2.1.278`. The descriptor
`src/knowledge/claude-code.ts:31` records `verifiedAgainst: "2.1.278"`.
**No difference:** the probe ran against exactly the version the descriptor is
verified against.

**Instrument.** The native CLI, driven directly. This is a raw-stream
question, so hcn would only add a layer between the probe and the bytes under
study. Flags were confirmed against `claude --help` on the installed binary.

**Probe script:** [`captures/probe.sh`](captures/probe.sh). Common argv for
every turn:

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --model sonnet --tools '' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --permission-prompts none --safe-mode
```

Probe working directory: `findings/captures/probe-cwd`.

**How compaction was forced.** Two ladders of synthetic turns, then one
resumed turn with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` exported for that child
process only. No installed setting was changed.

- Ladder A: `bash probe.sh build` ran turns 1 to 4 under a fixed
  `--session-id`, each carrying 260 lines of filler marked `HERON-517` plus a
  planted token `HERON-517-SECRET=TANAGER-9042`. `bash probe.sh compact` then
  ran turn 5 with the override, asking only for the planted token back.
- Ladder B: `build2` / `compact2` repeated the same shape under a fresh
  session id, with stdout piped through
  [`captures/tee-ts.py`](captures/tee-ts.py) so each record's arrival time was
  recorded, and with `--include-partial-messages` added.

**Why the override fires.** The threshold arithmetic is in the bundle
(`bundle-extracts.txt`, anchor "autocompact threshold arithmetic"):

```js
function Zde(e,n){let r=e-13000,s=n.testPctOverride;
  if(s!==void 0&&!isNaN(s)&&s>0&&s<=100)return Math.min(Math.floor(e*(s/100)),r);
  return r}
function uHe(e,n){return Math.min(e-Math.round(e*n.precomputeBufferFraction),Zde(e,n))}
```

`testPctOverride` is read straight from `process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
**Documented (bundle):** the `autocompact_state` schema describes `threshold`
as "effective\_window minus the summary buffer, lowered further by
CLAUDE\_AUTOCOMPACT\_PCT\_OVERRIDE when set."

**Effective window on this machine, and why it is not the model default.**
This machine's `~/.claude/settings.json` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000`
in `env`, so the probe children inherited it. **Observed:** the
`get_context_usage` response reports `maxTokens: 500000`,
`autocompactSource: "env"`, and, with no percentage override,
`autoCompactThreshold: 467000`. With the override at 2, the formulas above put
the threshold at `min(floor(500000 x 0.02), 487000)` = 10,000 tokens.
**Observed:** compaction fired at 42,375 tokens of context, which clears that
threshold, and did not fire on turns 1 to 4 at the same size under the
unmodified 467,000-token threshold. The two agree.

**Redaction, stated plainly.** The captures are raw CLI stdout with exactly
one class of field replaced: the `output` / `stdout` / `stderr` text of
`hook_response` and `hook_progress` records. This machine's `SessionStart`
hooks print a host roster and live tool-session URLs, and this repository is
source-public. The replacement keeps the original length and names the field:
`<redacted: local SessionStart hook stdout, 10070 chars>`. The transformation
is in [`captures/redact-hook-output.py`](captures/redact-hook-output.py) and
touched no other field of any record. No compaction, status, usage or
`control_response` field was altered.

**Two probe artifacts that are not stream captures.**

- [`captures/bundle-extracts.txt`](captures/bundle-extracts.txt), produced by
  [`captures/extract-bundle-strings.py`](captures/extract-bundle-strings.py)
  over `strings -a` of the 2.1.278 binary (a bun-compiled Mach-O with the
  JavaScript bundle embedded; the bundle self-reports
  `GIT_SHA 809c980662e3525645594dc8b74f78c38a348db1`,
  `BUILD_TIME 2026-09-19T01:12:36Z`). Every schema quotation below comes from
  there.
- [`captures/transcript-compact-row.json`](captures/transcript-compact-row.json),
  the saved transcript's own compaction row. Its path was resolved through
  this repository's resolver, not a hardcoded default, per AGENTS.md:
  [`captures/locate-transcript.ts`](captures/locate-transcript.ts) calls
  `transcriptStoreRoot("claude", ...)` from `src/cli/store-root.ts`.

## 1. Every record in the compaction window

**Observed.** The clean crossing is [`captures/turn-05.ndjson`](captures/turn-05.ndjson),
16 records. In order, with the hook records collapsed:

| # | Record | Meaning |
|---|---|---|
| 1-4 | `system/hook_started`, `system/hook_response` (x2 each) | `SessionStart:resume` hooks for the resumed turn. Not compaction-related. |
| 5 | `system/init` | Session metadata. Carries no context-window field. |
| 6 | `system/status`, `status: "compacting"` | Compaction starts. |
| 7 | `rate_limit_event` | Plan rate-limit utilization. Not context occupancy. |
| 8-11 | `system/hook_started`, `system/hook_response` (x2 each), `hook_name: "SessionStart:compact"` | `SessionStart` hooks re-fire with the `compact` matcher. |
| 12 | `system/status`, `status: null`, `compact_result: "success"` | Compaction finished, and how it ended. |
| 13 | `system/compact_boundary` | The boundary record with `compact_metadata`. |
| 14 | `user`, `isSynthetic: true` | The summary, injected as the replacement first message. |
| 15 | `assistant` | The turn's answer, produced after the boundary. |
| 16 | `result`, `subtype: "success"` | End of turn. |

The three compaction-bearing records, verbatim from `turn-05.ndjson`:

```json
{"type":"system","subtype":"status","status":"compacting","session_id":"146fcef1-dce9-46f3-857b-b3d76d3bf358","uuid":"a6488b40-4803-44dd-b92b-29ca8beb9c52"}
```

```json
{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"146fcef1-dce9-46f3-857b-b3d76d3bf358","uuid":"2126b7ec-2d9a-4056-bb8f-c9015ebce8cb"}
```

```json
{"type":"system","subtype":"compact_boundary","uuid":"6e3ba91d-a99c-471a-88ac-7eff80fa2fb5","compact_metadata":{"trigger":"auto","pre_tokens":42375,"post_tokens":1793,"cumulative_dropped_tokens":40582,"duration_ms":25052,"preserved_segment":{"head_uuid":"d9fc301a-10ae-4217-af4c-c959af5683d7","anchor_uuid":"54aaa0be-aded-42f9-9a8d-7d0af54e0f10","tail_uuid":"61a5706c-9bf2-4ed6-b2ea-3d5d842e2594"},"preserved_messages":{"anchor_uuid":"54aaa0be-aded-42f9-9a8d-7d0af54e0f10","uuids":["d9fc301a-10ae-4217-af4c-c959af5683d7","c59cd2ca-3af9-4ad3-8d64-898c1eaf2dfe","b2547a58-fa72-43ba-8f7d-d4b4059c6ecc","61a5706c-9bf2-4ed6-b2ea-3d5d842e2594"],"all_uuids":["d9fc301a-10ae-4217-af4c-c959af5683d7","c59cd2ca-3af9-4ad3-8d64-898c1eaf2dfe","b2547a58-fa72-43ba-8f7d-d4b4059c6ecc","61a5706c-9bf2-4ed6-b2ea-3d5d842e2594"]}},"logical_parent_uuid":"61a5706c-9bf2-4ed6-b2ea-3d5d842e2594","session_id":"146fcef1-dce9-46f3-857b-b3d76d3bf358"}
```

The replacement `user` record follows immediately. Its `uuid`
(`54aaa0be-...`) **is** the `anchor_uuid` in `compact_metadata`, so the
boundary record and the summary it produced are linked by identifier rather
than only by adjacency. Its full text is in `turn-05.ndjson`; it opens
`"This session is being continued from a previous conversation that ran out of
context."` and ends with the instruction to resume without acknowledging the
summary.

**Documented (bundle).** The `compact_metadata` field meanings, from the SDK
stream schema's own `.describe()` text:

- `trigger`: `"manual"` or `"auto"`.
- `pre_tokens`, `post_tokens`: integers, `post_tokens` optional.
- `cumulative_dropped_tokens`: "Running total of context tokens compaction has
  removed so far, across this and every earlier compaction. Each contribution
  is approximately pre\_tokens - post\_tokens." Marked `@internal`.
- `duration_ms`: integer. Marked `@internal`.
- `messages_summarized`, `user_context`, `precomputed`,
  `pre_compact_discovered_tools`: optional, all marked `@internal`. None
  appeared in either crossing.
- `preserved_segment`: "Relink info for messagesToKeep... Unset when
  compaction summarizes everything (no messagesToKeep)."
- `preserved_messages`: "Ordered messagesToKeep UUIDs. Supersedes
  preserved\_segment - readers look up each UUID directly and relink uuids\[i\]
  to uuids\[i-1\] (uuids\[0\] to anchor\_uuid) instead of walking the
  parentUuid chain."

`precomputed` is the field that would say the summary was built in the
background at the threshold and swapped in when prompt-too-long fired. It was
absent from both crossings, which is consistent with a threshold-triggered
compaction rather than a reactive one. Its absence is **observed**; what its
presence would mean is **documented (bundle)**.

**Documented (bundle).** The `system/status` record's schema is
`{type:"system", subtype:"status", status: <enum>, permissionMode?, compact_result?: "success"|"failed", compact_error?: string, uuid, session_id}`,
and the status enum is the union of the literals `"compacting"`,
`"requesting"`, and one further variant. So `compact_result: "failed"` with a
`compact_error` string is the documented failure shape. **Unverified:** no
probe here produced a failed compaction.

**Observed negative: `system/status` appears only on a compacting turn.**
Across all ten captured turns, the eight non-compacting turns carry zero
`system/status` records; turn 5 carries two and turn 15 carries three. A
consumer cannot treat `system/status` as a general turn-phase signal on the
strength of these runs; on this evidence it shows up when compaction does.

**Observed negative: no `auto_compact_*` record of any kind.** Grepping all
ten captures for `auto_compact`, `autocompact_state`, `microcompact`,
`compact_progress` and `effective_window` returns nothing.

Two of those are worth separating, because their absence means different
things:

- `autocompact_state` is a real frame type in 2.1.278 and carries exactly the
  numbers a consumer would want (`enabled`, `effective_window`, `threshold`,
  `enforced`, `source`). **Documented (bundle):** it is `@internal` and
  "emitted by CCR workers at boot, whenever the resolved state changes... Thin
  clients adopt it so the '% until auto-compact' indicator counts down to the
  worker's real compaction trigger." It is a remote-worker frame. **Observed:**
  it does not appear in a local `-p` run.
- `microcompact_boundary` exists in the product's transcript vocabulary, but
  `subtype:R("microcompact_boundary")` appears zero times in the whole 2.1.278
  bundle, so it is not a member of the stdout stream's schema union in this
  version.

**Observed, and a caveat on the method.** `--safe-mode` did not suppress this
machine's configuration in `-p` mode. The `system/init` record of every probe
turn lists 18 skills, 4 plugins and 4 agents, and the `SessionStart` hooks
ran. The probes therefore ran with the machine's user configuration active.
That inflates the baseline context and explains the `SessionStart:compact`
hook records inside the compaction window; it does not affect which record
types compaction emits.

## 2. Occupancy on stdout

**Observed: no occupancy level is pushed.** Across all ten captures, the
strings `used_percentage`, `remaining_percentage`, `percentage`,
`context_window`, `effective_window` and `autocompact_state` appear zero
times. `system/init` carries no context-window field.

**Documented (bundle): a context `used_percentage` belongs to the statusline
channel, not the stream.** The one builder of a context-fill `used_percentage`
in the bundle is
`function XUe(e,n){...used_percentage:r.used,remaining_percentage:r.remaining}`,
whose output is assembled into the statusline JSON payload alongside
`workspace`, `output_style`, `cost` and `rate_limits`. The name occurs
elsewhere in the bundle only inside those `rate_limits` windows
(`five_hour`, `seven_day`, `spend_limit`), where it means plan utilization. The bundle's own
statusline documentation block describes it:

```
"context_window": {
  "total_input_tokens": number,   // Input tokens currently in the context window (incl. cache reads/writes)
  "total_output_tokens": number,  // Output tokens from the most recent API response
  "context_window_size": number,  // Context window size for current model (e.g., 200000)
  "current_usage": { ... } | null,
  "used_percentage": number | null,      // Pre-calculated: % of context used (0-100), null if no messages yet
  "remaining_percentage": number | null  // Pre-calculated: % of context remaining (0-100), null if no messages yet
}
```

This confirms the ticket's premise: the statusline is a different channel, and
it is where that field lives.

**Observed: occupancy is derivable from the stream, after each API response.**
Two stdout records together give a fraction:

- Every `assistant` record carries `message.usage`. Their sum
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` is
  the occupancy of that request. `turn-04.ndjson` gives `2 + 9175 + 33147 = 42324`.
- The `result` record carries `modelUsage["claude-sonnet-5"].contextWindow`,
  observed as `1000000`.

The derivation checks out against the boundary record: `compact_metadata.pre_tokens`
in the very next turn is `42375`, within 51 tokens of the 42,324 derived from
the previous turn's `usage`. **Two limits on that derivation.** It is
retrospective, arriving only after a response. And `contextWindow` is the
model's window, 1,000,000 here, while the window autocompact actually measures
against was 500,000, set by `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. A consumer
dividing `usage` by `contextWindow` would have computed 4% occupancy on the
turn that compaction fired at.

**Observed: the pull channel returns the full breakdown.** Sending a
`control_request` on a `--input-format stream-json` session returns it on
stdout as a `control_response`. Probe:
[`captures/ctl-probe.sh`](captures/ctl-probe.sh), capture:
[`captures/ctl-get-context-usage.ndjson`](captures/ctl-get-context-usage.ndjson).
Request sent:

```json
{"type":"control_request","request_id":"req_ctx_1","request":{"subtype":"get_context_usage","detail":"summary"}}
```

Response payload, abridged to the numeric fields (categories, `gridRows`,
`memoryFiles`, `agents` and `messageBreakdown` are in the capture):

```json
{"totalTokens":7673,"maxTokens":500000,"rawMaxTokens":500000,
 "autocompactSource":"env","percentage":2,"model":"claude-sonnet-5",
 "autoCompactThreshold":467000,"isAutoCompactEnabled":true,
 "apiUsage":{"input_tokens":2,"output_tokens":10,"cache_creation_input_tokens":3124,"cache_read_input_tokens":4547}}
```

**Documented (bundle):** the request is
`{subtype:"get_context_usage", detail?: "summary"|"full"}`, described as
"Requests a breakdown of current context window usage by category", where
`'full'` counts each category with the token-count API and `'summary'` answers
from the last response's usage and local estimates. **Note the internal
inconsistency in the answer:** `totalTokens` is 7,673 while the `used`
categories sum to 15,445. That is consistent with the documented split, the
total coming from the last API response and the categories from local
estimates, but the probe did not test `detail: "full"`, so treat the two
numbers as answering different questions rather than one being wrong.

**Observed: the pull is not available to a plain `-p` caller.** It requires
`--input-format stream-json`. The bundle carries the refusal string
`"get_context_usage is not supported in this context (onGetContextUsage callback not registered)"`
for hosts that have not registered the callback; the stdio bridge used here
did answer, so `-p` with stream-json input is enough. **Unverified:** whether
a host can issue it mid-turn and get an answer while a turn is in flight; the
probe sent it before the user message.

**One more number on the stream, which is not occupancy.** `rate_limit_event`
records carry `unifiedWindows.five_hour.utilization` and `seven_day.utilization`.
These are plan rate-limit fractions, not context fill. They appear on every
turn and would be easy to mistake for occupancy.

**Observed, mid-turn token counts:** `system/thinking_tokens` records carry
`estimated_tokens` and `estimated_tokens_delta`. **Documented (bundle):**
"estimated\_tokens is the running total for the current thinking block...
Approximate progress for spinners/pills, not the authoritative billed
output\_tokens." Output-side only; it says nothing about context fill.

## 3. What the stream shows during the pause

**Observed: a status record, then complete silence, then the whole tail at
once.** Arrival times from [`captures/turn-15.timing.tsv`](captures/turn-15.timing.tsv),
seconds from the first byte of stdout:

```
0.805  system/init
0.807  system/status        (status: "requesting")
0.811  system/status        (status: "compacting")
                  <-- 28.1 seconds, nothing on stdout -->
28.912 rate_limit_event
28.917 system/hook_started  (SessionStart:compact)
28.953 system/status        (compact_result: "success")
28.964 system/compact_boundary
28.965 user                 (the summary)
29.747 stream_event         (the answer begins)
```

So: **a gap, opened by a status record.** `status: "compacting"` at 0.811 is
the last thing a consumer sees for 28.1 seconds. Nothing is emitted while the
harness summarizes. `compact_metadata.duration_ms` for this crossing is
`28107`, which matches the measured gap.

This matters for a supervising caller: on a lowered threshold the pause was
25 to 28 seconds, and on a full-size window it would be longer. A consumer
with an idle-output timeout shorter than the compaction duration would kill a
healthy run. The `status: "compacting"` record is the only warning it gets,
and it arrives before the silence, not during it.

**Observed:** `--include-partial-messages` adds nothing to the window. The 34
`stream_event` records in `turn-15.ndjson` all arrive after the boundary, as
deltas of the post-compaction answer. None carries occupancy.

**Documented (bundle), and not seen here:** an `@internal` note describes a
`compact_progress` event, "Emitted while compaction is running (hook phase,
compact start, compact end). Distinct from system/compact\_boundary, which
reports the post-compaction transcript boundary after completion." It is an
internal `QueryEvent`, it is not in the stdout schema union, and it did not
appear. Whatever fills the 28-second gap internally, the stdout stream does
not carry it.

## Reproducibility of the crossing

Both ladders compacted, with `pre_tokens` identical at `42375` and
`post_tokens` of `1793` and `1859`. The record sequences match, except that
ladder B emitted an extra `status: "requesting"` before `status: "compacting"`.

Ladder A's turn 5 answered with the planted token `TANAGER-9042`, so the
summary carried it across the boundary. Ladder B's turn 15 declined to repeat
the value, treating it as a secret. **This is a model-behavior difference on
the same prompt, not a stream difference**, and it does not affect any record
above. It does mean the boundary-crossing recall check succeeded once out of
two attempts, for a reason unrelated to compaction.

## What the public documentation says

**Documented, and thin.** [The agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction),
accessed 2026-09-22, is the only page found that names the record: "The SDK
emits a message with `type: "system"` and `subtype: "compact_boundary"` in the
stream when this happens (in Python this is a `SystemMessage`; in TypeScript
it is a separate `SDKCompactBoundaryMessage` type)." It documents the
existence of the record and nothing about its payload.

**Silence is the finding on the rest.**

- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless),
  accessed 2026-09-22, enumerates stream record types in detail for
  `system/init`, `system/api_retry`, `system/plugin_install` and
  `permission_denied`. It does not mention compaction, `system/status`, or any
  context-occupancy field.
- [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python),
  accessed 2026-09-22: no `compact_boundary`, no `compact_metadata`, no
  occupancy-carrying message type, no `system/status`, no `autocompact_state`.
- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript),
  accessed 2026-09-22: **search limitation, not a negative result.** The fetch
  returned a truncated page, and `SDKCompactBoundaryMessage` was not in the
  returned portion. Whether that page documents the `compact_metadata` fields
  is **open**.

So the field-level meanings quoted in section 1 come from the shipped bundle's
own schema text, which outranks a doc page anyway, but a reader should know
they are not published on the pages checked.

## Limits of this evidence

- **One version, one model, one machine.** Claude Code 2.1.278, `--model sonnet`
  resolving to `claude-sonnet-5`, macOS arm64, first-party provider. Nothing
  here is evidence about Bedrock, Vertex, Foundry, or another model's window.
- **A synthetic threshold, not a full window.** Both crossings ran at a
  10,000-token threshold against a 500,000-token window on a session holding
  about 42,000 tokens. The record sequence at a genuine near-full window is
  **unverified**, and so is any behavior that depends on real headroom
  pressure, including the `precomputed` background-summary path and the
  reactive prompt-too-long path the `autocompact_state.enforced` field
  describes.
- **No failure case.** `compact_result: "failed"` and `compact_error` are
  documented in the bundle schema and were never produced. The stream's shape
  on a failed compaction is **unverified**.
- **No manual compaction.** `trigger` was `"auto"` in both crossings.
  `trigger: "manual"` via `/compact` is **unverified**.
- **No repeated compaction in one session.** The bundle carries a thrash guard
  ("Autocompact is thrashing: the context refilled to the limit within 3 turns
  of the previous compact") that the probes deliberately stayed clear of by
  using a fresh session for the second crossing. Its stream signature is
  **unverified**.
- **The `-p` run inherited this machine's configuration** despite
  `--safe-mode`, including `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000`, hooks,
  skills and plugins. A clean-room run would have a smaller baseline and a
  different effective window, but the same record types.
- **The captures carry one class of redacted field**, named and reproducible,
  as described under Method.
- **`detail: "full"` on `get_context_usage` was not probed**, so the
  relationship between its `totalTokens` and its per-category sums under that
  mode is **unverified**.

## Captures

All under [`captures/`](captures/).

| File | What it is |
|---|---|
| `probe.sh` | The probe. `build` / `compact` / `build2` / `compact2`. |
| `tee-ts.py` | Records each stdout record's arrival time without altering the bytes. |
| `ctl-probe.sh` | The `get_context_usage` control-request probe. |
| `redact-hook-output.py` | The one redaction applied to the captures. |
| `extract-bundle-strings.py`, `bundle-extracts.txt` | The cited 2.1.278 bundle regions. |
| `locate-transcript.ts`, `transcript-compact-row.json` | The saved transcript's compaction row, via the repo's own store resolver. |
| `turn-01..04.ndjson` | Ladder A, context-building turns. No compaction. |
| `turn-05.ndjson` | **Ladder A, the clean compaction crossing.** |
| `turn-11..14.ndjson` | Ladder B, context-building turns. |
| `turn-15.ndjson`, `turn-15.timing.tsv` | **Ladder B, timestamped crossing with partial messages.** |
| `ctl-get-context-usage.ndjson` | The control-response occupancy breakdown. |
| `turn-*.meta.txt` | Per-turn argv, version, env, exit code, wall time. |
| `session-id.txt`, `session-id-2.txt` | The two probe session ids. |
