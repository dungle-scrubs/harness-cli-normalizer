# Claude 2.1.274 verification

Captured on pro, 2026-09-17. `README.md` and `resume-last.ndjson` in this
directory are the earlier RFC-06 capture and are unchanged.

The capture session ran inside Claude Code. Every probe below removed the
inherited `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_PID`, and `CLAUDE_EFFORT`
variables first; `CLAUDE_CONFIG_DIR` stayed. A first pass that kept them
reported a 500,000-token window with `autocompactSource: "env"`
(`CLAUDE_CODE_AUTO_COMPACT_WINDOW`). That pass is not kept.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` are the result files of:

```sh
SMOKE_HARNESS=claude SMOKE_MODEL=sonnet SMOKE_CWD=<fresh git workspace> bun scripts/smoke-seven.ts
SMOKE_HARNESS=claude SMOKE_MODEL=sonnet SMOKE_CWD=<fresh git workspace> bun scripts/smoke-questions.ts
```

`smoke:seven` ran with the kill-and-resume codeword prompt introduced in the
same change. All seven scenarios and the question probe pass.

## Native accounting

- `context-native.ndjson`: the raw native `control_response` line from
  `docs/research/2026-09-10-claude-startup/probe-context.mjs`, pointed at the
  2.1.274 executable, fresh case. Model `claude-opus-5`, window 1,000,000,
  `autocompactSource: "model-default"`, zero result turns.
- `context-public.ndjson`: `hcn inspect claude --context --json --model
  claude-opus-5 --no-extensions --no-skills "<synthetic prompt>"`.
- `context-resume-native.ndjson`: the same probe on a forked resume of a
  synthetic `claude-haiku-4-5-20251001` session (marker `HERON-517`). The
  recalled history raises the count; zero result turns.
- `context-session-before.sha256` / `context-session-after.sha256`: the source
  session file digest before and after the forked inspection. They match.

## Native compaction

The same synthetic session was resumed through `hcn run claude --json --model
claude-opus-5 --no-extensions --no-skills --questions none` with
`--env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`: first a filler turn, then
`compaction.ndjson`, which carries `progress` `compact_boundary` and recalls
`HERON-517`. `post-compaction.ndjson` is a later process at the default
threshold that recalls the marker again. The `.stderr.txt` siblings hold the
`spawn:`/`provenance:` lines that were captured on the same stream and split
out; stdout lines are unchanged.

This is a lowered-threshold test on a small synthetic session. It does not
establish full-capacity behavior or lossless recall.

## Normalization

The session scratchpad prefix in the project-directory slug inside the two
`.sha256` files was replaced with `-hcn-verify-`. Nothing else was changed.
