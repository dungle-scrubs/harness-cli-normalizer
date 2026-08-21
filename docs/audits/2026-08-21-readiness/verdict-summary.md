# Verdict - harness-cli-normalizer 53c400a, 2026-08-21 (final)
Q1, delegated subagent tasks through the `hcn` CLI: **not ready**.
Q2, lucid-v2 driving `hcn run --json` one process per turn: **not ready**.
Both turn on the same three blockers. Each needs a normalizer change; none has a
consumer-side workaround.
- F-02 `src/knowledge/matchers.ts:23` - the rate-limit matcher is the bare string
  `429`, so any stderr line holding those digits reports a wall that did not happen
  and hides the real failure on that turn. Fix: anchor it to an HTTP context.
- F-03 `src/cli/run.ts:35-38` - under `--json` a refused invocation writes zero
  bytes to stdout, so a program cannot tell a refusal from a crash. Fix: write
  `failureFromRejected(err)` plus a `done` line to stdout in every refusal branch.
- F-01 `src/interpretation/argv.ts:147` - a malformed `--resume` id throws
  `SessionIdRefusalError` past every catch: no `failure`, no `done`, exit 1. Fix:
  make it an `ArgvRefusalError`, or catch it beside one in `stream-turn.ts:188`.
Cross-family review ran: `muse-spark-1.2-contributor` via `hcn run muse`, on the
blockers and majors only. 23 upheld, 0 refuted, 6 downgrades proposed - 2 applied,
1 applied one level less than asked (F-18 to minor, not note), 3 rejected (F-14,
F-20, F-21). It raised one verified finding, F-68: a rotated resume id ends the
turn `clean` with no `identity` event, so the consumer loses the session silently.
Final counts: 68 findings - 3 blockers, 21 majors, 26 minors, 18 notes. The
majors that matter most: F-04 (missing binary is `retryable:false`, so a
delegating agent stops instead of falling back), F-12 (`--no-tools` on pi still
ships the full profile tool grant), F-13 (README's failure taxonomy is wrong in
both directions and the delegate and choose-model skills repeat it).
Full report: `SCRATCH/audit/report.md`.
