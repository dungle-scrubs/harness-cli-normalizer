# What compaction signals does Antigravity's live stream emit?

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research ticket [#235](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/235).
Probed 2026-09-22 against the installed Antigravity CLI `1.2.8` on macOS
`darwin_arm64`, free Individual plan, OAuth account (no `GEMINI_API_KEY` set).

Standing on every claim below is one of **observed** (a command was run here and
this is what it printed), **documented** (a first-party Google source says it),
or **unverified**.

The repository keeps research under `docs/research/`. This file sits in the
worktree `findings/` directory the brief named; the captures it quotes are in
`findings/captures/` beside it.

This file cites no git commits. `verify-citations.ts` reports two
`fabricated-hash` failures on line 55; both are segments of the Antigravity
conversation id `a38ad966-490f-4f6f-9a5f-607595a0175f`, which is a UUID the CLI
minted, not a commit. Judged false positives.

---

## 1. The finding that reframes the question

**The brief's premise is a misattribution. `compaction_checkpoints/` is Grok
Build CLI's store, not Antigravity's.**

The brief says Antigravity's store layout contains `compaction_checkpoints/`,
citing `docs/research/2026-09-16-cursor-and-grok-build-harnesses.md`. That line
sits under `## 3. Grok Build CLI` -> `### 3.D Sessions and resume`, describing
`~/.grok/sessions/<URL-encoded cwd>/<session-id>/` (observed, that file, lines
625-630):

> - **Store:** `~/.grok/sessions/<URL-encoded cwd>/<session-id>/` (documented:
>   `grok-guide:17-sessions.md:22-44`).
>   - Files: `summary.json`, `updates.jsonl` (the authoritative ACP log),
>     `chat_history.jsonl`, `system_prompt.txt`, `prompt_context.json`,
>     `tool_definitions.json`, `plan.json`, `rewind_points.jsonl`,
>     `signals.json`, `feedback.jsonl`, `compaction_checkpoints/`, `subagents/`.

That document covers Cursor CLI and Grok Build CLI. It does not mention
Antigravity once (observed: `grep -c -i antigravity` on it returns `0`).
`compaction_checkpoints` appears exactly once in the whole repository, on that
line (observed: `grep -rn compaction_checkpoints docs/ research/ src/ test/`).
No such directory exists in Antigravity's store (observed:
`find ~/.gemini -iname "*compact*" -o -iname "*checkpoint*"` returns nothing).

**The conclusion the premise reached is still right, for a different reason.**
Antigravity does have native compaction, and this probe captured it live. The
evidence is the CLI's own changelog and the probe below, not a store directory.

## 2. Direct answers

### 2.1 Every record emitted in the compaction window

**One record, and it carries no payload** (observed,
`findings/captures/probe-03-stream.ndjson`). All four compaction events in the
8-turn probe emitted exactly this shape and nothing else:

```json
{"event":"step_update","step_update":{"conversation_id":"a38ad966-490f-4f6f-9a5f-607595a0175f","step_index":3,"state":"DONE","step_type":"checkpoint","duration_seconds":5.026148}}
{"event":"step_update","step_update":{"conversation_id":"a38ad966-490f-4f6f-9a5f-607595a0175f","step_index":8,"state":"DONE","step_type":"checkpoint","duration_seconds":18.412776}}
{"event":"step_update","step_update":{"conversation_id":"a38ad966-490f-4f6f-9a5f-607595a0175f","step_index":13,"state":"DONE","step_type":"checkpoint","duration_seconds":6.34049}}
{"event":"step_update","step_update":{"conversation_id":"a38ad966-490f-4f6f-9a5f-607595a0175f","step_index":18,"state":"DONE","step_type":"checkpoint","duration_seconds":10.89551}}
```

`step_type: "checkpoint"` is the whole signal. The record has no summary text,
no before/after token counts, no reason, no threshold, and no `ACTIVE` phase -
only the `DONE` line ever appears. Its `step_index` takes a slot in the same
sequence as `user_input` and `agent_response`.

The summary itself is written to the store, not to the stream. The matching
store record for `step_index: 3` is a `CHECKPOINT`/`SYSTEM` step of 12,606
characters (observed,
`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`,
saved verbatim as `findings/captures/probe-03-checkpoint-steps.jsonl`). It opens:

```
{{ CHECKPOINT 0 }}
 **The earlier parts of this conversation have been truncated due to its long length. The following content summarizes the truncated context so that you may continue your work. **


# User Requests
The following were user requests from the truncated conversation in chronological order:
```

All four store checkpoints have the same three sections - `# User Requests`,
`# Previous Session Summary:`, `# Conversation Logs` - and are numbered
`{{ CHECKPOINT 0 }}` through `{{ CHECKPOINT 3 }}`.

**hcn drops this record today** (observed,
`npx tsx findings/scripts/reader-check.ts`). The antigravity reader in
`src/interpretation/content.ts:267-326` handles `step_type` of `agent_response`
and `tool` and returns `[]` for anything else (the fall-through is line 274):

```
checkpoint/DONE -> []
agent_response/ACTIVE -> [{"kind":"token","text":"WF235-MARK-02"}]
```

Two descriptor fields sit on this evidence.
`src/knowledge/antigravity.ts` declares `nativeContextManagement: null`
(line 90) and `contextInspection: null` (line 89). The probe contradicts the
first for `headless-session`: compaction is native, automatic and observed.
It supports the second: the CLI exposes no headless way to read context
occupancy. Changing either field is the ticket owner's call, not this
document's.

### 2.2 Percentage and occupancy fields

**There are none in the stream.** Across every capture in this probe, the
complete set of numeric fields is (observed,
`findings/scripts/summarize-stream.py`, which enumerates every distinct key path
in a capture):

```
step_update.usage.input_tokens
step_update.usage.output_tokens
step_update.usage.thinking_tokens
step_update.usage.cache_read_tokens
step_update.usage.total_tokens
step_update.duration_seconds
result.usage.{input,output,thinking,cache_read,total}_tokens
result.duration_seconds
result.num_turns
```

They are absolute token counts. No percentage, no occupancy, no context-window
size, no threshold, no remaining-budget field appears anywhere - including on
the `checkpoint` record. `step_update.usage` is that turn's count;
`result.usage` is the running total for the session.

The occupancy view exists, and it is interactive-only. `/context` is refused in
print mode with a purpose-built error (observed,
`findings/captures/probe-05-slash-context.ndjson`, exit code 2):

```json
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"/context is not available in print mode (it opens the interactive context breakdown); pass --disable-slash-commands to send /context to the model as literal text","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
```

The CLI reference documents `/context` as "Open the context usage visualization
panel" (documented:
<https://antigravity.google/docs/cli/reference/>, read 2026-09-22).

**`input_tokens` is not a usable compaction signal.** It falls on compaction,
but it also falls without one. On `gemini-3.8-flash-low` it dropped from 39,697
to 30,991 between turns with no compaction anywhere, because
`cache_read_tokens` went to 36,807 - `input_tokens` excludes cache-read tokens
(observed, `findings/captures/probe-07-stream.ndjson`). Inferring compaction
from a token drop would produce a false positive on every cached Gemini turn.

### 2.3 What the stream shows during the compaction pause

**Silence, then one retrospective record.** Record order around every
compaction is the same (observed, probe-03):

```
step_update  step_index=2   user_input       DONE
step_update  step_index=3   checkpoint       DONE    duration_seconds=5.026148
step_update  step_index=4   agent_response   ACTIVE
```

Nothing is emitted while the pause runs. There is no `ACTIVE` checkpoint record
to announce that compaction started, so a consumer reading the stream live
cannot tell a compaction pause from a slow model until the pause is over. The
`duration_seconds` field on the `DONE` record is the only measure of how long it
took: 5.03 s, 18.41 s, 6.34 s and 10.90 s across the four events.
A separately timed run below measures that gap directly.

A separate run timestamped each line as it arrived, which is what separates "a
silent gap" from "a record emitted when the pause starts" (observed,
`findings/captures/probe-08-stream-timed.tsv`; the first column is seconds since
the `init` line):

```
    0.000  init
    0.027  step_update  0  user_input      DONE
    1.720  step_update  1  agent_response  ACTIVE
    1.771  step_update  1  agent_response  DONE   duration_seconds=1.736   input_tokens=34682
    1.771  result                                                          input_tokens=34682
    1.797  step_update  2  user_input      DONE
    6.273  step_update  3  checkpoint      DONE   duration_seconds=4.489
```

The stream goes quiet at 1.797 s and the next line arrives at 6.273 s - a
**4.476-second gap with nothing on the wire**. The `duration_seconds` on the
record that ends the gap is 4.489 s, which matches the measured gap to within
13 ms.

So the record is written when compaction finishes, and `duration_seconds` is the
pause itself. A consumer gets no advance notice: during a compaction the stream
is indistinguishable from a stalled or slow turn, and the explanation arrives
only afterwards.

This run stopped after the checkpoint instead of finishing its three turns. The
cause was this probe, not the CLI: an earlier attempt at the same run was still
alive and writing to the same output file, and killing it took this run down
with it. The CLI's stderr reads `error: interrupted`
(`captures/probe-08-stream.stderr`), which is a signal, not a service failure.
The arrival timings above were written before that happened and are unaffected.

Two earlier attempts did fail on Google's side, both with
`UNAVAILABLE (code 503): No capacity available`, and are kept as
`captures/probe-08-attempt1-503.tsv` and `captures/probe-08-attempt2-503.tsv`.

One record type surfaced only in those failed attempts: a `step_update` with
`step_type: "error_message"`, emitted with no accompanying terminal `result`
(observed, `captures/probe-08-attempt2-503.tsv`). It is unrelated to compaction
and is noted here only because it is another `step_type` the documented stream
surface does not list.

## 3. Method

### 3.1 Version

| Fact | Value | Standing |
|---|---|---|
| Installed binary | `agy` `1.2.8` at `~/.local/bin/agy` | observed (`agy --version`, `findings/captures/agy-version.txt`) |
| Descriptor `verifiedAgainst` | `"1.2.7"` (`src/knowledge/antigravity.ts:14`) | observed |
| Difference | The installed CLI is one patch release ahead of the descriptor's anchor | observed |

`1.2.8` is the release that changed compaction. Its changelog entries
(documented, `agy changelog`, saved as
`findings/captures/agy-changelog-full.txt` lines 2-3 and 8):

> · Improved context compaction to spread its user-request budget across all
> captured prompts, so a long initial instruction is no longer truncated to a
> small fixed slice when the other prompts in the conversation are short
>
> · Improved context compaction to size summary and truncation budgets from the
> model's full context window instead of the compaction trigger threshold, so
> compacted summaries and background-task lists are no longer prematurely cut
> short
>
> · Fixed a stack-overflow crash when loading or compacting conversations
> containing background-task, subagent-management, messaging, or scheduling
> steps

Because 1.2.8 changed how compaction sizes its budgets, these captures describe
1.2.8 and should not be read back onto 1.2.7.

The changelog also dates the feature: `1.1.3` added "an indicator at each
context-compaction boundary so you can see where earlier compaction happened",
and `1.1.13` fixed transcript corruption "when a background message appended to
it while context compaction was rewriting it" (documented, same file, lines 466
and 316).

### 3.2 How compaction was triggered

No configuration lowers the threshold. `settings.json` has no compaction key
(observed: the user's file holds only `colorScheme` and `trustedWorkspaces`; the
CLI reference's settings table lists no compaction, compression or
context-window key - documented,
<https://antigravity.google/docs/cli/reference/>). No environment variable was
found for it. `/compact`, `/compress` and `/summarize` are not commands: each
was passed to the model as literal prompt text (observed, all three produced a
normal `init` plus a model turn). The print-mode command list is `/agents`,
`/changelog`, `/config`, `/credits`, `/effort`, `/help`, `/hooks`, `/model`,
`/permissions`, `/skills`, `/usage` (observed,
`findings/captures/probe-04-slash-help.ndjson`).

So the threshold was crossed naturally, with synthetic filler. The generator is
`findings/scripts/make-filler-stdin.py`. Each turn carries one block of numbered
marker lines drawn from a fixed 36-word pool, sized to a token target, plus an
instruction to echo one `WF235-MARK-NN` marker. The probe-03 blocks target
20,000 tokens and measured about 22,000 each.

The generator is seeded, and regeneration was checked rather than assumed: both
committed stdin files reproduce byte-identically on Python 3.13.13 (observed,
`cmp` against a fresh run of the exact commands in the capture table).

```bash
# probe-03, the main capture
python3 findings/scripts/make-filler-stdin.py \
  --turns 8 --tokens-per-turn 20000 --seed 235 \
  --out findings/captures/probe-03-stdin.ndjson

agy --input-format stream-json --output-format stream-json \
    --model gpt-oss-120b-medium --disable-slash-commands \
    --log-file <log> \
    < findings/captures/probe-03-stdin.ndjson \
    > findings/captures/probe-03-stream.ndjson

# probe-07, the Gemini negative control
python3 findings/scripts/make-filler-stdin.py \
  --turns 4 --tokens-per-turn 22000 --seed 2350 \
  --out findings/captures/probe-07-stdin.ndjson
# ... same agy line with --model gemini-3.8-flash-low

# probe-08, the arrival-timed run
python3 findings/scripts/make-filler-stdin.py \
  --turns 3 --tokens-per-turn 22000 --seed 23501 \
  --out findings/captures/probe-08-stdin.ndjson
# ... same agy line, piped through findings/scripts/stamp-lines.py
```

Model choice is the reason this was affordable. `gpt-oss-120b-medium` compacted
four times inside eight turns. `gemini-3.8-flash-low` did not compact at all
across four turns and roughly 110,000 tokens of history (observed, probe-07:
zero `checkpoint` records in the stream, and the store transcript holds only
`USER_INPUT` and `PLANNER_RESPONSE` steps).

### 3.3 The full measured sequence

Per-turn `input_tokens` for probe-03, with `cache_read_tokens` zero on every
turn, so no caching confound (observed):

| Turn | Steps | `input_tokens` | `cache_read_tokens` |
|---|---|---|---|
| 1 | 0 user_input, 1 agent_response | 32,282 | 0 |
| 2 | 2 user_input, **3 checkpoint**, 4 agent_response | 54,494 | 0 |
| 3 | 5 user_input, 6 agent_response | 35,701 | 0 |
| 4 | 7 user_input, **8 checkpoint**, 9 agent_response | 57,899 | 0 |
| 5 | 10 user_input, 11 agent_response | 34,757 | 0 |
| 6 | 12 user_input, **13 checkpoint**, 14 agent_response | 57,638 | 0 |
| 7 | 15 user_input, 16 agent_response | 35,331 | 0 |
| 8 | 17 user_input, **18 checkpoint**, 19 agent_response | 58,054 | 0 |

The pattern repeats four times: a checkpoint is emitted, and the *next* request
is about 22,000 tokens smaller than the arithmetic would give - the compacted
history replaces everything before it. Steady state oscillates between roughly
35,000 and 58,000 input tokens. Every turn returned `status: "SUCCESS"`; the
session ended with `num_turns: 8` and a cumulative 366,156 input tokens.

The observed trigger band for this model is **between 54,494 and 58,054 input
tokens**. The threshold value itself, and how it is derived from the model's
context window, are **unverified** - the CLI never states either, and the run
log at default verbosity records no compaction line at all (observed:
`grep -i "compact\|truncat\|threshold\|prune" <run log>` matches nothing but the
workspace path, which contains the word "compaction").

### 3.4 Captures

| File | What it holds |
|---|---|
| `captures/agy-version.txt` | `1.2.8` |
| `captures/agy-help.txt` | `agy --help`, the full flag and subcommand surface |
| `captures/agy-changelog-full.txt` | `agy changelog`, all 723 lines |
| `captures/agy-models.txt` | `agy models` on this plan |
| `captures/probe-01-baseline.ndjson` | One-shot `--print` turn; establishes the clean record set |
| `captures/probe-02-session-gptoss.ndjson` | Two-turn `--input-format stream-json` session; establishes per-turn vs cumulative `usage` |
| `captures/probe-03-stdin.ndjson` | The 8-turn synthetic filler fed to the main probe |
| `captures/probe-03-stream.ndjson` | **The main capture.** Four compaction events |
| `captures/probe-03-checkpoint-steps.jsonl` | The four store-side `CHECKPOINT` summaries, verbatim |
| `captures/probe-04-slash-help.ndjson` | `/help` in print mode; shows the undocumented `command_result` event |
| `captures/probe-05-slash-context.ndjson` | `/context` refused in print mode |
| `captures/probe-06-slash-hooks.ndjson` | `/hooks`; no hooks configured |
| `captures/probe-07-stdin.ndjson`, `captures/probe-07-stream.ndjson` | Gemini negative control; no compaction, and the cache-read confound |
| `captures/probe-08-stdin.ndjson` | The 3-turn filler fed to the timed probe |
| `captures/probe-08-stream-timed.tsv` | Arrival-timed capture of one compaction pause |
| `captures/probe-08-attempt1-503.tsv`, `captures/probe-08-attempt2-503.tsv` | The two earlier attempts, both hit by Google's 503s |
| `scripts/` | The generator, the stream summariser, the line timestamper, the hcn reader check |

All filler is synthetic: marker lines built from a fixed 36-word pool. No
repository content, no user data and no credentials entered any prompt.

## 4. What the documentation says, and does not

- The headless-mode page lists the `init`, `step_update` and `result` events and
  their fields. **It does not mention compaction, summarization, context-window
  percentage or occupancy** (documented:
  <https://antigravity.google/docs/cli/headless/>, read 2026-09-22). It also
  does not list `checkpoint` among `step_type` values, nor the `command_result`
  event that `/help` and `/hooks` emit (observed, probes 04 and 06). The
  documented stream surface is narrower than the real one.
- The features page and the conversations page do not cover compaction,
  summarization or the `/context` panel (documented:
  <https://antigravity.google/docs/cli/features/>,
  <https://antigravity.google/docs/cli/conversations/>, read 2026-09-22).
- The CLI's own hook surface has no compaction event. `hooks.json` supports
  `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`
  (documented: <https://antigravity.google/docs/hooks/>, read 2026-09-22).
- The **SDK**, a separate surface from the `agy` CLI stream, does expose a
  context-compaction hook point. Google's SDK announcement lists "nine concrete
  hook points - from session start/end, through pre/post turn, to pre/post tool
  call, tool error recovery, user interaction handling, and context compaction"
  (documented:
  <https://antigravity.google/blog/introducing-google-antigravity-sdk>, read
  2026-09-22). The post names no payload fields.

The binary agrees with that split. `strings` on `~/.local/bin/agy` shows
`LIFECYCLE_HOOK_ON_COMPACTION` and an `OnCompactionArgs` message with
`GetInteractionId`, `GetTrajectoryId`, `GetStepIndex` and `GetSummary`
accessors, a `CompactionConfig` with `GetTokenThreshold`, `GetMaxContextTokens`
and `GetCheckpointIntervalTokens`, a `StepUpdate` field 28 named `compaction`,
and an on-demand compaction prompt preamble reading "ON-DEMAND COMPACTION: The
user triggered this compaction. Follow any instructions in their latest message,
if present." (observed).

Treat that last paragraph as **weak evidence**: symbol names in a `strings`
dump establish that the machinery exists somewhere in the binary, not that the
`agy` CLI stream exposes it. Nothing in any capture here produced a
`compaction` field on a `step_update`, a threshold number, or a user-triggered
compaction path. The CLI's `StepUpdate` on the wire carries only the fields
listed in 2.2.

## 5. Limits of this evidence

- **One model compacted.** All four compaction events came from
  `gpt-oss-120b-medium`. That the `checkpoint` record is model-independent is
  **unverified**: `gemini-3.8-flash-low` never reached its threshold here, and
  no Claude-backed model was probed. Neither model's context window was
  established, so how much more filler a Gemini run would need is unknown.
- **One mode.** Compaction was observed in `--input-format stream-json`
  (`headless-session`). Whether a single long `--print` turn
  (`headless-turn`) can compact is **unverified** - a one-shot turn has no
  second request to shrink.
- **The threshold is unverified.** 54,494-58,054 input tokens is an observed
  band for this model on this plan, not a documented constant, and 1.2.8
  changed how the budgets are sized.
- **The pause was timed once.** The 4.476-second silent gap comes from a
  single compaction on one model, and this probe cut that run short. The four compactions in probe-03 confirm the record order but carry
  no arrival timestamps. Google documents neither the `checkpoint` step type
  nor when the record is written relative to the pause.
- **Google's backend was degraded during the probe window.** Two runs failed
  outright with `UNAVAILABLE (code 503): No capacity available`. That did not
  change any record shape reported here. The short probe-08 run has a
  different cause, recorded in 2.3.
- **The model's replies degraded after compaction.** `gpt-oss-120b-medium`
  returned truncated markers (`WF235-MARK` instead of `WF235-MARK-03`) on
  post-compaction turns. That is a model-quality artifact under a summarized
  context, not a compaction signal, and it is not evidence about what the stream
  emits.
- **`strings` is not a specification.** Section 4's binary symbols were not
  cross-checked against a published proto.
- **Absence claims are about this search.** "No environment variable lowers the
  threshold" means none was found in `agy --help`, the CLI reference settings
  table, or a `strings` sweep for `ANTIGRAVITY_*`, `AGY_*`, `JETSKI_*`,
  `CASCADE_*` names. It is not proof that none exists.

## 6. Open

- Does a `checkpoint` record appear for Gemini and Claude models, or is the
  record shape model-dependent? Not attempted; filler cost.
- Can a single `--print` turn compact? Not attempted.
- Does the `agy` SDK's compaction hook deliver `OnCompactionArgs.summary`, and
  can a CLI caller reach it? Not attempted; the SDK was not installed.
- Does `StepUpdate` field 28 (`compaction`) ever reach the CLI's JSON stream
  under some condition not exercised here - a different permission mode, an
  agent, or an enterprise plan? Unknown.
