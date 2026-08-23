# Phase 11 - claude --resume in a stream-json session (issue #93)

Does claude accept `--resume` alongside the session-mode flags, and does it
restore context? Captured 2026-08-23 on `pro`, claude 2.1.240.

Driver: `scripts/probe-claude-stream-session.mjs` writes one user message and holds stdin until the `result`
event before closing, the same shape the pi probe needed.

## Answers

**1. Does claude accept `--resume` with stream-json? Yes.**
`claude -p --input-format stream-json --output-format stream-json
--include-partial-messages --verbose --resume <id>` starts, exit 0, clean
stderr. So the session argv can carry `--resume` instead of the `--session-id`
it carries today.

**2. Does it carry the prior conversation? Yes.**
`session-id-establish.ndjson` opens with `--session-id`, sets the codeword
"pomegranate", result `OK`. `resume-restores.ndjson` opens the same id with
`--resume` and the result is `pomegranate`.

**3. An unknown id under `--resume` is REFUSED.**
`resume-unknown-id.ndjson` is one line, exit 1, result subtype
`error_during_execution`, and stderr reads
`No conversation found with session ID: <id>`.

**4. `--session-id` still names a fresh session.** The establish run used it
against an id that did not exist, and it created one silently - no warning,
unlike pi.

## The divergence this exposes

On an unknown id the two harnesses do opposite things:

| harness | flag | unknown id |
|---|---|---|
| claude | `--resume` | refuses, exit 1 |
| claude | `--session-id` | creates silently |
| pi | `--session-id` | creates, warns on stderr |

`RUN_HELP` already says "pi and muse create a new session when the id is
unknown - verify it exists". This confirms claude is the one that refuses, and
that claude has both behaviours depending on which flag is rendered.

So "use this session" is ambiguous on claude, and hcn must decide which of the
two it means when the id is unknown. That is a gap in the decision recorded on
issue #88, not a contradiction of it - the flag shape holds; the unknown-id case
was never settled.
