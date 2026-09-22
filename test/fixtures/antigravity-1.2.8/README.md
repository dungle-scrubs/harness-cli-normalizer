# Antigravity CLI 1.2.8 anchor fixtures

Native records captured through HCN on 2026-09-22 from the installed, signed
Google Antigravity CLI 1.2.8 binary, on the free Individual plan with
`gemini-3.8-flash-medium`. These are the version-bump evidence for the
`verifiedAgainst: "1.2.8"` anchor; `VERIFICATION.md` carries the commands and
what moved.

- `seven.snapshot.json` is the `smoke:seven` run: all seven scenarios pass.
- `questions.snapshot.json` is the `smoke:questions` run, and its
  `observations.antigravity` record is what `escalation.observedOn` was
  transcribed from.
- `fresh.ndjson` is capture 01 of the seven run, a native single-turn stdout.
- `question.ndjson` is capture 01 of the question run, carrying the structured
  `hcn-question` block in the agent's own deltas.

The 1.2.7 behavioural corpus stays in `test/fixtures/antigravity-1.2.7`. It
records permission, sandbox, session, resume and validation shapes that this
bump did not re-probe, and the tests that read it still read it.

Absolute paths and native metadata are preserved as evidence, the way the 1.2.7
directory preserves them. Antigravity's stream echoes no operator agent
configuration, so nothing in these files is redacted.
