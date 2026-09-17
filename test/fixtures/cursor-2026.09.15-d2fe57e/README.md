# Cursor 2026.09.15-d2fe57e resume-last verification (RFC-06 Phase 4/5)

Captured 2026-09-17 against installed `2026.09.15-d2fe57e` (landed
`verifiedAgainst` is `2026.09.10-fd3934a`; a bump needs `smoke:seven` plus
`smoke:questions`).

Probe: native `agent -p` with the exact HCN-rendered resume-last argv, run
under `env -i HOME PATH TERM XDG_CONFIG_HOME`, stdin from `/dev/null`,
prompt-level tool gate (`Do not call any tools.`; cursor has no off switch),
autonomy after the stream flags per `turnTail`:

```text
agent -p --continue <prompt> --output-format stream-json
  --stream-partial-output --force
```

`resume-last.ndjson` is that run's native stdout: exit 0, re-enters the
planted session, recalls the planted marker through `assistant` records plus
a non-empty `result`. Zero tool calls, no hook records. The volatile scratch
prefix in the init `cwd` is path-normalized to `<resume-last-scratch>`
(1 line); the workspace leaf name is kept. Secret-scan at capture: 0
token/key/email matches.

Note: resume turns on the auto model are flaky (thinking-only turns with
`result.result` empty and exit 0 occur on both the pinned order and the
`--force`-first order, and on raw CLI runs outside hcn). This filed capture
is a replying run; see the Phase 4 evidence for the full position series.
