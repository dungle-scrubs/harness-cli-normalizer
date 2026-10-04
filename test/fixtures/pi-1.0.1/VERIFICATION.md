# Pi 1.0.1 verification anchor

Fresh native suites ran on 2026-10-03 against the installed npm package
`@earendil-works/pi-coding-agent@1.0.1`, with `SMOKE_HARNESS=pi` and
`SMOKE_MODEL=openai-codex/gpt-6.1-sol`:

- `bun run smoke:seven`: exit 0, seven passing scenarios, no skips or failures.
- `bun run smoke:questions`: exit 0, passing question escalation with
  `done.cause=awaiting-input`; observation version 1.0.1 and date 2026-10-03.

Each suite used its own new synthetic working directory and capture directory.
`seven.snapshot.json` and `questions.snapshot.json` are the suites' result
snapshots, not raw native streams. `version-source.snapshot.json` records the
exact installed package version and its npm publication timestamp, not a moving
latest-version anchor. The descriptor's npm package source remains unchanged.

These receipts establish the current native capability and escalation anchor.
The native decode fixtures in `../pi-1.0.0/` remain unchanged historical
major-release evidence. Decode and compaction tests using them do not claim
fresh 1.0.1 native decode or compaction captures. No raw native stream or operator
configuration was copied into this directory.

Wider Pi patch-delta verification and final integration gates are separate.
