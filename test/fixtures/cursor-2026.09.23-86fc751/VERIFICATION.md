# Cursor 2026.09.23-86fc751 verification

Captured on pro, 2026-09-24, logged in, default model, in a workspace
trusted once with `agent -p --trust`. `README.md`, `resume-last.ndjson`,
`help.stdout.txt`, and `models.txt` are the earlier captures, carried
forward unchanged. The decoding corpus (the `probe-*.ndjson` rows) was not
re-run this cycle; `test/knowledge/cursor-evidence.test.ts` still decodes
the 2026.09.15-d2fe57e corpus, which remains in place.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` from:

```sh
SMOKE_HARNESS=cursor SMOKE_CWD=/tmp/hcn-smoke-ws/cursor SMOKE_CAPTURE_DIR=.smoke/runs/cursor-2026-09-24 bun run smoke:seven
SMOKE_HARNESS=cursor SMOKE_CWD=/tmp/hcn-smoke-ws/cursor SMOKE_CAPTURE_DIR=.smoke/runs/cursor-2026-09-24 bun run smoke:questions
```

Six pass, persistent session skipped. The question probe needed a clean
workspace: the first four attempts failed because attempt one had already
written `deploy-target.txt`, which makes the mutually-exclusive choice look
decided - the model read the file and copied it instead of asking. After
removing the file, the probe passed. The escalation channel itself was
confirmed independently: a manual `hcn run cursor --json` decision turn
emitted the fenced `hcn-question` block, hcn produced the `question` event,
and the turn ended `done: awaiting-input`. `escalation.observedOn`:
`{ harness: "cursor", model: "", version: "2026.09.23-86fc751", date:
"2026-09-24" }`.

The version moved twice during this cycle: the binary auto-updated from
2026.09.18-9a7762b to 2026.09.23-86fc751 between two runs on the same day.
The snapshot's version strings name what actually ran.

## Context contracts

`contextInspection` and `compactionReporting` stay null; the release notes
add no accounting interface and no compaction record on the print-mode
stream. The silent-compaction fact keeps its 2026-09-22 evidence; a 2026-09-24
filler probe (two turns, one reading a 506 KB block, resumed) crossed no
observable boundary, and hcn events carry no timestamps, so no silent gap
could be measured this cycle.

## Normalization

None.
