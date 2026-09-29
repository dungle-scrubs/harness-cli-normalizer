# Claude 2.1.284 verification

Captured on pro, 2026-09-29. `README.md` and `resume-last.ndjson` are the
earlier RFC-06 capture, carried forward unchanged.

Every probe scrubbed `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `CLAUDE_CONFIG_DIR`
stayed.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` are the result files of:

```sh
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-29 bun run smoke:seven
SMOKE_HARNESS=claude SMOKE_CWD=/tmp/hcn-smoke-ws/claude SMOKE_CAPTURE_DIR=.smoke/runs/claude-2026-09-29 bun run smoke:questions
```

The smoke default pins `sonnet`. All seven scenarios and the question probe
pass. `escalation.observedOn` is transcribed from the questions
`observations` record: `{ harness: "claude", model: "sonnet", version:
"2.1.284", date: "2026-09-29" }`.

## Native accounting

Workspace: a synthetic git repository at
`.scratch/harness-bump-2026-09-29/ws-claude`; session carries marker
`HERON-1029`, created with `claude-haiku-4-5-20251001`
(session `338c6ec2-0ed4-42cf-854e-c23001db1429`).

- `context-native.ndjson`: the 2026-09-24 harness-bump probe's context
  script (`probe-context-284.mjs`), argv[0] repointed at the 2.1.284
  executable, fresh case. Model `claude-opus-5`, window 1,000,000, input
  limit 967,000, 6,759 tokens.
- `context-public.ndjson`: `hcn inspect claude --context --json --model
  claude-opus-5 --no-extensions --no-skills "<synthetic prompt>"`, against
  the locally built CLI with the bumped anchor.
- `context-resume-native.ndjson`: the same probe on a forked resume; the
  recalled history raises the count to 27,267. The staged synthetic prompt
  rides in exactly one user frame in both cases; zero assistant frames and
  the result frame reports `num_turns: 0`, so no assistant execution ran.
- `context-session-before.sha256` / `context-session-after.sha256`:
  identical digests, so the fork left the source session untouched.

## Native compaction

The marker session grew by two haiku filler turns (40-line synthetic lists),
then the recall turn resumed it through `hcn run claude --json --model
claude-opus-5 --no-extensions --no-skills --questions none --env
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`. `compaction.ndjson` recalls `HERON-1029`.
This capture again holds **three** `status: "compacting"` records, so three
`started` events precede one `compacted`: `tokensBefore: 33316`,
`tokensAfter: 6521`, `durationMs: 76391` - the pause widens again
(2.1.281: 66.5 s). Count `compacted`, not `started`.
`post-compaction.ndjson` is a later process at the default threshold that
recalls the marker again. The `.stderr.txt` siblings hold the
`spawn:`/`provenance:` lines; stdout is unchanged.

A smaller variant of the same session (one exchange, no fillers) compacted
and **failed** with claude's own `too_few_groups` detail, preserved as a
`compaction failed` event with the turn still clean - the failure outcome
surfaces; it is not captured as a fixture (the passing capture is the
contract evidence).

Lowered-threshold test on a small synthetic session: it does not establish
full-capacity behavior or lossless recall.

## Normalization

None. The workspace lived at a durable path inside the repository's
`.scratch/`.
