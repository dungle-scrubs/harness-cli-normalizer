# What compaction signals does Muse's live stream emit?

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research ticket [#233](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/233).
Probed 2026-09-22 on `pro`, Muse Code 1.3.0 (1.3.0-R3401.1).

## The finding that reframes the question

**`muse exec --json` emits no compaction signal at all on a successful
compaction.** Not a record, not a field, not a marker. A turn that compacts
68,376 tokens down to 22,388 produces a stdout stream that is
indistinguishable, record for record, from a turn that compacts nothing.

The signal is not missing from Muse. It is missing from *this surface*.
Muse carries a fully structured compaction event - trigger, outcome,
strategy, tokens before and after - on two other surfaces:

| Surface | Compaction signal | Standing |
|---|---|---|
| `muse exec --json` stdout | none on success; prose-only on failure | **observed** |
| `muse serve` MSP view (`view/page`) | `item/started` + `item/completed`, `kind: "compaction"` | **observed** |
| `session.jsonl` durable log | `context_compaction_candidate` / `_installed` / `context_projection_checkpoint` | **observed** |

hcn already runs a `muse serve` helper beside every muse exec, for the
approval observer (`approvalObserver: "msp-list-pending"`,
`src/knowledge/muse.ts`). The surface that carries the compaction signal is
therefore one hcn is already attached to. That, not the stdout stream, is
where a compaction-status event (#236) would get its data for muse.

Scope note, not a recommendation: reading the MSP view is a wider
subscription than the approval observer's single `approval/listPending`
fold, and `AGENTS.md` freezes the supervising list. This findings file
records what exists; the decision is #236's.

## Answers to the three capture questions

### 1. Every record emitted in the compaction window

Zero compaction records. The compaction window is bounded by
`run.lifecycle.started` and the first `run.output.delta`, and the records
inside it are the ordinary turn scaffolding:

```
run.lifecycle.started
task.stream.linked
task.lifecycle.proposed        (task_kind: reminder.agent.skill-reminder)
task.lifecycle.accepted
task.lifecycle.scheduled
task.lifecycle.side_effect_intent
task.lifecycle.started
task.stream.linked
task.lifecycle.proposed        (task_kind: model.meta.response)
task.lifecycle.accepted
task.lifecycle.scheduled
task.lifecycle.side_effect_intent
task.lifecycle.started
task.lifecycle.status          ("opening meta model stream attempt 1/10")
run.output.delta               ('LANTERN-913')
```

Source: `captures/06-compaction-timed.timing.tsv` and
`captures/06-compaction-timed.stdout.ndjson`, the run whose durable log
records `context_compaction_installed`. **Observed.**

The compaction run and the no-compaction control emit the **same 31
records with the same `payload_type` multiset**. The only sequence
difference is the position of two `task.lifecycle.completed` records, which
is the interleaving of an unrelated `reminder.agent.verify-reminder` task:

```
compaction run records: 31 | control records: 31
payload_type multiset identical: True
payload_type sequence identical: False
  @@ -22,2 +22,3 @@   task.lifecycle.completed
  +task.lifecycle.completed
  @@ -29,3 +30,2 @@   -task.lifecycle.completed
```

Source: `scripts/diffscan.py` over `captures/06-compaction-timed.stdout.ndjson`
and `captures/07-control-nocompaction.stdout.ndjson`. **Observed.**

**The one live signal is the failure case.** When compaction runs but its
replacement still exceeds the hard threshold, the run dies and the reason
reaches stdout as prose on `run.terminal.failed`:

```json
{"payload_type":"run.terminal.failed","payload":{
  "kind":"run_terminal","terminal":"failed","text":"",
  "reason":"context compaction replacement still exceeds the hard threshold (22132 >= 20480 tokens)"}}
```

Source: `captures/02-compaction-hard.stdout.ndjson`, line 7, verbatim.
**Observed.** This is a prose string in a general-purpose failure field, not
a compaction record: there is no `kind`, no trigger, no outcome. hcn's muse
reader (`src/interpretation/content.ts:234`) already turns
`payload.kind === "run_terminal"` with `terminal: "failed"` into a terminal
`error` event, so this arrives today as a generic native failure.

### 2. Percentage and occupancy numbers

**No percentage and no occupancy number appears in the live stream.** A
recursive scan of every field name in the compaction run's stdout for
`token|percent|occupanc|budget|threshold|context_window|usage|remaining`
returns nothing:

```
=== fields matching token/percent/budget/threshold in 06 stream ===
  (none)
```

Source: `scripts/diffscan.py`. **Observed.**

Where numbers do appear, on the other two surfaces, they are **absolute
token counts, never a percentage or a fraction of capacity**:

- MSP view `item/completed`: `"tokensBefore": 68376, "tokensAfter": 22388`.
- MSP `session/tokenUsage`: `inputTokens`, `outputTokens`, `cachedTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `promptTokens`,
  `totalTokens`, and a `cumulative` roll-up. No denominator, so no
  occupancy can be computed from it alone.
- Durable log: `budget_before.estimated_prompt_tokens`,
  `estimated_budget_after.estimated_prompt_tokens`, each tagged
  `"estimate_source": "heuristic_estimate"`.

The only fractions anywhere are the **configured thresholds echoed back**,
not a reading of how full the context is:

```json
"strategy": {"strategy_id":"summary-preserved-suffix/v1","strategy_family":"summary",
 "config_fingerprint":"soft=0.0500,hard=0.0800",
 "target_budget_tokens":25600,"soft_threshold_tokens":25600,"hard_threshold_tokens":40960}
```

Source: `captures/11-session2-log-compaction-records.json`. **Observed.**
`config_fingerprint` restates the `--context-compaction-soft-threshold` /
`--context-compaction-hard-threshold` flag values; the `*_tokens` fields are
those fractions resolved against the model's effective context limit
(512,000 tokens here: 0.05 x 512000 = 25600, 0.08 x 512000 = 40960).

### 3. What the stream shows during the compaction pause

**Nothing, and the pause is not separable from ordinary model latency.**

No record marks the start or end of compaction, so its boundaries are not
observable from the stream. The pause falls inside the gap between the
`model.meta.response` task starting and the first `run.output.delta`. That
gap was *shorter* in the compacting run than in the control:

| Run | Compaction | Gap, task start to first `run.output.delta` |
|---|---|---|
| `06-compaction-timed` | installed, 68,376 -> 22,388 tokens | **7.312 s** |
| `07-control-nocompaction` | none | **9.269 s** |

Source: `captures/06-compaction-timed.timing.tsv`,
`captures/07-control-nocompaction.timing.tsv`. **Observed.**

The summarizer call costs time, but it shrinks the prompt the model then
reads (68k to 22k tokens), so the two effects cancel. A consumer cannot
detect compaction from stdout timing, in either direction: a longer gap is
not evidence of compaction and a normal gap is not evidence against it.

For scale, the durable log puts the summarizer call at
`"summarizer_usage": {"input_tokens":2116,"output_tokens":1068,"duration_ms":14426}`
(`captures/04-session-log-compaction-records.json`, the installed record).
**Observed**, on session 1. On session 2 the same field is `null`, so the
field is not always populated - **observed, unexplained**.

The 18.567 s gap late in the compacting run is a
`reminder.agent.verify-reminder` task, not compaction; the control shows the
same shape at 13.682 s (`scripts/timeline.py`).

## What the other two surfaces carry

### MSP view (`muse serve`, `view/page`)

Compaction is a first-class view item, emitted as a started/completed pair.
Verbatim, from `captures/09-msp-fullview.frames.ndjson`:

```json
{"method":"item/started","params":{"sessionId":"2cf3841d-2128-4da8-b3c4-905cf06d9975",
 "viewCursor":"v:2cf3841d-2128-4da8-b3c4-905cf06d9975:6",
 "item":{"itemId":"9e1e3266-528f-4192-97cd-627deda523c1","kind":"compaction",
  "turnId":"b855aea7-4d38-431b-b9ce-55145cfb2576","revision":1,"status":"inProgress",
  "recordedAt":"2026-09-22T09:42:21.975079Z","fallbackText":"Context compaction",
  "trigger":"auto","tokensBefore":68376}}}
```

```json
{"method":"item/completed","params":{"sessionId":"2cf3841d-2128-4da8-b3c4-905cf06d9975",
 "viewCursor":"v:2cf3841d-2128-4da8-b3c4-905cf06d9975:7",
 "item":{"itemId":"9e1e3266-528f-4192-97cd-627deda523c1","kind":"compaction",
  "turnId":"b855aea7-4d38-431b-b9ce-55145cfb2576","revision":2,"status":"completed",
  "recordedAt":"2026-09-22T09:42:21.979277Z","fallbackText":"Context compaction",
  "outcome":"compacted","trigger":"auto","strategyId":"summary-preserved-suffix/v1",
  "summarizedThrough":"run:b855aea7-4d38-431b-b9ce-55145cfb2576:seq:0",
  "tokensBefore":68376,"tokensAfter":22388}}}
```

**Observed**, reproduced on both probe sessions
(`captures/10-msp-session1.frames.ndjson` shows 67,505 -> 22,165).

The binary's own embedded MSP schema (`muse schema generate-json-schema`,
fingerprint
`sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81`,
`captures/12-msp-schema-manifest.json`) documents the vocabulary:

- `ItemKind` includes `"compaction"`, declared `x-msp-openness: open`.
- `CompactionTrigger`: `manual` | `auto`. Open.
- `CompactionOutcome`: `compacted` | `noop` | `failed` | `cancelled`. Open.
- `Item` fields for `compaction`: `outcome` ("terminal only - folds
  installed/fallback status"), `reason` ("noop/failure reason, verbatim
  ... e.g. `\"no_compactable_history\"`"), `strategyId` ("installed only"),
  `summarizedThrough` ("opaque provenance string naming the compaction
  boundary"), `tokensBefore` / `tokensAfter` ("token budget snapshot ...
  when measured").

**Documented**, from the binary's own schema export. Only `outcome:
"compacted"` and `trigger: "auto"` were **observed**; `manual`, `noop`,
`failed`, `cancelled` and the `reason` field were not produced by these
probes.

`view/page` also accepts `anchor: "latestCompaction"`, which resolves at
call time to the latest installed compaction boundary
(`ViewPageAnchor`, **documented**; **observed** resolving to
`{"boundaryCursor":"v:2cf3841d-2128-4da8-b3c4-905cf06d9975:7"}` in
`captures/08-msp-view.frames.ndjson`).

### Durable session log (`session.jsonl`)

The records exist in the on-disk log that `muse exec` itself writes, under
`payload_type: "runtime.session"` with `payload.kind: "run"`. They are
simply not projected onto stdout. Five such records for probe session 1,
three for session 2:

```
line 102 | seq 103 | runtime.session | context_compaction_candidate | hard_threshold_blocking | pre_turn | rejected
line 103 | seq 104 | runtime.session | context_compaction_fallback   | hard_threshold_blocking | pre_turn
line 132 | seq 133 | runtime.session | context_compaction_candidate | hard_threshold_blocking | pre_turn | succeeded
line 133 | seq 134 | runtime.session | context_compaction_installed | hard_threshold_blocking | pre_turn
line 134 | seq 135 | runtime.session | context_projection_checkpoint
```

Source: `captures/04-session-log-compaction-records.json`. **Observed.**

Note the trigger vocabulary differs between surfaces: the durable log says
`hard_threshold_blocking` and `pre_turn`, while the MSP view flattens the
same event to `trigger: "auto"`. Prior repo evidence
(`test/fixtures/muse-1.3.0/README.md`) also records `soft_threshold_async`
and timing `standalone_manual` in the log vocabulary.

The failed attempt carries its own diagnostics in the log and **no**
compaction item in the MSP view:

```json
"diagnostics":[
 {"reason":"summary_call_metrics","message":"{\"provider_calls\":1,...,\"input_tokens\":2089,\"output_tokens\":825,...}"},
 {"reason":"hard_threshold_failed","message":"replacement estimate 22132 still reaches the hard threshold of 20480 tokens"}]
```

and a companion fallback record:

```json
{"kind":"context_compaction_fallback","fallback_id":"fallback-17","reason":"hard_threshold_failed",
 "severity":"terminal","can_continue":false,"trigger":"hard_threshold_blocking","timing":"pre_turn",
 "strategy_id":"summary-preserved-suffix/v1","blocked_request_id":"request-after-14",
 "related_candidate_id":"candidate-16","no_progress_passes":null,
 "summarizer_usage":{"input_tokens":2089,"output_tokens":825,"duration_ms":10144}}
```

Source: `captures/04-session-log-compaction-records.json`. **Observed.**

## Method

### Version

`muse --version` -> `Muse Code 1.3.0 (1.3.0-R3401.1)`.
`src/knowledge/muse.ts` declares `verifiedAgainst: "1.3.0"`.

**The major.minor.patch matches; the build differs.** The descriptor's
fixtures were captured on build `1.3.0-R3233.1`
(`test/fixtures/muse-1.3.0/README.md`); the installed binary is
`1.3.0-R3401.1`. `versionSource: {kind: "installed"}` pins only `1.3.0`, so
no descriptor bump is implied by this probe and none was made. Recorded
because the build moved under the fixtures.

### Triggering compaction

The threshold mechanism is discoverable and is a CLI flag pair. `muse exec --help`:

```
      --context-compaction-strategy <ID>
          Context compaction strategy: summary-preserved-suffix/v1,
          prefix-extension-summary/v1, prefix-extension-inventory-summary/v1
      --context-compaction-soft-threshold <FRAC>
          Soft compaction threshold
      --context-compaction-hard-threshold <FRAC>
          Hard compaction threshold
```

Both take a fraction of the model's effective context limit. No filler had
to reach a natural threshold: seed a session at default thresholds, then
resume it with the thresholds lowered under the accumulated context.

Two-turn procedure, run twice on two fresh session ids:

1. **Seed.** `muse exec --json --session-id <uuid> --prompt-file <filler>` at
   default thresholds. The filler is synthetic only: a marker line
   (`LANTERN-913`) plus 1,800 identical filler lines, 180,145 characters,
   about 45k tokens (`scripts/mkfiller.py`).
2. **Compact.** Resume the same `--session-id` with
   `--context-compaction-soft-threshold 0.05 --context-compaction-hard-threshold 0.08`
   and a short prompt. Context (~68k tokens) exceeds the hard threshold
   (40,960), so a blocking pre-turn compaction fires.

Every run also carried
`--model muse-spark-1.3-contributor --reasoning-effort low --disable-write
--disable-shell --disable-web-tools --no-foreign-personal-context
--approval-mode never --max-model-steps 4`, to keep tools out of the stream.

Scripts: `scripts/seed.sh`, `scripts/compact.sh`, `scripts/timed.py`
(adds per-line arrival timestamps), `scripts/control.py`.

Sessions: `a4f3b047-2243-41d3-98cf-736a49f7db93` and
`2cf3841d-2128-4da8-b3c4-905cf06d9975`. Workspace: a throwaway git repo in
the session scratchpad; its absolute path appears verbatim in the captures.

Store resolution follows `src/cli/store-root.ts`: `XDG_DATA_HOME` is unset
on this machine, so the muse sessions root is
`~/.local/share/muse/sessions`, and the probe read the dated session
directory under it rather than assuming a path.

### Threshold band

Thresholds cannot be set arbitrarily low. Two failure modes bound the band,
both **observed**:

- **Too low to start.** Prior repo evidence at 0.001/0.002: `runtime host
  failed to start: ... startup prompt estimate 14598 reaches hard threshold
  2015` (`test/fixtures/muse-1.3.0/threshold-failure.ndjson`). The
  irreducible startup prompt must fit under the hard threshold.
- **Too low to succeed.** This probe at 0.02/0.04: compaction ran, produced
  a replacement, and the replacement itself did not fit -
  `22132 >= 20480 tokens`, run failed, exit 1
  (`captures/02-compaction-hard.stdout.ndjson`). The summary floor is
  roughly 22k tokens here, so the hard threshold must exceed it.

0.05/0.08 sits above both and compacts cleanly.

### MSP probe

`muse serve --disable-write --disable-shell`, then JSON-RPC `initialize`,
`initialized`, and one `view/page`. Read-only: no session was started,
resumed or written. The handshake copies hcn's own approval observer
(`src/execution/muse-approvals.ts:182`). Scripts: `scripts/msp_probe.py`
(anchor mode), `scripts/msp_probe2.py` (full forward page).

The first probe used `anchor: "latestCompaction"` and returned 20 events
with **no** compaction item: the anchor resolves to the boundary and the
forward page starts strictly *after* it, so the compaction item itself is
excluded. Paging forward from the beginning with no anchor returns it.
Recorded because it is an easy wrong conclusion to draw.

## Limits of this evidence

- **Two sessions, one model, one machine.** `muse-spark-1.3-contributor`,
  meta provider, build `1.3.0-R3401.1`, on `pro`. Nothing here establishes
  behaviour on another model, provider, or build.
- **One trigger path.** Only `hard_threshold_blocking` / `pre_turn` was
  produced. `soft_threshold_async` and `standalone_manual` exist in the log
  vocabulary (prior fixtures) but were not triggered here, so whether an
  *async* soft compaction leaks anything onto stdout is **not established**.
  That is the one gap most likely to change the answer, because an async
  compaction overlaps the turn rather than preceding it.
- **`session/compact` was never called.** `trigger: "manual"` and the
  `noop` / `failed` / `cancelled` outcomes are **documented** in the schema
  and **unobserved** here.
- **Absence on stdout is a statement about these four runs**, not a proof
  that no muse build or configuration ever emits a compaction record on
  stdout. It is a strong statement for this build: the compacting run and
  the control were compared field by field and agree.
- **The stdout filtering rule is not documented anywhere I found.** `muse
  exec --help` says only "Emit machine-readable JSONL events on stdout". Why
  `runtime.session` records carrying compaction events are excluded from
  that projection is **unverified** - observed behaviour, no owning source
  statement. Searched: `muse --help`, `muse exec --help`, `muse schema`
  export, `muse export --help`, `muse serve --help`. Silence.
- **`contextInspection` stays null.** Nothing here gives hcn a pre-turn
  capacity reading; `tokensBefore` is reported after the fact, on a
  different surface.
- **Not established:** full-capacity operation, lossless recall, or that
  the marker's survival proves anything beyond that one marker surviving
  one compaction. Both probe sessions did recall `LANTERN-913` after
  compaction (`captures/06-compaction-timed.stdout.ndjson`, final
  `run.terminal.completed`).

## Captures

All raw, unmodified stdout unless noted. In `findings/captures/`:

| File | What |
|---|---|
| `01-seed.stdout.ndjson` | session 1 seed turn, default thresholds, no compaction |
| `02-compaction-hard.stdout.ndjson` | 0.02/0.04 - compaction ran, replacement too big, run failed |
| `03-compaction-ok.stdout.ndjson` | 0.05/0.08 - compaction installed, stream silent |
| `04-session-log-compaction-records.json` | session 1 `session.jsonl` compaction records (summary text truncated) |
| `05-seed2.stdout.ndjson` + `.timing.tsv` | session 2 seed turn |
| `06-compaction-timed.stdout.ndjson` + `.timing.tsv` | session 2 compaction run, per-line arrival times |
| `07-control-nocompaction.stdout.ndjson` + `.timing.tsv` | control: same prompt, no compaction |
| `08-msp-view.frames.ndjson` | MSP `view/page` with `anchor: latestCompaction` |
| `09-msp-fullview.frames.ndjson` | MSP full forward page, session 2 - carries the compaction item |
| `10-msp-session1.frames.ndjson` | MSP full forward page, session 1 |
| `11-session2-log-compaction-records.json` | session 2 `session.jsonl` compaction records (truncated) |
| `12-msp-schema-manifest.json` | MSP schema export manifest and fingerprint |

`*.stderr.txt` sidecars accompany each exec run. Scripts that produced them
are in `findings/scripts/`. Prompt content is synthetic throughout: one
marker string and repeated filler lines.

## Citation check

`npx tsx ~/.agents/skills/research/scripts/verify-citations.ts
findings/muse-compaction-signals.md .` exits red with eight
`fabricated-hash` items on lines 179, 181, 182 and 322:
`2cf3841d`, `905cf06d9975`, `9e1e3266`, `627deda523c1`, `b855aea7`,
`55145cfb2576`, `a4f3b047`, `736a49f7db93`.

All eight are **UUID fragments**, not commit hashes: probe session ids and
the `itemId` / `turnId` fields inside verbatim MSP JSON. The checker matches
any run of 8 or more hex characters. This file cites no commits, so the red
is a false positive and no claim rests on a hash.
