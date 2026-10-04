# Claude Code 2.1.289 qualification

Fresh qualification ran on pro on 2026-10-04. The installed `claude --version`
and official npm latest endpoint both reported 2.1.289. The npm provenance is
recorded in `version-source.snapshot.json`.

## Fresh native suites

`bun run smoke:seven` and `bun run smoke:questions` ran from the checkout with
`SMOKE_HARNESS=claude` and `SMOKE_MODEL=sonnet`. Each suite used a separate new
synthetic `SMOKE_CWD` and separate `SMOKE_CAPTURE_DIR`. Seven scenarios passed
(exit 0); the question suite passed (exit 0), observing claude, sonnet,
2.1.289, 2026-10-04. Only result snapshots are published here. No raw native
streams or operator configuration are copied into this directory.

## Historical context and decode evidence

The 2.1.289 official patch delta was inspected at
https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, together with
https://code.claude.com/docs/en/cli-reference. The delta concerns permission
rules, IDE authentication status, plugins/mods, and interface rendering. It
reports no change to the context-accounting, forked resume, staged-prompt,
compaction, history, or context-window metadata seams. This is a delta review,
not proof that those seams cannot have undocumented changes.

`../claude-2.1.288/` remains the explicitly historical native context and decode
receipt: distinct usage/window accounting, forked resume and source-session
digests, automatic compaction and later-process marker recall, and exact
staging without assistant execution. Its executable-version assertions remain
2.1.288. No old capture was relabeled or modified. Malformed native observations,
compaction history retention, and context-window metadata remain covered by
focused deterministic regressions. These are not fresh native 2.1.289 context
probes; none was required by an identified patch change to those seams.

The npm `versionSource` remains `{ kind: "npm", package:
"@anthropic-ai/claude-code" }`, re-confirmed from the current official endpoint
https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest. The descriptor
anchor and question observation were advanced together from fresh qualification.
