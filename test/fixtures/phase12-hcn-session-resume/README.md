# Phase 12 - hcn session --resume, through hcn's own surface (issue #97)

The earlier phases drove the harnesses directly. These drive `hcn session
--json` itself, so they prove hcn's surface restores a conversation, not only
that the harness can. Captured 2026-08-23 on `pro`, hcn from this branch,
claude 2.1.240.

Each run pipes `{"op":"send",...}` then `{"op":"close"}` on stdin.

## claude - proven

| fixture | invocation | result |
|---|---|---|
| `claude-establish.ndjson` | `--session-id <new id>` | fresh named session; assistant replies `OK` |
| `claude-resume.ndjson` | `--resume <same id>` | assistant replies `pomegranate` - the conversation continued |
| `claude-resume-unknown.ndjson` + `.stderr.txt` | `--resume <unknown id>` | refused **before spawn**, exit 2, `failure` then `closed cause=failed` on the stream; stderr names the missing store path |

A fourth run, not captured, confirmed that `--session-id <unknown id>` still
creates a fresh session (reply `FRESH`) - the path a first draft of this change
broke by treating every `--session-id` as a resume.

## pi - not provable here, and not because of resume

`hcn session pi --json` runs a turn that produces no model output and ends
`done clean`, on shipped `main` as well as this branch. pi creates its per-cwd
directory and writes no session file. Filed as #99. Until that is fixed there
is no pi session through hcn to resume into. pi's own rpc mode does resume -
`../phase10-pi-rpc-resume/` proves it directly.

## How "resume" is decided

`--resume` and `--session-id` are aliases for "use this session". Which
descriptor flag hcn renders is decided by the store, not by the spelling: an id
that exists in the harness's store is resumed (`resumeFlag`), one that does not
names a fresh session (`idFlag`). The one refused combination is explicit
`--resume` on an id that does not exist - a caller who said "resume" and would
silently get a new conversation is issue #86 exactly.
