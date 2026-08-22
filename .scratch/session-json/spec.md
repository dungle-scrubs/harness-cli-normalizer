# Feature: hcn session --json (machine session surface)

Spec: `docs/rfc/01_machine-session-surface-hcn-session-json.rfc.md` (Draft,
revision 2, review answered).

These tickets slice RFC-01 into tracer-bullet vertical slices. Granularity
approved by the user 2026-08-22; destination local `.scratch` first, GitHub
publish gated on the user.

Backend note: this repo uses GitHub issues (`dungle-scrubs/harness-cli-normalizer`).
`Blocked by:` lines here name local file numbers; on publish they map to
GitHub issue numbers.

Frontier at start: 01 and 09 (both unblocked).

## Outcome

All 10 tickets implemented on `feat/session-json-machine-surface` (9 commits).
T09 and T10 were delegated to glm-5.3 in isolated worktrees; the rest ran
inline. A cross-family review (muse) of the whole branch raised 4 blocking
findings, all fixed in the final commit. Full gate green: 647 tests.

Accepted follow-ups, not done here:
- `writeEventNdjson` is still fire-and-forget, so the hcn-to-consumer
  backpressure hop is unbounded in `hcn run --json` (RFC rule 8).
- Consumer stdin errors are swallowed with no disposition for in-flight sends.
- No test proves disposition ordering under backpressure.
