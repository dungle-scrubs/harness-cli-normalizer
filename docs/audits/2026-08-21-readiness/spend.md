time | dimension | command | harness | model | turns | exit | evidence
2026-08-21T04:15:12Z | D11 | node dist/cli.js run claude --json --prompt "Reply with only: alpha" | claude | default | 1 | 0 | audit/live/claude.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run codex --json --prompt "Reply with only: alpha" | codex | default | 1 | 0 | audit/live/codex.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run pi --json --prompt "Reply with only: alpha" | pi | default | 1 | 0 | audit/live/pi.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run muse --json --prompt "Reply with only: alpha" | muse | default | 1 | 0 | audit/live/muse.ndjson
2026-08-21T04:15:49Z | D11 | perl timeout 120 node dist/cli.js run pi --json --prompt "Reply with only: alpha" (backgrounded, no stdin redirect) | pi | default | 1 | 0 | audit/live/pi-bg.ndjson
2026-08-21T04:14:55Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness claude | claude | default | 2 | 0 | SCRATCH/audit/live/e2e-claude.json
2026-08-21T04:15:55Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness codex | codex | default | 2 | 0 | SCRATCH/audit/live/e2e-codex.json
2026-08-21T04:16:23Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness pi | pi | default | 2 | 0 | SCRATCH/audit/live/e2e-pi.json
2026-08-21T04:17:13Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness muse | muse | default | 2 | 0 | SCRATCH/audit/live/e2e-muse.json
2026-08-21T04:14:52Z | D6 | bun scripts/smoke-claude.ts | claude | sonnet (scenario 1) + default | 5 | 1 | SCRATCH/audit/live/smoke-claude.json
2026-08-21T04:17:31Z | D1 | node dist/cli.js run claude --json --prompt "Count slowly from 1 to 40, one number per line" (SIGTERM at first token) | claude | default | 1 | 1 | audit/live/kill-1.ndjson
2026-08-21T04:18:55Z | D1 | node dist/cli.js run claude --json --resume aa0b85d6-cdbf-457a-baca-fc0360437e8e --prompt "Reply with only the last number you reached" | claude | default | 1 | 0 | audit/live/kill-2.ndjson
2026-08-21T04:14:54Z | D7 | bun scripts/e2e.ts --only session-live-ask --harness claude | claude | default | unknown (scenario-internal, <=4 session turns) | 0 | SCRATCH/audit/live/e2e-session-live-ask.stdout
