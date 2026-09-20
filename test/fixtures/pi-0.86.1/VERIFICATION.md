# pi 0.86.1 verification

Captured on pro, 2026-09-20, with `zai/glm-5.2`. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture,
carried forward unchanged.

```sh
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

All seven scenarios pass (`seven.snapshot.json`). `fresh.ndjson` is capture
01 of the seven run and `question.ndjson` is capture 01 of the question run,
both native stdout.

The question probe passed on the first attempt. The 0.85.1 anchor needed a
retry, because a locally installed pi extension queued a follow-up and pushed
the turn past the runner's 90-second deadline; that first-attempt snapshot
stays in `test/fixtures/pi-0.85.1` and is not carried forward.

pi declares no context contract (`contextInspection` and
`nativeContextManagement` are null). The 0.85.2-0.86.1 changelog adds no
pending-prompt accounting interface: 0.86.0 adds prompt-cache warming, `/bug`
reporting, transcript-aware prompt and tool updates, an offline Radius
catalog and per-model compaction budgets, and 0.86.1 adds the Meta provider.

pi does run its own auto-compaction, which `nativeContextManagement: null`
does not describe. That gap predates this bump and is filed as issue #227; it
is not a 0.86.x change and nothing here asserts a compaction capability for
pi.

## Normalization

The two capture files ran from the harness session scratchpad, which does not
survive the session. One mechanical substitution replaced that prefix with
`/hcn-verify`, leaving `/hcn-verify/smoke-ws-pi`. Nothing else was changed.
