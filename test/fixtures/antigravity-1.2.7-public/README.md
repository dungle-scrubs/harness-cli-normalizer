# Antigravity CLI 1.2.7 public fixtures

These NDJSON records are reduced from the event shapes published in Google's
current Antigravity CLI documentation on 2026-09-19:

- <https://antigravity.google/docs/cli/headless/>
- <https://antigravity.google/docs/cli/commands/resume>

They contain no authenticated account data. They prove that HCN decodes the
public wire contract. They do not qualify account-backed behavior, native
permission denials, plan-specific model availability, quota failures, signal
handling, or native transcript creation.

`success.ndjson` covers init identity, an agent-response delta, and a successful
terminal result. `tool.ndjson` covers the documented completed tool shape.
`auth-error.ndjson` covers the documented structured non-success result shape
and authentication-required classification.
