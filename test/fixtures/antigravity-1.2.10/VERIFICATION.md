# antigravity 1.2.10 verification

Captured on pro, 2026-09-24, against `agy 1.2.10` with
`gemini-3.8-flash-medium` on the free Individual plan. `README.md` is the
earlier capture, carried forward unchanged. `fresh.ndjson` is the 1.2.8
capture, carried forward; `question.ndjson` is this cycle's question-run
capture.

```sh
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=/tmp/hcn-smoke-ws/antigravity SMOKE_CAPTURE_DIR=.smoke/runs/antigravity-2026-09-24 bun run smoke:seven
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=/tmp/hcn-smoke-ws/antigravity SMOKE_CAPTURE_DIR=.smoke/runs/antigravity-2026-09-24 bun run smoke:questions
```

All seven scenarios pass, including `session-cont(1proc)` and
`kill-and-resume`. The question probe passed on the first attempt.
`escalation.observedOn`: `{ harness: "antigravity", model:
"gemini-3.8-flash-medium", version: "1.2.10", date: "2026-09-24" }`.

The version moved during this cycle: the binary auto-updated from 1.2.9 to
1.2.10 between two checks on the same day.

## Compaction re-probe: not reproduced

`nativeContextManagement` declares auto-compaction (`headless-session`) on
1.2.8 live evidence (four checkpoints in one 8-turn stream-json session).
The 1.2.10 re-probe did not reproduce it, across three multi-turn
`hcn session antigravity --json` sessions: 8 turns on
`gemini-3.8-flash-medium`, 8 turns on `gpt-oss-120b-medium`, and 10 turns on
`gpt-oss-120b-medium` with three 75 KB filler reads (an earlier 506 KB
filler attempt crashed the child at the read turn). All sessions completed
cleanly with marker recall; none emitted a checkpoint `step_update`.
`compaction-reprobe-session.ndjson` is the 10-turn session's full event
stream (hcn events, no raw echo). The 1.2.10 changelog still ships
compaction-checkpoint fixes ("Fixed context compaction failing when the
tool configuration used for compaction checkpoints was rejected"), so the
claim keeps its 1.2.8 evidence and the miss is recorded, not resolved.

Two operational notes from the probes: sending all session commands at once
crashed the agy child (`closed` cause `crash`) - commands must be sent one
turn at a time; and `contextInspection` stays null with `/context` still
refused in print mode.

## Normalization

None.
