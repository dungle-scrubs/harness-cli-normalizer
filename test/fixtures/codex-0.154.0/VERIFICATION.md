# Codex 0.154.0 verification

Captured on pro, 2026-09-17, with `gpt-6-astra`. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture and are
unchanged.

## Smoke suites

```sh
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

The JSON snapshots are the result files. `fresh.ndjson`, `tool.ndjson`,
`establish.ndjson`, and `resume.ndjson` are native stdout bytes of capture
files 01-04. Streaming deltas and persistent sessions remain skipped, as on
0.153.4.

The question run passed, but the model read a local skill file with a shell
command, so its native stream carries that file's text. It is not kept here;
the 0.153.4 `question.ndjson` stays the decoding evidence.

0.154.0 emits the local skill-budget notice as an `item.completed` item of
type `error` on fresh turns (`fresh.ndjson`, `establish.ndjson`). hcn decodes
it as a non-terminal `error` event and the turns end clean.

## Native compaction

A synthetic session (marker `HERON-517`) was resumed through `hcn run codex
--json --model gpt-6-astra --questions none` with the native passthrough
`-- -c model_auto_compact_token_limit=20000`: a filler turn, then
`compaction-recall.ndjson`, which recalls the marker. `post-compaction.ndjson`
is a later process with no override that recalls it again.
`compaction-rollout-records.json` lists the rollout's `compacted` records and
`ContextCompaction` items (ordinals, timestamps, item keys, replacement
history length). The replacement history itself is not copied. The
`.stderr.txt` siblings hold the `spawn:`/`provenance:` lines split out of the
same captured stream.

`contextInspection` stays null. 0.154.0 adds an under-development
`features.context_management.experimental_mode` (openai/codex#42385); it is a
token-budget prompt feature for eligible subscriptions, not a count of a
staged request.

These runs needed an hcn fix: the prompt-injection scan read single-dash
tokens after `--` as the prompt and refused `-- -c key=value`.
