# Claude 2.1.285 verification

Captured on pro, 2026-09-30. `README.md` and `resume-last.ndjson` are the
earlier RFC-06 capture, carried forward unchanged.

Every probe scrubbed `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `CLAUDE_CONFIG_DIR`
stayed.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` are the result files of:

```sh
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-30 bun run smoke:seven
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-30 bun run smoke:questions
```

The smoke default pins `sonnet`. All seven scenarios and the question probe
pass. `escalation.observedOn` is transcribed from the questions
`observations` record: `{ harness: "claude", model: "sonnet", version:
"2.1.285", date: "2026-09-30" }`.

## Native accounting

Workspace: a synthetic git repository at
`.scratch/harness-bump-2026-09-30/ws-claude`; session carries marker
`HERON-1029`, created with `claude-haiku-4-5-20251001`
(session `1873eb8d-08a3-4ff3-a8fb-66e2e1c2c5a4`).

- `context-native.ndjson`: the 2026-09-29 harness-bump probe's context
  script (`.scratch/harness-bump-2026-09-30/probe-context-285.mjs`),
  argv[0] repointed at the 2.1.285 executable, fresh case. Model
  `claude-opus-5`, window 1,000,000, input limit 967,000, 6,924 tokens.
- `context-public.ndjson`: `hcn inspect claude --context --json --model
  claude-opus-5 --no-extensions --no-skills "<synthetic prompt>"`, run from
  source (`bun src/cli/index.ts`) with the bumped anchor; a dist rebuild is
  deferred to the coordinator's full gate.
- `context-resume-native.ndjson`: the same probe on a forked resume; the
  recalled history raises the count to 24,742. The staged synthetic prompt
  rides in exactly one user frame in both cases; zero assistant frames and
  the result frame reports `num_turns: 0`, so no assistant execution ran.
- `context-session-before.sha256` / `context-session-after.sha256`:
  identical digests, so the fork left the source session untouched.

## Native compaction

The marker session grew by two haiku filler turns (40-line synthetic lists),
then the recall turn resumed it through `hcn run claude --json --model
claude-opus-5 --no-extensions --no-skills --questions none --env
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`. `compaction.ndjson` recalls `HERON-1029`.
This capture holds **two** `status: "compacting"` records (2.1.284 held
three - the count is not stable across runs), so two `started` events precede
one `compacted`: `tokensBefore: 27632`, `tokensAfter: 5472`,
`durationMs: 58667` - shorter than 2.1.284's 76.4 s and 2.1.281's 66.5 s
pause. Count `compacted`, not `started`.
`post-compaction.ndjson` is a later process at the default threshold that
recalls the marker again. The `.stderr.txt` siblings hold the
`spawn:`/`provenance:` lines; stdout is unchanged.

A smaller variant of the same session (one exchange, no fillers) compacted
and **failed** with claude's own `too_few_groups` detail, preserved as a
`compaction failed` event with the turn still clean - the failure outcome
surfaces; it is not captured as a fixture (the passing capture is the
contract evidence; the run is retained at
`.scratch/harness-bump-2026-09-30/compaction-failed-285.ndjson`).

Lowered-threshold test on a small synthetic session: it does not establish
full-capacity behavior or lossless recall.

## Normalization

None. The workspace lived at a durable path inside the repository's
`.scratch/`. The evidence test's transcribed compaction numbers moved with
this capture (tokensBefore/tokensAfter/durationMs); the started-record count
in its comment now names this capture's two (prior capture: three).
