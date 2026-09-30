# antigravity 1.2.14 verification

Captured on pro, 2026-09-30, against `agy 1.2.14` with
`gemini-3.8-flash-medium` on the free Individual plan. `README.md` is the
earlier capture, carried forward unchanged. `fresh.ndjson` is this cycle's
seven-run single-turn capture; `question.ndjson` is this cycle's question-run
capture; `compaction-reprobe-session.ndjson` is this cycle's compaction
re-probe stream (the prior cycle's 1.2.10 re-probe stream was not
re-captured and stays in `test/fixtures/antigravity-1.2.10`).

```sh
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=/tmp/hcn-smoke-ws/antigravity SMOKE_CAPTURE_DIR=.smoke/runs/antigravity-2026-09-30 bun run smoke:seven
SMOKE_HARNESS=antigravity SMOKE_MODEL=gemini-3.8-flash-medium SMOKE_CWD=/tmp/hcn-smoke-ws/antigravity SMOKE_CAPTURE_DIR=.smoke/runs/antigravity-2026-09-30 bun run smoke:questions
```

All seven scenarios pass, including `session-cont(1proc)` and
`kill-and-resume`. `escalation.observedOn`: `{ harness: "antigravity", model:
"gemini-3.8-flash-medium", version: "1.2.14", date: "2026-09-30" }`.

The version moved before this cycle started: the task brief named 1.2.13, but
the binary had already auto-updated to 1.2.14 (binary mtime 11:35 local) by
the first check. The version held at 1.2.14 across three checks spanning the
whole cycle, so every capture here is 1.2.14 and the anchor is 1.2.14, the
same resolution as the 1.2.9-to-1.2.10 move last cycle.

Two cycles ran concurrently in the same checkout and both write
`.smoke/seven.json` / `.smoke/questions.json`; the fixture snapshots were
re-captured until a copy landed that belongs to this harness's run. The
first seven run (7/7) and the first question run (pass) were lost that way;
their raw native captures in the run directories were unaffected and one is
preserved in the question-run capture described below.

## Question probe: passes, with mode-dependent flakiness

The question probe passed on the first attempt (04:40Z), then missed six
consecutive times before passing again (05:00Z). The misses are real and
mode-shaped: without `--dangerously-skip-permissions`, `init` now reports
`permission_mode: "request-review"` (1.2.10 captures report
`always-proceed` there), and under it the model usually routes the
clarifying question through its `ask_question` tool. Print-mode
`stream-json` does not surface that tool call, so the turn ends `done=clean`
with an empty message and hcn sees no question. With the flag, `init`
reports `always-proceed` (probed manually, all three mode-diagnostic runs),
and the question comes back as text.

The final pass itself ran under `request-review` and still emitted the
`hcn-question` block as text, so text escalation works on 1.2.14 in both
modes and the routing choice is model-stochastic, not mode-determined. What
drives the ambient default change is not established: agy's own settings log
says `toolPermission=request-review` even for the morning pass that reported
`always-proceed` in `init`. Recorded, not resolved. No descriptor change
follows: hcn has no permission-mode vocabulary, and the autonomy-flag map
(`--dangerously-skip-permissions` to `always-proceed`) held in every probe.

`/context` is still refused in print mode with the same purpose-built error,
so `contextInspection: null` stands. `agy models` returns exactly the
descriptor's 14-model roster, unchanged. The native tool roster in `init`
gained `run_workflow` (57 to 58 tools); the descriptor's `tools.builtins`
stays empty because hcn does not curate antigravity's tool list.

## Compaction re-probe: not reproduced

`nativeContextManagement` declares auto-compaction (`headless-session`) on
1.2.8 live evidence (four checkpoints in one 8-turn stream-json session).
The 1.2.14 re-probe did not reproduce it, across the bounded three-session
set: 10 turns on `gemini-3.8-flash-medium` with three successful 75 KB
filler reads, 10 turns on `gemini-3.7-flash-medium` with the same recipe,
and `gpt-oss-120b-medium`, which could not be probed today - both attempts
died in the first two turns on a native server error, `UNAVAILABLE (code
503): No capacity available for model gpt-oss-120b-medium on the server`.
That 503 normalized correctly (error event, transport failure marked
retryable, `done` cause `crash` exit 3, then `closed`), matching the
headless exit-code-3 behavior the 1.2.10 changelog documents.
`compaction-reprobe-session.ndjson` is the gemini-3.8 session's full event
stream (hcn events, no raw echo). No session emitted a checkpoint
`step_update`. The claim keeps its 1.2.8 evidence and the miss is recorded,
not resolved.

Operational notes carried forward: session commands must be sent one turn at
a time (batched sends crash the agy child); the 75 KB filler did not crash
the child this cycle; the 506 KB filler was not retried (known child-crasher
from 1.2.10).

## Normalization

None.
