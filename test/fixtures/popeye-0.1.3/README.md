# Popeye 0.1.3 fixtures (fake provider, deterministic)

Captured against popeye 0.1.3 on 2026-09-25 with the fake provider
(`POPEYE_FAKE_PROVIDER=1`,
`POPEYE_FAKE_PROVIDER_SCRIPT` -> popeye repo
`packages/cli/test-fixtures/cli-fake-provider.json`,
`POPEYE_MODEL=fake-model`,
`POPEYE_BASE_URL=http://127.0.0.1:1234/v1`). No inference ran.

- `journal.jsonl`: live 6-line text-only session (header, session_root,
  user and assistant messages, turn operation records) written by the
  0.1.3 writer under `<cwd>/.popeye/sessions`.
- `hcn-stream.ndjson`: `--mode hcn` identity/token/message/done records.
- `rpc-create.ndjson`: `--mode rpc` create response with the snapshot.

The all-envelope-kinds 24-line synthetic journal stays in
`popeye-0.1.0/` (journal format is still version 1). Session ids are
minted per capture; tests must not pin them.
