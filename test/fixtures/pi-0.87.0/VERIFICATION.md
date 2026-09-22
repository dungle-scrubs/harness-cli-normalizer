# pi 0.87.0 verification

Captured on pro, 2026-09-22, with `zai/glm-5.2`. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture, carried
forward unchanged, the same way `test/fixtures/pi-0.86.1` carried them.

```sh
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:seven
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=<fresh git workspace> SMOKE_CAPTURE_DIR=<dir> bun run smoke:questions
```

All seven scenarios pass (`seven.snapshot.json`) and the question probe passed
on the first attempt (`questions.snapshot.json`). `fresh.ndjson` is capture 01
of the seven run and `question.ndjson` is capture 01 of the question run, both
native stdout.

## What moved with this anchor

`nativeContextManagement` was `null`, which the descriptor defines as unknown
support. It is now
`{ kind: "auto-compaction", modes: ["headless-turn", "headless-session"] }`.
The evidence is the live probe in
`docs/research/2026-09-22-compaction-signals/pi`, run on 0.87.0 on the same
day: auto-compaction fires in `-p --mode json` (including through hcn's resume
grammar) and in `--mode rpc`, and the stream carries a `compaction_start` /
`compaction_end` pair around a 7-to-10-second silence. `interactive` was not
probed and is not claimed. This closes the gap issue #227 filed against the
0.86.1 anchor; hcn's decoder still drops both records, which is issue #239 and
not part of this bump.

`contextHook` and `contextInspection` stay `null`. The 0.86.2-0.87.0 changelog
adds no pending-prompt accounting interface: 0.87.0 adds canonical session
context and extension boundaries, full-transcript context extensions, and
per-model image input limits.

One 0.87.0 breaking change touches this repository and is recorded, not acted
on: `ContextEditEntry` joins the exported `SessionEntry` union, so sessions can
carry a `context_edit` entry. `src/interpretation/transcript/pi.ts` maps it to
`"unknown"`, because its metadata list is `model_change`,
`thinking_level_change`, `label`, `session_info`. Preserving an unrecognized
entry opaquely is the documented transcript behaviour, so nothing here breaks;
no `context_edit` entry appeared in either capture.

## Normalization

Two mechanical edits, on four lines of each capture. Every other byte is the
harness's own, and a line-by-line comparison against the raw captures confirms
only those lines differ.

1. **Path.** The smoke workspace prefix is replaced with `/hcn-verify`, leaving
   `/hcn-verify/smoke-ws-pi`, matching the 0.86.1 capture's spelling. The
   workspace was a throwaway git repository that does not survive the session.
2. **Operator agent configuration**, the one redaction `AGENTS.md` requires.
   Pi echoes its discovered context back into `message.sections`, so
   `docs` (1325 chars), `project_context` (40140 chars) and `skills`
   (24407 chars) are replaced by the named-and-sized placeholder on the
   `message_start`, `message_end` and `agent_end` records that carry them. The
   `subagent` tool's description (377 chars) names the operator's own agent
   directories and is replaced the same way. `preamble`, `tools` and `rules`
   are pi's own text and are kept; every other `toolsAdded[].description` is
   kept.

The replacement is done on the raw line text, not by re-serializing the parsed
record, so number formatting elsewhere on those lines is untouched - pi writes
`"input":0.0000672` where a JSON round trip through Python would write
`6.72e-05`.
