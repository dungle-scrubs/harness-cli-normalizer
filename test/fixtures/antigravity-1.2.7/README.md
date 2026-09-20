# Antigravity CLI 1.2.7 authenticated fixtures

These are native records captured through HCN on 2026-09-19 from the
installed, signed Google Antigravity CLI 1.2.7 binary. The account used the
free Individual plan and `gemini-3.8-flash-medium`.

Each retained NDJSON line is verbatim. Some fixtures select only the records
needed by their test from a longer raw capture. The complete captures remain in
the task evidence directory outside the repository.

- `success.ndjson` proves identity, token deltas, usage, and a successful result.
- `tool.ndjson` proves the completed `run_command` shape.
- `permission-denied.ndjson` proves an `ERROR` tool step, a structured
  `TOOL_ERROR`, a successful native result, and `denied_actions` on exit 0.
- `sandbox-boundary.ndjson` proves `--sandbox` blocks a shell write outside the
  workspace even when autonomy is enabled.
- `persistent-session.ndjson` proves two turns retain one conversation ID.
- `resume-last.ndjson` proves the most-recent conversation is reused.
- `unknown-conversation.ndjson` proves an unknown requested ID starts a fresh
  conversation with a different native ID.
- `unknown-model.ndjson` proves model validation is a structured non-success
  native result.
- `malformed-input.ndjson` proves malformed persistent input is a structured
  non-success native result.

Absolute paths and native metadata are intentionally preserved as evidence.
Quota failure was not captured because exhausting the free allowance was not
part of qualification.
