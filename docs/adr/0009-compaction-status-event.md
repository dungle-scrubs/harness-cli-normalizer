# Compaction status is a lossless event with a closed state union

Status: accepted 2026-09-22.

hcn reports live harness compaction as `HarnessEvent` kind `compaction`. The
event carries a closed five-member state union and the numbers the harness
itself reports. It carries no occupancy percentage, because no harness pushes
one. It is lossless and ordered, never droppable. Four harnesses get a live
mapping: claude, pi and antigravity from their streams, muse from the MSP view
hcn already attaches. Codex and cursor emit nothing reachable, so they report
divergence through a descriptor field instead of silence. The reserved `context`
event retires in the same change.

## Why this exists

Every supported harness compacts its context while a turn runs. The turn goes
quiet for seconds to half a minute, earlier history is replaced by a summary,
and the caller learns nothing. A caller that reads the stream cannot tell a
compaction pause from a slow model, and cannot tell that the history it sent is
gone.

Six research tickets probed the six harnesses live on 2026-09-22
([#230](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/230),
[#231](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/231),
[#232](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/232),
[#233](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/233),
[#234](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/234),
[#235](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/235)).
Each ticket's resolution comment carries its findings. They establish that four
harnesses already say what hcn drops, and that two say nothing hcn can reach.

Reporting a signal the harness already emits is normalization, so ADR 0008 needs
no maintainer ask for it. Nothing here decides anything a harness does not
decide. hcn does not choose when to compact, does not ask a harness to compact,
and does not act on the event.

## The event

```ts
export type CompactionState =
  | "started"
  | "compacted"
  | "noop"
  | "failed"
  | "aborted";

export type CompactionTrigger = "auto" | "manual" | "overflow";

// in HarnessEvent
| {
    readonly kind: "compaction";
    readonly state: CompactionState;
    readonly trigger?: CompactionTrigger;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly durationMs?: number;
    readonly detail?: string;
  }
```

### The state union is closed, and each member has its own remedy

The union follows the `LimitCode` and `ExitCause` precedent: it is closed, so a
consumer branches with no default arm, and a member exists only when a caller
would do something different about it.

| State | What the caller learns | Why it is not merged |
|---|---|---|
| `started` | A pause is beginning. Silence that follows is not a stall. | The only state that arrives before the pause. |
| `compacted` | It happened. Earlier history is replaced by a summary. | The only state after which sent context is gone. |
| `noop` | It ran and changed nothing. | Context is unchanged, and nothing is broken. |
| `failed` | The harness tried and could not. | Context is unchanged, and the run may die. |
| `aborted` | It was stopped before completing. | Context is unchanged, and a retry may follow. |

Merging `noop`, `failed` and `aborted` would leave a caller unable to tell
"nothing to compact" from "compaction broke and the run is about to fail". Muse
reports that difference on one record.

`noop` and `aborted` are documented in the harnesses' own vocabularies and were
not produced by the probes. They get union members anyway, because a closed
union that cannot express a value the harness will emit forces the reader to lie
about it. Standing per member is recorded in the mapping table below.

### There is no occupancy field

The charting decision on the map was "states plus occupancy where the harness
itself reports one". No harness reports one on a live compaction signal.

- **claude** exposes `percentage` only through a `get_context_usage`
  control-channel pull, which needs `--input-format stream-json`. Nothing pushes
  it. The statusline `context_window.used_percentage` is a third channel hcn does
  not attach.
- **cursor** declares `context_usage_percent`, `context_tokens` and
  `context_window_size` on its `preCompact` hook. All three are `0` in 11 of 11
  captures, across two CLI versions, while `message_count` in the same payloads
  is populated.
- **pi**, **muse**, **antigravity** and **codex** report no percentage anywhere
  on any live surface.

So the event carries absolute token counts where a harness reports them, and no
derived percentage. hcn computing occupancy from `usage` and a window size would
be invention, and the claude findings show what that costs: a consumer dividing
`usage` by the `result` record's `contextWindow` would have computed 4 percent
occupancy on the turn that compaction actually fired on, because the window the
harness measures against was set by an environment variable the stream never
names.

`detail` carries the harness's own reason or error text. It is prose. Machine
consumers branch on `state`, never on `detail` (ADR 0002).

### The event is lossless

`DROPPABLE_KINDS` does not gain `compaction`. A compaction event that a
backpressure policy drops is a boundary the caller never learns about, and the
caller cannot rebuild it from anything else on the stream. Callers must be able
to build decisions on this event later, not only render it.

With the `context` retirement below, `DROPPABLE_KINDS` becomes
`{"token", "progress"}`.

This changes behaviour for claude. Its compaction records arrive today as
droppable `progress`. As lossless events they flush the pre-identity droppable
buffer in `streamTurn` ahead of themselves, and they are never trimmed from
`openSession`'s pre-turn queue.

## Per-harness source mapping

Every mapping below rests on a live probe. No mapping is taken from
documentation alone.

| Harness | Source | States emitted | Tokens | Standing |
|---|---|---|---|---|
| claude | stream | `started`, `compacted`, `failed` | yes | `started` and `compacted` observed; `failed` from the 2.1.278 bundle schema |
| pi | stream | `started`, `compacted`, `aborted` | yes | `started` and `compacted` observed; `aborted` from `dist/core/agent-session.js` |
| muse | MSP view | `compacted`, `noop`, `failed`, `aborted` | yes | `compacted` observed; the rest from the binary's own MSP schema export |
| antigravity | stream | `compacted` | no | observed, four times |
| codex | none | none | none | silence observed across three crossings |
| cursor | none | none | none | silence observed across 10 boundaries |

### claude

The decoder in `src/interpretation/content.ts` reads one record at a time and
holds no state between records, so exactly one record produces the end event.
The boundary record is that record, because it is the only one carrying numbers.

| Record | Event |
|---|---|
| `system/status` with `status: "compacting"` | `{state: "started"}` |
| `system/status` with `compact_result: "success"` | nothing |
| `system/status` with `compact_result: "failed"` | `{state: "failed", detail: compact_error}` |
| `system/compact_boundary` | `{state: "compacted", trigger, tokensBefore: pre_tokens, tokensAfter: post_tokens, durationMs: duration_ms}` |
| any other `system/<subtype>`, including `status: "requesting"` | `progress`, unchanged |

The success status record produces nothing on purpose. Emitting it as well as
the boundary would give two ends for one compaction, and a caller counting
boundaries would double-count.

**A start can repeat, and is not deduplicated.** Implementing this found
claude sending two `status: "compacting"` records for one compaction
(`test/fixtures/claude-2.1.278/compaction.ndjson`, re-captured 2026-09-22),
where the research probe saw one. The decoder reports each record it reads.
Suppressing the second would mean holding state across records and deciding
that the harness repeated itself, which is the line this ADR does not cross.
So `compacted` is the one-per-compaction event, `started` is not, and a
counting consumer counts ends.

The live stream and the saved transcript disagree on casing for the same data:
the stream record is `compact_metadata` with `pre_tokens` and `post_tokens`,
while the transcript row is `compactMetadata` with `preTokens` and `postTokens`.
`src/interpretation/transcript/claude.ts` reads the camelCase form, which is
right for transcripts and wrong for the stream. The stream reader uses the
snake_case names.

### pi

Both records are already on the stream that `pi -p --mode json` prints, and the
pi decoder drops both today.

| Record | Event |
|---|---|
| `compaction_start` | `{state: "started", trigger}` |
| `compaction_end` with `aborted: true` | `{state: "aborted"}` |
| `compaction_end` otherwise | `{state: "compacted", trigger, tokensBefore, tokensAfter: estimatedTokensAfter}` |

`reason` maps to `trigger`: `threshold` to `auto`, `manual` to `manual`,
`overflow` to `overflow`. A threshold-triggered compaction is automatic, so it
normalizes onto the vocabulary claude and muse already use.

Two traps the reader must avoid. Pi's documentation says an aborted
`compaction_end` carries `result: null`; the implementation sets it to
`undefined`, and `JSON.stringify` drops the key, so on the wire the key is
absent. The reader branches on the `aborted` flag, never on `result === null`. A
threshold compaction can also run before `agent_start` or after `agent_end`, so
a reader that only looks between turn markers misses it.

### muse

Muse's stdout is silent on a successful compaction. The compacting run and a
control run emit the same 31 records with the same payload-type multiset. The
signal is on the MSP view of the `muse serve` helper that
`src/execution/muse-approvals.ts` already spawns beside every muse turn, because
the descriptor sets `approvalObserver: "msp-list-pending"`.

| View frame | Event |
|---|---|
| `item/started`, `kind: "compaction"` | `{state: "started", trigger, tokensBefore}` |
| `item/completed`, `outcome: "compacted"` | `{state: "compacted", trigger, tokensBefore, tokensAfter}` |
| `item/completed`, `outcome: "noop"` | `{state: "noop", detail: reason}` |
| `item/completed`, `outcome: "failed"` | `{state: "failed", detail: reason}` |
| `item/completed`, `outcome: "cancelled"` | `{state: "aborted", detail: reason}` |

Muse's `cancelled` maps to `aborted`. The two words name the same thing: the
compaction stopped before installing a replacement.

Folding this into the observer widens what it reads. It already runs a
`muse serve` helper and polls `approval/listPending`; it will also page
`view/page` and hold a view cursor so one compaction is not reported twice. The
cursor is state for reporting, not for deciding, so it stays normalization under
ADR 0008.

The `run.terminal.failed` prose reason that does reach muse stdout is not used
as a compaction signal. It has no kind, no trigger and no outcome field, it is
subject to rewording, and hcn already surfaces it as a generic native failure.

### antigravity

One record, and it carries no payload beyond a duration.

| Record | Event |
|---|---|
| `step_update` with `step_type: "checkpoint"`, `state: "DONE"` | `{state: "compacted", durationMs}` |

There is no `ACTIVE` phase for a checkpoint, so antigravity announces no start.
The reader takes the step's own `DONE` state as the evidence that the compaction
completed. That is the only outcome evidence the record carries; antigravity
emits no outcome field.

`input_tokens` is not used. It drops on compaction, and it also drops without
one, because it excludes cache-read tokens. Inferring compaction from a token
drop produces a false positive on every cached Gemini turn.

## Harnesses with no live signal report divergence

Silence must not read as "no compaction happened". Both silent harnesses do
compact; the probes forced compaction on each and watched the stream say
nothing.

**Codex** drops the signal at source. The core emits a `ContextCompaction` item,
the app-server protocol carries it, and the `exec --json` processor's
`map_item_with_id` returns `None` for it. The item is also empty:
`ContextCompactionItem` is `{ id: String }` and `ContextCompactedEvent` is a
unit struct, so even a plumbed-through item would carry no numbers.

**Cursor** has no compaction code path in its emitter at all. No `type` or
`subtype` literal in the bundle names compaction. Its `preCompact` hook does fire
headless, and it is declined: reaching it means hcn writing `.cursor/hooks.json`
into the user's working tree, clobbering any hook the user configured, and
receiving from a side-channel process. That is neither normalizing a stream nor
supervising the one process hcn spawned. The payload's occupancy fields are zero
in every capture, so what it would deliver is a message count.

The divergence is descriptor data, surfaced on the event stream:

```ts
// knowledge/descriptor.ts
readonly compactionReporting: {
  readonly source: "stream" | "view";
  readonly states: readonly CompactionState[];
  readonly tokens: boolean;
} | null;   // null: no live signal on any channel hcn reads
```

`CapabilityResult` carries it onto the `identity` event, so a caller branching on
compaction events reads the answer once per session on the same channel, with no
stderr parsing. `hcn inspect <harness> --json` prints it for planning.

No per-run stderr `divergence:` line is written. The existing lines name a key
the caller asked for and could not have rendered. Nobody asks for compaction
reporting, so that line would print on every codex and cursor run, including the
ones where nothing compacts.

## The `context` event retires

`{ kind: "context"; usedPct: number }` is removed, with the machinery behind it.

It was reserved for an occupancy value that cannot reach hcn. Its decoder,
`contextEventFrom` in `src/interpretation/context.ts`, has no production caller;
its only importer is its own test. Claude is the one harness with a non-null
`contextHook`, and the field it names lives on the statusline channel, which hcn
does not attach and which no probe found on stdout. Attaching that channel would
be a new supervising part, frozen by ADR 0008.

Removed: the `context` arm of `HarnessEvent`, its `DROPPABLE_KINDS` entry,
`src/interpretation/context.ts`, `test/interpretation/store-context.test.ts`, the
`case "context"` arm in `src/cli/render.ts`, the README row, and claude's
`contextHook` descriptor field, which has no consumer once the decoder goes.
RFC-02 already requires deleting exports without callers, and the header of
`src/knowledge/descriptor.ts` already forbids a key with no consumer arm.

Kept: `contextInspection`. That is a live surface behind
`hcn inspect claude --context`, and it is unrelated to the event.

Re-adding the event is additive if a harness ever pushes occupancy on a channel
hcn reads.

## Consequences

- **Lucid ships before hcn emits.** Lucid's decoder passes unknown kinds through
  by design, but `projectConversationContext`
  (`src/store/conversation-context.ts`) throws `ContextPreparationError` on any
  hcn kind it does not list. So the new kind breaks lucid's context preparation
  on exactly the harnesses lucid drives. Lucid adds `compaction` to its
  `EventKind` map, classes it lossless in `EVENT_CLASS`, returns null for it from
  the projector, and gives `src/tui/view.ts` a line. hcn emits after that lands.
- **hcn's additive-kinds promise does not hold end to end.** The contract in
  `src/execution/events.ts` says consumers ignore unknown kinds. Lucid's
  projector does not, so every future hcn kind needs a paired lucid change until
  that projector is made tolerant. This is recorded so the next kind does not
  rediscover it.
- **Lucid loses nothing it was using.** It has no `compact_boundary` string
  anywhere. It renders every `progress` event generically as `… ${label}` and
  drops them from projected context. The claude label was never read as a
  compaction signal by any consumer.
- **The compaction pause is documented, and no clock changes.** Measured pauses:
  codex 24 to 32 s, cursor 25 to 39 s, claude 25 to 28 s, antigravity 4.5 to
  18 s, pi 7 to 10 s, muse about 7 s. A caller running `--stall` below those
  kills a healthy run. hcn's inactivity clock is not taught about compaction: it
  could only pause on the three harnesses that announce a start, and those are
  not where the risk is. Codex and cursor have the longest silences and announce
  nothing. The bands go in the README so a caller sets `--stall` above them.
  `--stall` is opt-in and unset by default, so nothing regresses today.
- **Descriptor facts move, and the bumps are separate work.** The probes
  establish native compaction where the descriptors record unknown support: pi
  in `headless-turn` and `headless-session` (issue #227), cursor in
  `headless-turn` (11 observations), antigravity in `headless-session`. Version
  anchors also moved: pi installed 0.87.0 against descriptor 0.86.1, antigravity
  installed 1.2.8 against descriptor 1.2.7, and 1.2.8 changed how compaction
  sizes its budgets. Muse's build moved under its fixtures, 1.3.0-R3401.1 against
  R3233.1 at the same `1.3.0`. Each bump re-runs the tripwires and re-captures
  fixtures, per the convention in `AGENTS.md`.
- **The muse observer's attach timing is an open implementation risk.** Muse
  compacts pre-turn and blocking, while the observer starts on the identity
  event. Whether it attaches early enough to see a pre-turn compaction is not
  established by these probes, and the implementation ticket closes it.
- **Cursor auto-updates mid-run.** The probe caught the binary moving from
  `2026.09.15-d2fe57e` to `2026.09.18-9a7762b` between two runs minutes apart.
  Any cursor claim anchored to `verifiedAgainst` is anchored to a version that
  may not have served the run.

## Rejected alternatives

- **A two-member union, `started` and `ended`, with the outcome in `detail`.**
  Rejected: ADR 0002 says machine consumers branch on structure, never on prose.
  A caller deciding whether to resend context would have to string-match each
  harness's own word.
- **A phase field plus a separate outcome union.** Rejected: two closed unions to
  keep honest instead of one, and a nested branch for every consumer, to express
  what five flat members express.
- **An optional `usedPct` on the compaction event, reserved.** Rejected: it would
  be absent on every emission in v1, which is the dead-reserved shape the
  `context` event is being retired for.
- **Pulling claude's `get_context_usage` to fill an occupancy field.** Rejected:
  it turns every claude run bidirectional and puts hcn in charge of deciding when
  to ask, which is a new supervising part and frozen by ADR 0008.
- **Keeping the `context` event reserved with an updated comment.** Rejected: no
  channel hcn reads can fill it, so the comment would describe a permanent
  vacancy. Re-adding later is additive.
- **Muse from its stdout failure string.** Rejected under ADR 0002, and it covers
  only the failure case.
- **Cursor via an hcn-installed `preCompact` hook.** Rejected: hcn would write
  into the user's repository and take a new inbound channel, to deliver a message
  count.
- **Duplicating claude's `progress: compact_boundary` alongside the new event.**
  Rejected by the map's own charting decision, and it would emit two events for
  one record.
