# Codex 0.153.4 verification

Captured on pro, 2026-09-08, with `gpt-6-astra`, in the disposable directory
`/tmp/lucid-codex-smoke-workspace`. Both smoke commands use hcn's runner.
Only Codex was selected. Runs were sequential, with a 90-second runner deadline
that terminates and reaps the child before returning.

```sh
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/lucid-codex-smoke-workspace SMOKE_CAPTURE_DIR=/tmp/lucid-codex-seven-native bun run smoke:seven
SMOKE_HARNESS=codex SMOKE_MODEL=gpt-6-astra SMOKE_CWD=/tmp/lucid-codex-smoke-workspace SMOKE_CAPTURE_DIR=/tmp/lucid-codex-questions-native bun run smoke:questions
```

The JSON snapshots are the commands' result files. The NDJSON files are native
stdout bytes captured at the spawn boundary: fresh turn, tool use, session
establishment, same-session resume, and question escalation. The evidence test
consumes these files. Streaming deltas and persistent headless sessions remain
unavailable through Codex's `exec` interface and are explicitly skipped.

## Context accounting limitation

`contextInspection` remains null. Codex 0.153.4 has no native preflight count
for the complete pending prompt. Its app-server protocol exposes
`thread/tokenUsage/updated` after execution and replays persisted usage on
resume. That is not a measurement of a newly staged request.

Verified against the installed CLI's generated experimental protocol and
[the exact release source](https://github.com/openai/codex/tree/rust-v0.153.4):
`codex-rs/app-server/src/request_processors/token_usage_replay.rs`,
`codex-rs/core/src/session/inject.rs`, and
`codex-rs/core/src/session/mod.rs`.
`thread/inject_items` records history without executing it, but does not
recompute token usage. No local estimate is substituted for native accounting.
