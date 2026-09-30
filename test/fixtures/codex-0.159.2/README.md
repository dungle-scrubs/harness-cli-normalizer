# Codex 0.154.0 resume-last verification (RFC-06 Phase 4)

Captured 2026-09-17 against installed `codex-cli 0.154.0` (descriptor
`verifiedAgainst` stays `0.153.4`; a bump needs `smoke:seven` plus
`smoke:questions`).

Probe: native `codex exec` with the exact HCN-rendered resume-last argv, run
under `env -i HOME PATH TERM`, stdin from `/dev/null`, read-only sandbox
(`-c sandbox_mode="read-only"` in the before-prompt slot), model `gpt-5.5`:

```text
codex exec resume --last --json --skip-git-repo-check
  -c sandbox_mode="read-only" <prompt> --model gpt-5.5
```

`resume-last.ndjson` is that run's native stdout: exit 0, resumes the planted
thread (`01a0ae03-...`), recalls the planted marker. Zero tool calls, no hook
records, no paths. Filed as-is. Secret-scan at capture: 0 token/key/email
matches.
