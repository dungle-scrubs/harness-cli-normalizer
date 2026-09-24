# Popeye 0.1.0 fixtures (fake provider, deterministic)

Captured against popeye 0.1.0 with the repo's fake provider
(`cli-fake-provider.json`: "Fake provider answer."). No inference ran.

- `journal.jsonl`: canonical 24-line session (all envelope kinds).
- `journal-torn.jsonl`: same plus one unterminated tail line.
- `hcn-stream.ndjson`: `--mode hcn` identity/token/message/done records.
- `rpc-create.ndjson`: `--mode rpc` create response with the snapshot.

Session ids are minted per capture; tests must not pin them.
