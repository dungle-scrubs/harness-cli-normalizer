# Claude 2.1.278 verification

Captured on pro, 2026-09-20. `README.md` and `resume-last.ndjson` in this
directory are the earlier RFC-06 capture, carried forward unchanged.

The capture session ran inside Claude Code. Every probe below removed the
inherited `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_PID`, and `CLAUDE_EFFORT`
variables first; `CLAUDE_CONFIG_DIR` stayed. This machine had
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` set, which is the variable that skewed the
first 2.1.274 pass, so the scrub is not optional here.

## Smoke suites

`seven.snapshot.json` and `questions.snapshot.json` are the result files of:

```sh
SMOKE_HARNESS=claude SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=claude SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

The smoke default pins `sonnet` on claude. All seven scenarios and the
question probe pass, unchanged from 2.1.274.

## Native accounting

The workspace is a synthetic git repository; the session carries marker
`HERON-517` and was created with `claude-haiku-4-5-20251001`.

- `context-native.ndjson`: the raw native `control_response` line from a copy
  of `docs/research/2026-09-10-claude-startup/probe-context.mjs` pointed at
  the 2.1.278 executable, fresh case. Model `claude-opus-5`, window
  1,000,000, `autocompactSource: "model-default"`, 5,605 tokens.
- `context-public.ndjson`: `hcn inspect claude --context --json --model
  claude-opus-5 --no-extensions --no-skills "<synthetic prompt>"`.
- `context-resume-native.ndjson`: the same probe on a forked resume of that
  session. The recalled history raises the count to 24,244.
- `context-session-before.sha256` / `context-session-after.sha256`: the source
  session file digest before and after the forked inspection. They match, so
  the fork left the source session untouched.

## Native compaction

The same session was resumed through `hcn run claude --json --model
claude-opus-5 --no-extensions --no-skills --questions none` with
`--env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`: first a filler turn, then
`compaction.ndjson`, which recalls `HERON-517`.

**Re-captured 2026-09-22 under ADR 0009.** The compaction records used to
decode to `progress` labels. They are now `compaction` events, so the fixture
was re-captured rather than edited. The crossing reports
`tokensBefore: 50467`, `tokensAfter: 4182` and `durationMs: 47139`, all
claude's own numbers.

Two things in this capture are worth reading before comparing it to another
run. Claude emitted **two** `status: "compacting"` records, so the fixture
holds two `started` events for one compaction; the decoder reads one record at
a time and reports each, because suppressing the second would mean holding
state and deciding that the harness repeated itself. Count `compacted`, not
`started`. And the 47.1 s pause is longer than the 25 to 28 s the research
probe measured on the same version, so the band is wider than one run shows. `post-compaction.ndjson` is a later process at the default
threshold that recalls the marker again. The `.stderr.txt` siblings hold the
`spawn:`/`provenance:` lines captured on the same run; stdout is unchanged.

This is a lowered-threshold test on a small synthetic session. It does not
establish full-capacity behavior or lossless recall.

The `hook_started` / `hook_response` progress events in `compaction.ndjson`
come from the capture machine's own Claude Code hooks. hcn decodes them to a
label and nothing else, so they carry no hook name, path, or output.

## Normalization

None. The workspace lived at a durable path inside the repository's
`.scratch/`, so no run path needed rewriting.
