# Phase 10 - pi rpc resume probe (issue #89)

Can `pi --mode rpc` be opened against an id that already exists, restoring
that conversation into a live session? Captured 2026-08-23 on `pro`, pi 0.84.2.

## Answer: yes.

Two rpc sessions, same `--session-id`, driven by `drive.mjs` - which writes one
prompt and holds stdin until `agent_settled` before closing.

- `rpc-establish.ndjson` - first session. 29 lines. Establishes the codeword
  "pomegranate"; the model replies "OK". stderr carries
  `Warning: No project session found with id ...; creating a new session with
  that id.` (`rpc-establish.stderr.txt`).
- `rpc-resume.ndjson` - second session, same id, asking for the codeword.
  44 lines, and the reply is `pomegranate`. **No warning on stderr** - the
  session was found, not created.

## What this corrects

`src/knowledge/pi.ts` declares `sessionMode.idFlag: null` with the comment
"the harness refuses unknown ids and mints its own". Both halves are wrong for
0.84.2: rpc accepts `--session-id`, and an unknown id is created rather than
refused - pi says so on stderr in as many words.

pi's `--resume`/`-r` is an interactive browser ("Browse and select a session",
`docs/usage.md:200`), not a headless resume. `--session-id` is the headless
path, which is why `hcn run --resume` already renders to it.

## Method note

A first attempt wrote the prompt and closed stdin immediately. rpc's `prompt`
returns `{"success": true}` at once and streams the turn afterwards, so pi
exited before running anything: 18 lines, no `text_delta`, no session written.
Those captures are discarded. Holding stdin until `agent_settled` is required,
as `../pi-rpc-spike/06-resume-after-close/README.md` also records.
