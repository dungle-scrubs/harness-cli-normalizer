# session-skills refusal captures (issue #332)

Captured 2026-09-30, `node dist/cli.js session antigravity --json --skills hcn`.

`session-skills-refusal.ndjson` is stdout, `session-skills-refusal.stderr.txt`
is stderr. Exit code 2: antigravity declares no skills surface (descriptor
`skills: null`), so the session refuses at the render - before any spawn -
with the same `unsupported-option` shape `hcn run antigravity --skills`
refuses with: prose + hint + `supported on:` to stderr, and the
`failure`/`closed` pair on stdout. No session opens.

Note: the hint text on a non-popeye null-skills refusal is the shared muse
wording (pre-existing `renderSkillsSelection` behavior, identical under
`hcn run`); only popeye gets its own hint. Flagged on the ticket, not
changed here.
