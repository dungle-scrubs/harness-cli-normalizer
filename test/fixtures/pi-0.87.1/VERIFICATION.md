# pi 0.87.1 verification

Captured on pro, 2026-09-24, with `zai/glm-5.2`. `README.md`,
`resume-last.ndjson`, and `question.ndjson` are the earlier captures,
carried forward unchanged.

```sh
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=/tmp/hcn-smoke-ws/pi SMOKE_CAPTURE_DIR=.smoke/runs/pi-2026-09-24 bun run smoke:seven
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=/tmp/hcn-smoke-ws/pi SMOKE_CAPTURE_DIR=.smoke/runs/pi-2026-09-24 bun run smoke:questions
```

All seven scenarios pass and the question probe passed on the first attempt.
`fresh.ndjson` is capture 01 of the seven run. `escalation.observedOn`:
`{ harness: "pi", model: "zai/glm-5.2", version: "0.87.1", date:
"2026-09-24" }`.

## Compaction re-probe: not reproduced

`nativeContextManagement` declares auto-compaction on 0.87.0 live evidence.
The 0.87.1 re-probe did not reproduce it, across seven attempts:

- a 506 KB synthetic filler read into a session (194,364 total tokens on a
  `--continue` resume, confirmed in the raw `pi -p --mode json` stream), and
- `compaction.reserveTokens` forced at 500,000, then 950,000, then
  5,000,000 - first as `<project>/.pi/settings.json` (after `git init`, so
  the project root resolves), then as `~/.pi/agent/settings.json` (removed
  immediately after each run).

No `compaction_start` or `compaction_end` record appeared in any raw stream,
and no `compact*` string anywhere in them. The threshold rule
(`contextTokens > contextWindow - reserveTokens`) should have crossed at
5,000,000 reserve under any window. Whether settings resolution failed or
the pre-prompt check changed in 0.87.1 was not determined. The declaration
keeps its 0.87.0 evidence (`docs/research/2026-09-22-compaction-signals/pi`);
the 0.87.x changelog keeps compaction under active development, so the miss
is unexplained, not evidence of removal.

## Normalization

None.
