# Codex 0.155.1 verification

Captured on pro, 2026-09-20, with `gpt-6-astra`. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture,
carried forward unchanged.

## Smoke suites

```sh
SMOKE_HARNESS=codex SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

The JSON snapshots are the result files. `fresh.ndjson`, `tool.ndjson`,
`establish.ndjson`, and `resume.ndjson` are native stdout bytes of capture
files 01-04, and `question.ndjson` is the question run's capture 01.
Streaming deltas and persistent sessions remain skipped, as on 0.154.0.

Unlike the 0.154.0 run, the question turn answered without reading any local
file, so its own raw stream is kept here and is the decoding evidence. The
0.153.4 recording no longer has to stand in for it.

0.155.1 still emits the local skill-budget notice as an `item.completed` item
of type `error` on fresh turns (`tool.ndjson`), byte-identical to the 0.154.0
text. hcn decodes it as a non-terminal `error` event and the turns end clean.

## Native compaction

A synthetic session (marker `HERON-517`) was resumed through `hcn run codex
--json --model gpt-6-astra --questions none` with the native passthrough
`-- -c model_auto_compact_token_limit=20000`: a filler turn, then
`compaction-recall.ndjson`, which recalls the marker. `post-compaction.ndjson`
is a later process with no override that recalls it again.
`compaction-rollout-records.json` lists the rollout's `compacted` records and
`ContextCompaction` items (ordinals, timestamps, item keys, replacement
history length); the replacement history itself is not copied. Two
`compacted` records, the same count and shape as 0.154.0.

`contextInspection` stays null. The 0.155.0 and 0.155.1 release notes add
voice conversations, Guardian context plumbing, MCP user verification and
daemon update scheduling. The Guardian context cost and request-token
telemetry (openai/codex#44164, #44166) is internal metering, not a count of a
staged request, so it is not pending-prompt accounting.

## Normalization

None. The capture files carry no session scratchpad path.
