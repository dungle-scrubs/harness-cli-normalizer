# Pi 0.85.1 resume-last verification (RFC-06 Phase 4)

Captured 2026-09-17 against installed `pi 0.85.1` (descriptor
`verifiedAgainst` stays `0.84.2`; a bump needs `smoke:seven` plus
`smoke:questions`).

Probe: native `pi -p` with the exact HCN-rendered resume-last argv, run under
`env -i HOME PATH TERM PI_CODING_AGENT_DIR`, stdin from `/dev/null`, tools
off (`-nt`), model `zai/glm-5.2`:

```text
pi -p --mode json --continue -nt <prompt> --model zai/glm-5.2
```

`resume-last.ndjson` is that run's native stdout: exit 0, resumes the planted
session (`01a0adf4-...`), recalls the planted marker. Zero tool calls, no
hook records. The volatile scratch prefix in the session-header `cwd` is
path-normalized to `<resume-last-scratch>` (1 line); the workspace leaf name
is kept. Secret-scan at capture: 0 token/key/email matches.
