# Run observations

Callers receive native tool outcomes and accounting independently of the turn verdict.

## Sub-features

- `results`: complete result payload, native call identity and error status.
- `usage`: native scope, cache semantics and reported cost without derived totals.
- `outcome`: a failed tool does not invent a failed turn.

## How to get to it (user POV)

Run `hcn run pi --json --prompt <text>`; each supported harness reports only observations its native stream supplies. Text mode marks failed tools but omits usage and full result payloads; use JSON for lossless observations.

## Driving it with CLI integration tests

Preconditions: `pnpm build` succeeds and Node and Bun are installed.

- Run `pnpm exec vitest run test/cli/tool-results-usage.test.ts test/execution/tool-results-usage.test.ts test/interpretation/observations.test.ts`.
- Run `pnpm exec vitest run test/cli/native-approvals.test.ts test/execution/native-approvals.test.ts` for the verified-resume approval transport. Its built Node/Bun cases answer one native request and assert full command/file results, call IDs and thread-only session usage; execution controls reject cross-thread or RPC-shaped observations, defer file results until the turn ACK, and exclude plan/review milestones from tool activity.
- Repeat both commands with `bun test --timeout=20000` and the same file paths.
- The CLI cases invoke the built binary under Node and Bun, asserting full failed workflow details, one result per native completion, exact usage semantics and clean terminal outcome. Interpretation tests broaden native-format coverage; persistent-session tests check the alternate lifecycle.
- Inspect `src/cli/render.ts` and exercise human rendering for any change to the non-JSON surface; JSON proof alone does not cover presentation.

## Gotchas

A clean done event is not a tool-success claim. Native usage may be absent, sparse or cumulative; never infer zeros or add overlapping cache counts. Synthetic process fixtures prove normalization, not external provider accounting accuracy.
