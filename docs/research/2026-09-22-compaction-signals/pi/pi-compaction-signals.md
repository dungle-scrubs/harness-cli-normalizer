# What a headless hcn turn can see from Pi while compaction runs

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research for [#232](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/232).
Branch `research/compaction-pi`. Probes run 2026-09-22 against pi 0.87.0 on
darwin-arm64, model `zai/glm-5.3` (1M context window).

## The answer first

**Pi's headless JSON stream already carries a dedicated, complete compaction
signal.** The ticket's open question - "whether anything is emitted live on
stdout is unknown" - resolves positively. `pi -p --mode json`, the exact
invocation `src/knowledge/pi.ts` builds, emits two records:

- `compaction_start` when compaction begins, carrying `reason`
  (`"manual" | "threshold" | "overflow"`).
- `compaction_end` when it ends, carrying the whole compaction payload: the
  summary text, `firstKeptEntryId`, `tokensBefore`, `estimatedTokensAfter`,
  the summarization call's `usage`, and `details`.

The gap is on hcn's side, not pi's:

| Surface | State |
|---|---|
| pi stream | Emits `compaction_start` / `compaction_end`. Observed. |
| `src/interpretation/content.ts` (`pi` decoder, lines 161-207) | Handles `tool_execution_start`, `message_update`, `message_end`; every other record falls through to `return []` at line 207. Both compaction records are discarded. |
| `src/knowledge/pi.ts:129` | `nativeContextManagement: null`, which `src/knowledge/descriptor.ts:571-576` defines as *unknown support*. This probe establishes the fact: pi runs auto-compaction in `headless-turn` and `headless-session` modes. |

So the design work in #236 does not need a new observation channel for pi. It
needs hcn to stop dropping two records it already receives.

**No shipped source was changed by this research**, per the brief. The two rows
above are reported, not fixed.

## Sub-question 1: what the stream emits in the compaction window

**Nothing, between the two bracketing records.** Every stdout line was
timestamped at arrival (`stamp.py` in each capture directory writes a
`{"t": <seconds since probe start>, "line": ...}` sidecar), so the silence is
measured, not assumed.

| Probe | Shape | Window | Lines strictly inside the window |
|---|---|---|---|
| B | 3 prompts, one process | 6.941 s | 0 |
| E | 1 prompt, hcn resume grammar | 7.065 s | 0 |
| F | `--mode rpc`, 1 prompt | 10.0 s | 0 (35 `get_state` responses the probe itself requested) |

No assistant-shaped record, no status record, no heartbeat, no progress record.
A reader that only watches for `message_*` records sees a 7-to-10-second stall.
A reader that watches record types sees `compaction_start`, then silence, then
`compaction_end`.

### Verbatim records

`compaction_start` - `findings/captures/probe-b/stream.ndjson:66` (identical at
`probe-e/step2.ndjson:2` and inside `probe-f/rpc-stream.ndjson:15`):

```json
{"type":"compaction_start","reason":"threshold"}
```

`compaction_end` - `findings/captures/probe-b/stream.ndjson:67`, one line,
reproduced here with the 1010-character `summary` elided at the marked point
(the capture holds it in full):

```json
{"type":"compaction_end","reason":"threshold","result":{"summary":"No prior history.\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\nThe user sent a large machine-generated synthetic filler block (\"SYNTHETIC-FILLER-BLOCK-OTTERPOP\") explicitly labeled as car […elided…]","firstKeptEntryId":"436ffedd","tokensBefore":58656,"estimatedTokensAfter":39452,"usage":{"input":18768,"output":377,"cacheRead":0,"cacheWrite":0,"reasoning":169,"totalTokens":19145,"cost":{"input":0.0262752,"output":0.0016588,"cacheRead":0,"cacheWrite":0,"total":0.027933999999999997}},"details":{"readFiles":[],"modifiedFiles":[]}},"aborted":false,"willRetry":false}
```

### Where the records sit in the event order

Position depends on which threshold check fires, and both positions were
observed. This matters for a consumer that keys off turn boundaries.

Probe E (`findings/captures/probe-e/step2-timed.jsonl`), one prompt through the
resume grammar - compaction runs **before the turn exists**, between the session
header and `agent_start`:

```
   0.463  session
   0.619  compaction_start
   7.684  compaction_end
   9.698  agent_start
   9.698  turn_start
  11.522  message_end
  11.546  turn_end
  11.547  agent_settled
```

Probe B (`findings/captures/probe-b/stream-timed.jsonl`), three prompts in one
process - compaction runs **after a run completes**, between `agent_end` and
`agent_settled`:

```
   7.059  turn_end
   7.059  agent_end
   7.060  compaction_start
  14.001  compaction_end
  14.004  agent_settled
  14.004  agent_start      <- the next run
```

Both match pi's documented trigger points: "Pi also checks before a new user
prompt and performs final-attempt overflow recovery after the low-level run
ends" (`docs/compaction.md:37`, shipped in the installed package). A threshold
compaction therefore can land outside any `agent_start`/`agent_settled` pair, so
a consumer that only reads records between those two markers can miss it
entirely.

## Sub-question 2: live on the stream, or only post-hoc in the session file?

**Live on the stream. The session-file `compaction` entry itself is never
streamed, but `compaction_end` carries the same content.**

Three separate facts:

1. **The compaction entry is written to the session file.** Probe B's session
   file `findings/captures/probe-b/sessions/2026-09-22T09-13-33-561Z_01a0c864-5479-75eb-b4b8-ae9cf1bb9048.jsonl:11`
   holds `{"type":"compaction","id":"e1ceb97d","parentId":"872c7f78","timestamp":"2026-09-22T09:13:47.463Z",…}`
   with `firstKeptEntryId`, `tokensBefore`, `fromHook`, `details`, `usage`,
   `summary` - the shape `src/interpretation/transcript/pi.ts:112-142` already
   reads.

2. **That entry does not arrive as an `entry_appended` record.** The stream
   carried three `entry_appended` records in probe B, all
   `{"type":"custom","customType":"tasks-state"}`; the session file holds the
   same three plus a fourth custom entry and the `compaction` entry, which
   appear on no stream record. The implementation agrees: the four
   `_emit({type:"entry_appended", …})` sites in
   `dist/core/agent-session.js` (lines 159, 487, 680, 2419) cover the cache
   warmer, boundary drafts, recovery `context_edit` omissions, and
   extension-appended custom entries. `appendCompaction` (line 2219, and line 1933 on the manual path) is not one
   of them.

3. **`compaction_end.result` carries the entry's content instead, byte for
   byte.** A direct comparison of probe B's file summary against its stream
   summary returns `identical: True`, 1010 characters on both sides; the
   streamed `firstKeptEntryId` (`436ffedd`), `tokensBefore` (58656), `details`
   and `usage.totalTokens` (19145) all match the file entry. Only `id`,
   `parentId`, `timestamp` and `fromHook` are file-only.

Ordering: the file write happens first. `dist/core/agent-session.js` calls
`sessionManager.appendCompaction(...)` at line 2219 and emits `compaction_end`
at line 2242. The observed gap is under a millisecond (file timestamp
`09:13:47.463Z`, `compaction_end` at probe-relative `t=14.001` against a start
of `09:13:33Z`), and both happen while the process is still running. A stream
consumer learns the outcome at the same instant a file reader could, and learns
that compaction *started* about 7 seconds earlier - which the file never tells
it.

## Sub-question 3: the RPC surface

Conditional in the brief on "if no live signal exists on the stream". A live
signal does exist, so this is recorded as a reading, not as a recommendation.
Design belongs to #236.

**RPC pushes the same two events, so polling is not the mechanism there
either.** `dist/modes/rpc/rpc-mode.js:265` subscribes to the same
`session.subscribe` feed that print mode uses at `dist/modes/print-mode.js:85`,
and both pass each event through the identical `toJsonEvent`
(`dist/modes/json-event.js`), which alters only `message_update`. Probe F
observed `compaction_start` and `compaction_end` on the RPC stream at
`findings/captures/probe-f/rpc-stream.ndjson:15` and `:51`.

**`get_state.isCompacting` tracks the window, at whatever cadence the caller
chooses.** Probe F polled `get_state` every 250 ms across a compaction
(`findings/captures/probe-f/poll-log.jsonl`, rendered in `timeline.txt`):

```
   2.866  prompt sent
   2.867  event  compaction_start
   3.121  poll   get_state -> isCompacting=True  isStreaming=False rtt=0.0
   …      33 further polls, all isCompacting=True, rtt <= 0.001 s
  12.728  poll   get_state -> isCompacting=True  isStreaming=False rtt=0.0
  12.867  event  compaction_end
  13.009  poll   get_state -> isCompacting=False isStreaming=False rtt=0.001
  14.881  event  agent_start
```

Three readings from that:

- There is **no built-in cadence**. `get_state` is a request/response command;
  pi pushes no periodic state record. The cadence is entirely the caller's.
- The RPC command loop **stays responsive during compaction**: 35 round trips
  inside the 10-second window, every one answered in 1 ms or less. Compaction
  does not block the command channel.
- `isCompacting` flipped true within 254 ms of `compaction_start` and false
  within 142 ms of `compaction_end`; both gaps are bounded by the 250 ms poll
  interval, so the flag is consistent with the events rather than lagging them.

`isCompacting` is only reachable in `--mode rpc`. A `-p --mode json` headless
turn has no command channel, so for the headless turn the events are the only
surface.

### A documentation/implementation disagreement worth knowing before #236

`docs/rpc.md:1105` states: "If compaction was aborted, `result` is `null` and
`aborted` is `true`." The implementation emits `result: undefined` on all three
failure and abort paths (`dist/core/agent-session.js:1975`, `:2086`, `:2261`),
and both modes serialize through `JSON.stringify`
(`dist/modes/print-mode.js:86`, `dist/modes/rpc/jsonl.js:9`), which **drops
undefined-valued keys entirely**. On the wire the `result` key is therefore
absent, not null. Standing: read from the implementation and the serializer, not
observed - this probe never aborted or failed a compaction. A consumer that
tests `result === null` would not detect an aborted compaction.

## Method

### Versions

| Thing | Value | Source |
|---|---|---|
| Installed pi | **0.87.0** (released 2026-09-21) | `pi --version`; `package.json` of `@earendil-works/pi-coding-agent`; captured per probe in `pi-version.txt` |
| `src/knowledge/pi.ts:17` `verifiedAgainst` | **0.86.1** (released 2026-09-20) | repository source |
| Difference | one minor release | see below |

The 0.87.0 changelog entry (shipped `CHANGELOG.md`, lines 3-40) changes nothing
about `compaction_start` / `compaction_end` or the `CompactionEntry` shape. Its
compaction-adjacent items are retain-none compaction input
(`appendCompaction(summary, null, tokensBefore)`), context-edit accounting
fixes, and post-run recovery omissions. The findings above should hold on
0.86.1, but they were **observed only on 0.87.0**; nothing here re-verifies the
descriptor against 0.86.1 or justifies bumping `verifiedAgainst`.

One adjacent item does touch this repository, flagged and not acted on: 0.87.0
lists as a breaking change "Added `ContextEditEntry` to the exported
`SessionEntry` union." `src/interpretation/transcript/pi.ts:176-191` maps
`context_edit` to `"unknown"`, because the metadata list there is
`["model_change","thinking_level_change","label","session_info"]`. Standing:
read from the changelog and this repository's source; no `context_edit` entry
appeared in any capture.

### Invocation

Every probe drove the installed `pi` binary directly, with `stdin` at
`/dev/null` (`src/knowledge/pi.ts` records that pi reads stdin even in `-p`
mode). Base flags are hcn's own: `-p --mode json`. Probes C, D and E use hcn's
resume grammar verbatim - `pi --session-id <id> -p --mode json "<prompt>"`
(`src/knowledge/pi.ts` `resume.flag`, `resume.extraFlags`).

Added flags, and why each one is not load-bearing for the result:

- `--model zai/glm-5.3` - pins the 1M-context model the repo's RPC fixtures
  already use, so the threshold arithmetic is stable.
- `--session-dir sessions` - keeps each probe's session store inside its own
  capture directory. Nothing here surveys an existing native store, so the
  repository's store resolver (`src/cli/store-root.ts`) is not involved.
- `--approve` - **required**, see below.

### How compaction was triggered

Auto-compaction fires when `contextTokens > contextWindow - reserveTokens`
(`docs/compaction.md:30-33`). `reserveTokens` defaults to 16384, so against a 1M
window the natural threshold is ~983.6k tokens. Rather than build 983k tokens of
filler, each probe sets `reserveTokens` in a project
`.pi/settings.json` to move the threshold down:

| reserveTokens | Threshold | Used by |
|---|---|---|
| 988000 | 12k | probe A (never applied - see below) |
| 950000 | 50k | probes B, C |
| 900000 → 970000 | 100k → 30k | probe E, F (rewritten between steps) |
| 970000 | 30k | probe D |

`keepRecentTokens` is 500 in every probe (default 20000), so the cut point
leaves something to summarize.

Filler is synthetic only: generated marker lines
(`FILLER-<TAG>-00042 alpha bravo charlie …`) inside a labeled
`SYNTHETIC-FILLER-BLOCK`, about 69k characters (~17.2k tokens) per prompt. The
prompts are kept beside each capture as `prompt-OTTERPOP.txt` and
`prompt-BADGERFIG.txt`.

### The trust gate - why `--approve` is required

Probe A was the calibration run and produced **no compaction**, because pi
ignored the project settings file entirely. `docs/settings.md:16`:

> Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a
> trust prompt. Without an applicable saved trust decision, they use
> `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore
> those project resources, while `always` trusts them. Pass `--approve`/`-a` or
> `--no-approve`/`-na` to override project trust for one run.

Every later probe passes `--approve`. `--approve` changes which settings file is
read; it does not touch event emission. The same threshold could be set in
`~/.pi/agent/settings.json` with no extra flag, which would leave hcn's argv
untouched; that route was not taken because it would modify the machine's global
pi configuration.

Probe A is kept as evidence: it is the run that shows the gate, and it supplied
the baseline context measurement (22.3k tokens of system prompt and discovered
context files, 17.2k tokens per filler prompt) that the later thresholds are
built on.

### Probe index

All under `findings/captures/`. Each directory holds its own `run.sh` (or
`run.py`), the settings it used, the prompts, raw NDJSON, a timestamped sidecar,
stderr, exit code, and the resulting session store. Everything is machine output
except `argv.json`, which each script writes as a hand-written record of the
invocation; the two that exist were reformatted to satisfy `biome check`, which
lints the whole tree. No captured output was touched. `pnpm check` passes on
this branch.

| Probe | Purpose | Compaction | Outcome |
|---|---|---|---|
| A | Calibration, threshold 12k | no | Project settings ignored; exposed the trust gate; measured the token baseline |
| B | 3 prompts in one process, threshold 50k | yes, `threshold` | Compaction between `agent_end` and `agent_settled`; 6.941 s of silence |
| C | Two processes, resume grammar, threshold 50k | yes, in step 1 | Showed the end-of-run check consumes the threshold, leaving step 2 below it |
| D | Resume a session directory copied to a new cwd | no | Negative result: pi created a **new** session file under the same `--session-id` instead of resuming the copy. Recorded as a limit, not a finding about compaction |
| E | Single-prompt turn, threshold lowered between steps | yes, `threshold` | The load-bearing probe: compaction inside one hcn-shaped resume turn, before `agent_start`; 7.065 s of silence |
| F | `--mode rpc`, `get_state` polled every 250 ms | yes, `threshold` | `isCompacting` window measured against the events |

### Environment noise to discount

One user-level pi package was loaded in every probe:
`@quintinshaw/pi-dynamic-workflows` (`pi list`). It is the source of the
`tasks-state` custom entries and the `extension_ui_request` events in the
captures. It appends no compaction content and registered no
`session_before_compact` handler (`fromHook: false` on the compaction entry), so
it does not affect the finding. A clean environment would show the same
compaction records without those extras.

## Limits of this evidence

- **One model, one provider.** Everything is `zai/glm-5.3`. The compaction
  records are emitted by pi's session layer, above the provider, so provider
  dependence is unlikely - but unverified.
- **One reason value.** Every observed compaction has `reason: "threshold"`.
  `"manual"` (`/compact`) and `"overflow"` are read from
  `dist/core/agent-session.js:1868` and `:2171` and from `docs/rpc.md:1069-1107`,
  not observed here.
- **No failure or abort observed.** The aborted/failed `compaction_end` shape,
  including the `result`-key disagreement above, is a source reading.
- **No `willRetry: true` observed.** That arm needs an overflow recovery, which
  a threshold trigger does not produce.
- **Threshold reached artificially.** The trigger was moved down with
  `reserveTokens` rather than by filling a 1M window. The check is the same code
  path either way (`docs/compaction.md:30-37`), but no probe here crossed a
  default threshold.
- **`interactive` mode untested.** `nativeContextManagement.modes` is evidenced
  for `headless-turn` (probes B, C, E) and `headless-session` (probe F) only.
- **pi 0.86.1 not re-tested.** Observations are from 0.87.0 only.
- **Capture size.** The captures total about 7.1 MB, mostly the `agent_end`
  records and session files that carry the synthetic filler verbatim.

## A note on where this file lives

The brief specified `findings/pi-compaction-signals.md`, and that is where it
is. The repository's existing convention for research notes is
`research/<topic>/` (`research/transcripts/claude-codex.md`,
`research/transcripts/pi-muse.md`, each beside its probe script and results
JSON). Whoever lands this may want it at `research/pi-compaction/` instead; the
captures are self-contained and move with it.
