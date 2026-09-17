# Claude 2.1.274 resume-last verification (RFC-06 Phase 4)

Captured 2026-09-17 against installed `2.1.274` (descriptor `verifiedAgainst`
stays `2.1.263`; a bump needs `smoke:seven` plus `smoke:questions`).

Probe: native `claude -p` with the exact HCN-rendered resume-last argv, run
under `env -i HOME PATH TERM USER LOGNAME TMPDIR CLAUDE_CONFIG_DIR`, stdin
from `/dev/null`, tools denied (`--disallowedTools` over the full tool list),
model `claude-haiku-4-5-20251001`:

```text
claude -p --continue --fork-session <prompt> --output-format stream-json
  --verbose --include-partial-messages --model claude-haiku-4-5-20251001
  --disallowedTools Bash,Edit,Glob,Grep,Read,Write,WebFetch,WebSearch,Monitor,Task,Skill,NotebookEdit,LSP
```

`resume-last.ndjson` is that run's native stdout: exit 0, a NEW fork
`session_id` (`561ce3da-...`, not the planted session), recalling the planted
marker through the fork. Zero tool calls.

Excluded at filing, with counts: 13 `system` hook-record lines
(`hook_started`/`hook_response`/`hook_progress` from user and managed
`SessionStart:startup` sources, which no headless flag suppresses without
breaking auth) and the 1 `system/init` line (it lists account connector
names: Gmail, Google Calendar, Google Drive, reviewsion). The fork announce
is therefore read from `result.session_id` in the evidence test, not from
init. Secret-scan at capture: 0 token/key/email matches.
