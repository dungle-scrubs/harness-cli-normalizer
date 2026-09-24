# Claude 2.1.281 verification

Captured on pro, 2026-09-24. `README.md` and `resume-last.ndjson` are the
earlier RFC-06 capture, carried forward unchanged.

Every probe scrubbed `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `CLAUDE_CONFIG_DIR`
stayed.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` are the result files of:

```sh
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-24 bun run smoke:seven
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-24 bun run smoke:questions
```

The smoke default pins `sonnet`. All seven scenarios and the question probe
pass. `escalation.observedOn` is transcribed from the questions
`observations` record: `{ harness: "claude", model: "sonnet", version:
"2.1.281", date: "2026-09-24" }`.

## Native accounting

Workspace: a synthetic git repository at
`.scratch/harness-bump-2026-09-24/ws-claude`; session carries marker
`HERON-518`, created with `claude-haiku-4-5-20251001`
(session `e904f198-d21e-4082-8ab7-4410666fd564`).

- `context-native.ndjson`: the 2026-09-10 startup probe's context script,
  argv[0] repointed at the 2.1.281 executable, fresh case. Model
  `claude-opus-5`, window 1,000,000, input limit 967,000, 6,662 tokens.
- `context-public.ndjson`: `hcn inspect claude --context --json --model
  claude-opus-5 --no-extensions --no-skills "<synthetic prompt>"`, against
  the locally built CLI.
- `context-resume-native.ndjson`: the same probe on a forked resume; the
  recalled history raises the count to 30,530.
- `context-session-before.sha256` / `context-session-after.sha256`:
  identical digests, so the fork left the source session untouched.

## Native compaction

The marker session resumed through `hcn run claude --json --model
claude-opus-5 --no-extensions --no-skills --questions none --env
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` (filler turn first). `compaction.ndjson`
recalls `HERON-518`. This capture holds **three** `status: "compacting"`
records (2.1.278 held two), so three `started` events precede one
`compacted`: `tokensBefore: 41893`, `tokensAfter: 4643`, `durationMs: 66545`
- the 66.5 s pause widens the band again (2.1.278: 47.1 s). Count
`compacted`, not `started`. `post-compaction.ndjson` is a later process at
the default threshold that recalls the marker again. The `.stderr.txt`
siblings hold the `spawn:`/`provenance:` lines; stdout is unchanged.

Lowered-threshold test on a small synthetic session: it does not establish
full-capacity behavior or lossless recall.

## Normalization

None. The workspace lived at a durable path inside the repository's
`.scratch/`.
