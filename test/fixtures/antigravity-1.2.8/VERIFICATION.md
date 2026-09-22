# antigravity 1.2.8 verification

Captured on pro, 2026-09-22, against `agy 1.2.8` with
`gemini-3.8-flash-medium` on the free Individual plan.

```sh
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

All seven scenarios pass (`seven.snapshot.json`), including the two that the
descriptor's own claims put on the table here: `session-cont(1proc)`, which
exercises `--input-format stream-json`, and `kill-and-resume`. The question
probe passed on the first attempt (`questions.snapshot.json`), and
`escalation.observedOn` is transcribed from its `observations` record:
`{ harness: "antigravity", model: "gemini-3.8-flash-medium", version: "1.2.8", date: "2026-09-22" }`.

## What moved with this anchor

`nativeContextManagement` was `null`, which the descriptor defines as unknown
support. It is now `{ kind: "auto-compaction", modes: ["headless-session"] }`.
The evidence is the live probe in
`docs/research/2026-09-22-compaction-signals/antigravity`, run on 1.2.8: four
compactions inside one 8-turn `--input-format stream-json` session on
`gpt-oss-120b-medium`, each surfacing as a single
`step_update` with `step_type: "checkpoint"`, `state: "DONE"` and a
`duration_seconds` that matches the measured silent gap to within 13 ms. The
findings file quotes all four records verbatim. `headless-turn` is not claimed:
a one-shot turn has no second request to shrink, and none was probed.

`contextInspection` stays `null`, and the probe supports rather than merely
assumes it: `/context` opens the interactive context panel and is refused in
print mode with a purpose-built error, and no stream field carries a
percentage, a window size or a remaining budget.

1.2.8 is the release that changed compaction. Its changelog spreads the
user-request budget across all captured prompts, sizes summary and truncation
budgets from the model's full context window instead of the compaction trigger
threshold, and fixes a stack-overflow crash when loading or compacting
conversations that contain background-task, subagent, messaging or scheduling
steps. So these compaction facts are anchored to 1.2.8 and must not be read
back onto 1.2.7.

The 1.2.7 probe's other conclusions are unchanged by the release: argv, stream
shape, permission, session, resume and model contracts all behave as the
descriptor records, which is what the seven scenarios re-check.

## Normalization

None. Every line in `fresh.ndjson` and `question.ndjson` is the harness's own
stdout, byte for byte, including the `init.cwd` absolute path and the
conversation ids. Antigravity does not echo the operator's agent configuration
into its stream - the `init` record lists tool names only, with no
descriptions, no discovered instruction files and no skill library - so the one
redaction `AGENTS.md` requires has nothing to remove here. Checked by hand
before filing.
