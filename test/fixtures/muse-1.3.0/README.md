# Muse 1.3.0 verification

Captured on pro, 2026-09-17, Muse Code 1.3.0 (1.3.0-R3233.1), model
`muse-spark-1.3-contributor`.

## Smoke suites

```sh
SMOKE_HARNESS=muse SMOKE_MODEL=muse-spark-1.3-contributor SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=muse SMOKE_MODEL=muse-spark-1.3-contributor SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

The JSON snapshots are the result files; persistent mode is the only skip.
Numbered NDJSON files are unmodified `muse exec --json` stdout, in the
1.1.1 order: fresh, streaming, tools, establish, resume, establish,
interrupted, resume. On 1.3.0 every exec also spawns the approval observer's
MSP helper; those captures sat between the exec captures and are not
renumbered here, except `list-pending.ndjson` (the first helper's stdout).
`question.ndjson` is the escalation recording.

## Native compaction

Direct `muse exec --json` with `--reasoning-effort xhigh --disable-write
--disable-shell --disable-web-tools --no-foreign-personal-context` and a fixed
`--session-id`. A synthetic first prompt carried marker `MARIGOLD-742` and
filler. The session resumed at soft/hard thresholds 0.02/0.04, then 0.04/0.1.
`compaction-records.json` is every `context_compaction_*` object selected
recursively from `muse export --session <id> --redacted`.

On 1.1.1 the 0.02/0.04 pass recorded a rejected hard-threshold replacement and
a fallback. On 1.3.0 both passes installed a replacement
(`hard_threshold_blocking` and `soft_threshold_async`, strategy
`summary-preserved-suffix/v1`). The 1.1.1 records stay the rejected-replacement
evidence.

`post-compaction.ndjson`: `hcn run muse --json --model
muse-spark-1.3-contributor --effort xhigh --resume <id> --questions none`, a
later process at default thresholds, recalls the marker.

`threshold-failure.ndjson`: the same resume with native passthrough
`-- --context-compaction-soft-threshold 0.001 --context-compaction-hard-threshold 0.002`.
Muse refuses to start (`startup prompt estimate ... reaches hard threshold`,
exit 1); hcn reports `failure` class `native` and `done` cause `crash` with
the native message.

`contextInspection` stays null. These probes do not establish full-capacity
operation or lossless recall.

## Efforts

`muse exec --help` on 1.3.0 lists `none|minimal|low|medium|high|xhigh|max|ultra`.
`--reasoning-effort max` and `ultra` each completed a turn; `bogus` is a native
usage error (exit 2). The descriptor ladder adds `max` and `ultra`.

## Normalization

The session scratchpad prefix in run paths was replaced with `/hcn-verify`.
