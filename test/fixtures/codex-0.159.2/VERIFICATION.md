# Codex 0.159.2 verification

Captured on pro, 2026-09-30, with `gpt-6-astra`. `README.md`,
`resume-last.ndjson`, and `question.ndjson` are the earlier captures,
carried forward unchanged (the question run of this cycle answered from the
matrix capture; its raw stream is the 2026-09-30 smoke capture, and
`question.ndjson` keeps the 0.155.1 recording as the decoding corpus: the
escalation-block decode is a decoder property, and this cycle's live 0.159.2
question event is covered by `questions.snapshot.json`).

## Smoke suites

```sh
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/hcn-smoke-ws/codex SMOKE_CAPTURE_DIR=.smoke/runs/codex-2026-09-30 bun run smoke:seven
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/hcn-smoke-ws/codex SMOKE_CAPTURE_DIR=.smoke/runs/codex-2026-09-30 bun run smoke:questions
```

All runnable scenarios pass; streaming and persistent session stay skipped
(codex's own descriptor claims, re-derived this cycle: the captured stream is
message-granular with no token deltas, and codex exposes no persistent-session
exec subcommand). `fresh.ndjson`, `tool.ndjson`,
`establish.ndjson`, and `resume.ndjson` are native stdout of this cycle's
seven-run captures 01-04. `escalation.observedOn`: `{ harness: "codex",
model: "gpt-6-astra", version: "0.159.2", date: "2026-09-30" }`.

## Native compaction

Synthetic session (marker `HERON-519`, session
`01a0f08d-0bb1-7d82-a38b-252e9b9c4920`, rollout
`2026-09-30T11-22-50-01a0f08d-...`) resumed through `hcn run codex --json
--model gpt-6-astra --questions none --resume <id>` with the passthrough
`-- -c model_auto_compact_token_limit=20000`: the first filler turn (the
60-pair list) already crossed the lowered limit and compacted, the A-Z
sentence turn compacted again, and `compaction-recall.ndjson` - which
compacted once more before answering - recalls the marker.
`post-compaction.ndjson` is a later process with no override that recalls it
again. Lowered thresholds exercise the trigger; they do not prove
full-capacity behavior or lossless recall.

`compaction-recall.ndjson` and `post-compaction.ndjson` are decoded hcn event
streams; the `observedOn` stamp inside their identity events reflects the
descriptor at capture time (0.156.1 - the probes ran before this cycle's
bump), the same convention as the 0.156.1 cycle's files. The codex-native
evidence is the argv in the `.stderr.txt` files and the rollout records.

`compaction-rollout-records.json` lists the rollout's compaction records.
**The shape is unchanged from 0.156.1**: three `item_completed` records whose
item is a bare `ContextCompaction` reference (`id` and `type` only - no
encrypted summary, no token counts, no replacement history). The rollout's
separate full `compacted` window records (window ids, replacement history,
retained context) sit alongside them, as in earlier cycles; their shape-only
extraction is `compaction-rollout-window-records.json` (3 records, window
numbers 1-3, replacement_history_len 2-4). Durations from
the records' own millisecond fields: 15.2 s, 62.3 s, 92.9 s.

Observed variance from the 0.156.1 cycle, none of it an interface change:
the first filler crossed the 20000-token limit immediately (0.156.1 needed
the A-Z turn), the record count is 3 rather than 4 (count follows how many
turns overload, not an interface property), and the longest compaction ran
92.9 s (0.156.1's own four already spanned 15.6-47.8 s). Not reconciled
against specific 0.157.0 compaction PRs; the release notes do not quantify
threshold or timing behavior.

`contextInspection` stays null; the 0.157.x-0.159.x release notes add no
pending-prompt accounting interface, and no probe of one exists to run. The
keeper is the coordinator's standing instruction: null unless evidence of a
new accounting interface appears; re-check the release notes on the next
update cycle.

## Changelog scan (0.156.1 -> 0.159.2)

No exec/--json interface changes. 0.157.0's compaction checkpoint
persistence (#47323) and resume-from-latest-boundary (#47365) changed none of
the observable record shapes; the catalog additions (GPT-6 Sol/Luna 0.157.0,
GPT-6.1 Sol default 0.159.1) are irrelevant to hcn, which passes `--model`
explicitly; 0.159.0's `instant_interrupt` steering is opt-in TUI/app-server
surface, not exec.

## Normalization

None. No capture carries a session scratchpad path, and no capture echoes
operator agent configuration.
