# Run observations

Callers receive native tool outcomes and accounting independently of the turn verdict.

## Sub-features

- `results`: complete result payload, native call identity and error status.
- `usage`: native scope, cache semantics and reported cost without derived totals.
- `denials`: structured non-terminal `error.denial` fields, including optional native call ID and bounded input preview.
- `counts`: optional positive `done.denialCount` counts observations, including repeated reports of the same call. Zero is omitted and session counts reset each turn.
- `presentation`: text mode adds `[denials: N]` to the usual terminal line without changing exit status or cause.
- `outcome`: failed tools and denial observations do not invent a failed turn. Native terminal failure remains independent.

## How to get to it (user POV)

Run `hcn run pi --json --prompt <text>` or `hcn run claude --json --prompt <text>`. Each harness reports only observations its native stream supplies. Persistent `hcn session claude --json` carries the same turn observations. Text mode marks failed tools and positive denial counts but omits usage and full result payloads. Use JSON for lossless observations.

## Driving it with CLI integration tests

Preconditions: `pnpm build` succeeds and Node and Bun are installed.

- Run `pnpm exec vitest run test/cli/tool-results-usage.test.ts test/execution/tool-results-usage.test.ts test/interpretation/observations.test.ts test/interpretation/content-claude-result-error.test.ts test/execution/open-session.test.ts test/cli/native-approvals.test.ts test/execution/native-approvals.test.ts` and repeat with `bun test --timeout=20000` and the same file paths.
- Built-CLI cases assert complete failed workflow details, one result per native completion, exact usage semantics and clean terminal outcome. Claude result-only denial captures must produce typed tool, call ID and summary fields and a positive count without inventing failure. Repeated native reports must yield repeated observations and `[denials: 2]`, even with the same call ID.
- Reader controls cover malformed entries, bounded summaries, empty arrays and coexistence with native `is_error`. Persistent-session controls deny one turn, then verify the next turn has no leaked count.
- Verified-resume approval transport cases answer one native request and assert complete command/file results, call IDs and thread-only session usage. Execution controls reject cross-thread or RPC-shaped observations, defer file results until turn ACK and exclude plan/review milestones from tool activity.
- Inspect `src/cli/render.ts` and exercise human output for presentation changes. JSON proof alone does not cover the suffix or terminal line.

## Gotchas

A clean done event is not a tool-success claim, even with no denial count. For Claude, hcn reads structured denial entries from the final result. Its entries have no reason field, so hcn preserves an empty reason rather than inventing one. An input preview can be truncated JSON; the 512-character preview is not a complete result payload. Native tool failure can also occur without a structured denial.

Native usage may be absent, sparse or cumulative. Never infer zeros or add overlapping cache counts. Synthetic process fixtures prove normalization, not provider accounting accuracy or native permission enforcement.
