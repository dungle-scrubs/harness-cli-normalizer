# Codex 0.156.1 verification

Captured on pro, 2026-09-24, with `gpt-6-astra`. `README.md`,
`resume-last.ndjson`, and `question.ndjson` are the earlier captures,
carried forward unchanged (the question run of this cycle answered from the
matrix capture; its raw stream is the 2026-09-24 smoke capture, and
`question.ndjson` keeps the 0.155.1 recording as the decoding corpus).

## Smoke suites

```sh
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/hcn-smoke-ws/codex SMOKE_CAPTURE_DIR=.smoke/runs/codex-2026-09-24 bun run smoke:seven
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/hcn-smoke-ws/codex SMOKE_CAPTURE_DIR=.smoke/runs/codex-2026-09-24 bun run smoke:questions
```

All runnable scenarios pass; streaming and persistent session stay skipped
(codex's own descriptor claims). `fresh.ndjson`, `tool.ndjson`,
`establish.ndjson`, and `resume.ndjson` are native stdout of this cycle's
seven-run captures 01-04. `escalation.observedOn`: `{ harness: "codex",
model: "gpt-6-astra", version: "0.156.1", date: "2026-09-24" }`.

## Native compaction

Synthetic session (marker `HERON-519`, session
`01a0d290-c8aa-7561-a057-1e1c1156544c`) resumed through `hcn run codex
--json --model gpt-6-astra --questions none` with the passthrough `-- -c
model_auto_compact_token_limit=20000`: two filler turns (the first 60-pair
list crossed nothing; an A-Z sentence turn did), then
`compaction-recall.ndjson`, which recalls the marker. `post-compaction.ndjson`
is a later process with no override that recalls it again.

`compaction-rollout-records.json` lists the rollout's compaction records.
**0.156.1 changed the shape**: four `item_completed` records whose item is a
bare `ContextCompaction` reference (`id` and `type` only - no encrypted
summary, no token counts, no replacement history), where 0.155.1 carried two
`compacted` payloads with their items and replacement history lengths.
Durations from the records' own millisecond fields: 15.6 s, 34.3 s, 40.0 s,
47.8 s.

`contextInspection` stays null; the 0.156.x release notes add no
pending-prompt accounting interface.

## Normalization

None. The capture files carry no session scratchpad path.
