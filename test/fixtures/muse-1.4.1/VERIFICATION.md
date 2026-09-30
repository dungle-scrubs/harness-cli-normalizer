# Muse 1.4.1 verification

Captured on pro, 2026-09-30, Muse Code 1.4.1 (1.4.1-R4503.1), model
`muse-spark-1.3-contributor`. The 1.3.0 contributor model still exists and
completes turns on 1.4.1; no substitution was made.

## Smoke suites

```sh
SMOKE_HARNESS=muse SMOKE_MODEL=muse-spark-1.3-contributor SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=muse SMOKE_MODEL=muse-spark-1.3-contributor SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

`seven.snapshot.json` and `questions.snapshot.json` are the result files;
persistent mode (`session-cont(1proc)`) is the only skip - muse has no
session mode, as on 1.3.0. The questions probe passed and produced the
`observedOn` record transcribed into the descriptor.

Numbered NDJSON files are unmodified `muse exec --json` stdout, in the
1.1.1 order: fresh, streaming, tools, establish, resume, establish,
interrupted, resume. Every exec also spawns the approval observer's MSP
helper, and those captures sit between the exec captures without being
renumbered. Two capture mechanics shaped this cycle's fixtures and both
are recorded here: on 1.4.1 three turns (single-turn, the
resume-continuity recall, and the kill-and-resume interrupted turn)
finished before their helper's `initialize` reply landed, so the observer
closed those helpers before any byte was recorded and no helper capture
exists for them; and the recorder appends per spawn number, so running
both suites into one capture dir appends the questions run's bytes to the
seven run's numbered files. The committed fixtures are single-exec
selections, one stream per file: 01-08 and `list-pending.ndjson` (the
streaming turn's helper stdout, initialize plus four polls) come from the
seven suite's own capture files, and `question.ndjson` is the escalation
exec's stdout selected by session id out of the appended capture file.

## Native compaction

Direct `muse exec --json` with `--reasoning-effort xhigh --disable-write
--disable-shell --disable-web-tools --no-foreign-personal-context` and a
fixed `--session-id`. A synthetic first prompt carried marker
`MARIGOLD-742` plus filler at default thresholds.
`compaction-records.json` is every `context_compaction_*` object selected
recursively from `muse export --session <id> --redacted`.

The 1.3.0 recipe's first resume at soft/hard 0.02/0.04 now FAILS on 1.4.1:
the replacement estimate (27,615 tokens) still exceeds the hard threshold
(20,480), the run dies with `run.terminal.failed`, exit 1, and the
durable log records a rejected `hard_threshold_blocking` candidate plus a
`hard_threshold_failed` fallback - the same failure mode the 1.1.1
records hold. The summary floor moved above the 1.3.0-era thresholds, so
this cycle's successful passes sat higher: 0.05/0.06 installed a
`hard_threshold_blocking` replacement, then 0.05/0.10 installed
`soft_threshold_async` (timing `standalone_manual`, as on 1.3.0). The
0.05/0.10 resume needed a filler-assisted prompt: the double compaction
from the first pass had pulled the startup estimate below the soft
threshold. All four outcomes - rejected replacement, successful hard
blocking, successful soft async, and the threshold-refusal below - are in
this cycle's `compaction-records.json`; the 1.1.1 records stay the
oldest rejected-replacement evidence.

`post-compaction.ndjson`: `hcn run muse --json --model
muse-spark-1.3-contributor --effort xhigh --resume <id> --questions none`,
a later process at default thresholds, recalls the marker
(`MARIGOLD-742` as the whole message, done clean, exit 0).

`threshold-failure.ndjson`: the same resume with native passthrough
`-- --context-compaction-soft-threshold 0.001 --context-compaction-hard-threshold 0.002`.
Muse refuses to start (`startup prompt estimate 19722 reaches hard
threshold 2015`, exit 1); hcn reports `failure` class `native` and `done`
cause `crash` with the native message. The irreducible startup prompt
estimate grew from 14,598 tokens (1.3.0) to 19,722 (1.4.1) alongside the
larger skill catalog muse reports loading at startup.

`contextInspection` stays null. These probes do not establish
full-capacity operation or lossless recall.

## Efforts

`muse exec --help` on 1.4.1 still lists
`none|minimal|low|medium|high|xhigh|max|ultra`, but `--reasoning-effort
none` is now a native usage error (exit 2): `--reasoning-effort none is
not supported with --provider meta; choose
minimal|low|medium|high|xhigh|max|ultra`. An unsupported effort is a
native usage error as before (`bogus` exits 2). `max` and `ultra` stay
from the 1.3.0 live evidence; `none` leaves the descriptor ladder on
this evidence - it was never live-verified on an earlier version, and
hcn's muse runs always use the meta provider.

## Memory gap re-check

`muse --help` and `muse exec --help` on 1.4.1 expose no memory category
flag or disable switch; the add_memory/edit_memory tools persist. The
divergence note in the descriptor stands.

## Normalization

The session workspace root in run paths was replaced with `/hcn-verify`,
as in the 1.3.0 fixtures. Nothing else was rewritten: a scan of every new
capture for the operator's agent configuration (instruction files, skill
library, tool descriptions) found none - muse carries that content on
stderr, which is not captured, and its stdout records carry no skill
catalog. The only absolute path left is `museHome` in the MSP
initialize reply, as in 1.3.0.
