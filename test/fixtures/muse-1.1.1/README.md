# Muse 1.1.1 verification

Captured on pro, 2026-09-11. All live probes selected
`muse-spark-1.3-contributor`. `smoke:seven` and `smoke:questions` ran through
HCN in `/tmp/hcn-muse-verification/workspace`, using `SMOKE_HARNESS=muse`,
`SMOKE_MODEL=muse-spark-1.3-contributor`, `SMOKE_CWD` and separate
`SMOKE_CAPTURE_DIR` directories. The JSON snapshots are the suites' output.
Numbered NDJSON files are unmodified native stdout bytes: fresh, streaming,
tools, establish/resume, establish/interruption/resume. Persistent mode is the
only skipped capability. `question.ndjson` is the escalation recording.

The separate context probe used Muse's supported `exec --json` surface and
`xhigh`, with writes, shell, web tools, and foreign personal context disabled.
A synthetic first prompt contained marker `MARIGOLD-742` and repeated filler.
The same session resumed with soft/hard thresholds 0.02/0.04 (failed replacement)
and 0.04/0.1 (successful automatic replacement). No manual compact command ran.
`compaction-records.json` contains the complete `context_compaction_*` objects
selected recursively from the official `muse export --redacted` document.
These are captured records, not invented events. The automatic install record
labels timing `standalone_manual` but trigger `soft_threshold_async`.

After installation, Lucid's HCN 0.6.5 resumed that session with the same model
and effort, at default compaction thresholds. `post-compaction.ndjson` is its
unmodified normalized output, including its missing-ID advisory and clean done.
Recall proves this continuation; the echoed caller-assigned ID alone does not.
The native session and raw source captures remain under
`/tmp/hcn-muse-context-DVIifF` on the capture machine.

These probes establish native automatic compaction and later recall at lowered
thresholds. They do not establish full-capacity operation, arbitrary incoming
prompt admission, every strategy/model, or lossless recall. Muse's recorded
budget values are explicitly `heuristic_estimate` and are not HCN accounting.
`contextInspection` remains null. Muse's embedded MSP schema describes
`session/contextUsage` as occupancy at the latest provider-reported durable fact,
not a count of the next complete staged prompt.

Primary interfaces: installed `muse exec --help`, `muse schema generate-json-schema`,
and [official headless docs](https://dev.meta.ai/docs/muse-code/extending#headless).
