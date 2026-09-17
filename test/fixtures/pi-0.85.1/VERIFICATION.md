# pi 0.85.1 verification

Captured on pro, 2026-09-17, with `zai/glm-5.2`. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture and are
unchanged.

```sh
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

All seven scenarios pass (`seven.snapshot.json`). `fresh.ndjson` is capture
01, native stdout.

The first question run failed: `questions-first-attempt.snapshot.json`. The
model asked the question, then a locally installed pi extension (a voice
phrase gate) queued a follow-up rewrite turn, and the work ran past the
runner's 90-second deadline, so the turn ended `killed`. A second run in a
fresh workspace passed with no extension follow-up: `questions.snapshot.json`,
native stream `question.ndjson`. The failure is local configuration, not a
pi 0.85.1 change.

pi declares no context contract (`contextInspection` and
`nativeContextManagement` are null); the 0.84.3-0.85.1 changelog adds no
pending-prompt accounting interface.

## Normalization

The session scratchpad prefix in run paths was replaced with `/hcn-verify`.
