# Popeye 0.1.4 fixtures (fake provider, deterministic)

Captured against popeye 0.1.4 on 2026-09-27 with the same fake provider
recipe as the 0.1.3 set
(`POPEYE_FAKE_PROVIDER=1`,
`POPEYE_FAKE_PROVIDER_SCRIPT` -> popeye repo
`packages/cli/test-fixtures/cli-fake-provider.json`,
`POPEYE_MODEL=fake-model`,
`POPEYE_BASE_URL=http://127.0.0.1:1234/v1`). No inference ran.

- `hcn-stream.ndjson`: `-p --mode hcn` identity/token/message/done
  records; the identity block carries the same capabilities shape as
  0.1.3, confirming the agent spec surface and the absence of any
  driver change.
- `journal.jsonl`: the same v1 journal the 0.1.3 capture produced;
  entries are version-1, byte order preserved, headers intact.
- `rpc-create.ndjson`: `--mode rpc` create response with the snapshot.

The tripwire scripts (`bun run smoke:seven`, `bun run smoke:questions`)
cannot drive popeye on macOS hosts that install it through a 172-byte
sh wrapper because bun's `posix_spawn` does not honor the shebang;
CI uses a direct-path bind mount where the tripwires run. The
capability surfaces probed here mirror the smoke scenarios.
Session ids are minted per capture; tests must not pin them.
