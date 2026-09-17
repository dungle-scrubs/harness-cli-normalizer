# Cursor 2026.09.15-d2fe57e verification

Captured on pro, 2026-09-17, logged in, default model. `README.md` and
`resume-last.ndjson` in this directory are the earlier RFC-06 capture and are
unchanged.

## Smoke suites

`seven.snapshot.json`: `SMOKE_HARNESS=cursor bun run smoke:seven` in a fresh
git workspace. Six pass, persistent session skipped. The kill-and-resume
scenario failed three times with the old prompt ("Reply with only the word
from before."): the model answered its own earlier reply, `OK`, and it did the
same on an uninterrupted resume. An explicit question after the kill recalled
`otter`. The scenario now names a codeword, and this snapshot is from that
script.

`questions.snapshot.json`: `smoke:questions` in a workspace trusted once with
`agent -p --trust`. The probe renders no autonomy flag, so an untrusted
workspace ends at the trust gate instead.

## Decoding corpus re-capture

Each probe ran `agent -p` in a trusted git workspace containing `notes.txt`
and `other.txt`, stdin closed. Prompts repeat the 2026.09.10-fd3934a probes.

| File | Flags | Prompt | Evidence |
| --- | --- | --- | --- |
| `probe-11.ndjson` | `--output-format stream-json --stream-partial-output` | four-line River poem | token deltas plus one flush message |
| `probe-11b.ndjson` | `--output-format stream-json` | `Reply with only: pong` | message only, no tokens |
| `probe-13.ndjson` | `--output-format stream-json` | append `probe13` to notes.txt | read then edit tool, messages carry `model_call_id` |
| `probe-15.ndjson` | `--output-format stream-json` | fetch example.com | web fetch denial, `User Rejected` |
| `probe-15s.ndjson` | `--output-format stream-json` | run `curl -sI https://example.com` | shell denials with empty reason, then a fetch denial |
| `probe-20.ndjson` | `--output-format stream-json` | ask which file via ask-question tool | query pair before `started`, denied ask call |
| `probe-43.ndjson` | `--output-format stream-json --stream-partial-output` | read notes.txt, reply `READ-OK` | partial deltas on a tool turn |
| `probe-51.ndjson` | `--output-format stream-json --force` | web search Node.js LTS | pre-approved query pair before `started` |
| `probe-52.ndjson` | `--output-format stream-json --force` | fetch example.com | query pair mid-call |
| `probe-52s.ndjson` | `--output-format stream-json --force` | run `curl -sI https://example.com` | shell call with no query pair |
| `trust-01.stderr.txt` | `--output-format stream-json`, untrusted workspace | `Reply with only: OK` | trust gate, exit 1 |
| `help.stdout.txt` | `agent --help` | | variadic prompt usage |
| `models.txt` | `agent models` | | the same 223 slugs; only the `(current)` marker moved |

Not re-observed: a web search completion with no `started` record (2026.09.10
probe 15). The model made no such call in these runs; the earlier corpus keeps
that evidence and its test.

## Normalization

The session scratchpad prefix in run paths was replaced with `/hcn-verify`.
Dash-slugged forms of that path inside tool results (for example
`~/.cursor/projects/<slug>/agent-tools/`) are kept as captured. Secret scan:
no `sk-`, `crsr_`, bearer, JWT, AWS, GitHub, or Slack token shapes, and no
email addresses.
