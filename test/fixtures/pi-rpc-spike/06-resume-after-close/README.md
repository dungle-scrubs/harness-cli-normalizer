# 06 - resume an rpc-minted pi session with a one-shot run

Captured 2026-08-21 on pi 0.84.2 (macOS, air). Answers audit finding F-26:
can a session id minted by `pi --mode rpc` (identity read through the
`get_state` probe, no `--session-id` flag on open) be resumed afterwards
by `hcn run pi --resume <id>`?

Steps:

1. `pi --mode rpc` opened with a piped stdin (`rpc-turn.ndjson` is its
   stdout). First write: `{"id":"probe","type":"get_state"}`. The response
   carried `data.sessionId = 01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa`.
2. One prompt written over rpc: "Remember the codeword: otter. Reply with
   only: OK". The turn ran to `agent_settled`; stdin was then closed and
   pi exited 0.
3. `hcn inspect pi --argv --resume 01a022e3-... --prompt "Reply with only
   the codeword you were told."` produced `resume.argv.json`: the id rides
   `--session-id`, then `-p --mode json --thinking high <prompt> --tools
   read,bash,edit,write,grep,find,ls`.
4. That argv was run directly with stdin closed. `resume.ndjson` is its
   stdout: exit 0, 207 lines, and the reply text contains "otter".

Outcome: the rpc-minted id resumes through the one-shot grammar. Resume
half of F-26 proven; the probe half was already proven by 01-startup.
