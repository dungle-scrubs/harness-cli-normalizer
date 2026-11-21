# Muse 1.4.24-R9131.1 verification, 2026-11-20/21 (issue #491)

Observed evidence for the current shipped build. Historical anchors
(1.4.2-R4684.1, 1.4.1, 1.3.0, 1.1.1) remain in their own directories.
The seven native capability tripwires passed six applicable cases
(persistent one-process sessions are unsupported and skipped) on
2026-11-20; the native question tripwire passed the same day. The
compaction contract was re-established on 2026-11-21 after issue #491.

## Native compaction (issue #491 resolution)

Muse 1.4.24 auto-compacts. Session `01a1fc18-9e26-7083-a3bd-6d2897d2f90f`
(seed + one 1800-line file-read turn at soft 0.02 / hard 0.04, model
muse-spark-1.3-contributor, `summary-preserved-suffix/v1`) holds, in its
durable log: a rejected `soft_threshold_async` pre-turn candidate, three
succeeded `hard_threshold_blocking` mid-turn candidates with
`context_compaction_installed` records, one failed mid-turn candidate
(`no_progress_exhausted`), and warning-severity fallbacks. A separate
later process recalled the session codeword `MARIGOLD-491G` cleanly
(`tool-history-recall.ndjson`).

The earlier "does not reproduce on 1.4.20/1.4.24" records were
observation failures, not muse behavior:

- `muse exec --json` stdout has never carried the compaction signal
  (ADR 0009; docs/research/2026-09-22-compaction-signals/muse). The
  2026-11-15 ladder sessions' durable logs hold 4/5/24/8/25 installs (in
  session order 01a1ddb1/b6/bb/c3/c8) and the 2026-11-20 re-run session
  holds 24, in every case at the very thresholds the probes believed
  had never fired. These are primary durable-log records, re-derived
  through the repository's own store-root resolution; the first write-up
  counted 48/50/16/10/8 because it also counted the `resume_state`
  replay copies each resume writes, which double-count installs.
- On 1.4.24 every live `view/page` reply while the session is held is a
  `-32603` `view range read failed` internal error, so the HCN observer
  folded nothing during those runs (`hcn-helper.ndjson`). A `muse serve`
  started after the session ends pages the view successfully; the
  rebuilt projection carries only the last terminal item
  (`msp-view-posthoc.ndjson`: the failed item, 86,317 tokens before).
  Successful installs collapse out of the rebuilt view. hcn therefore
  reports no live compaction signal for Muse on 1.4.24.

What the captures establish about thresholds and failures:

- Threshold fractions multiply an "effective context limit" - the
  `context_compaction.provider_context_limit_tokens` setting or the
  model catalog's `context_limit` (1,007,997 for
  muse-spark-1.3-contributor at capture time). On 1.4.24, `0.02/0.04`
  resolved to 20,159/40,319 tokens (`compaction-records.snapshot.json`).
  This rule is not new since 1.4.2: the 1.4.2 threshold-failure capture
  already names the same rule verbatim against the same 1,007,997
  limit. The 1.4.2 tool-history captures resolved the same `0.02/0.04`
  fractions to 10,240/20,480 tokens, a 512,000 base in those sessions;
  no capture shows what produced that base (no provider limit setting is
  recorded in any capture), so the cause of the difference is not
  established. Pinning the limit to 512,000 makes a startup prompt that
  crosses the hard threshold a native startup failure, exit 1, whose
  prose names the resolution rule verbatim (`threshold-failure.ndjson`).
- A rejected replacement is a warning-severity fallback the run
  survives (`can_continue: true`) on 1.4.24, where 1.4.2 terminally
  failed the run.

Lowered thresholds prove the mechanisms; they do not prove
full-capacity behavior or lossless recall.

## MSP surface

`msp-missing-limit.ndjson`: `initialize` reports `serverInfo.version`
1.4.24 (schema fingerprint
`sha256:b7fb9137267aa35c92424df37a5ac56287006a0e546b197bf0930d593fecbdb1`);
`approval/listPending` answers empty; the original missing-limit
`view/page` still refuses with `-32602`. The handshake now requires the
client-to-server `initialized` notification before any call is served.

## Captures

Raw JSON captures remain native byte evidence, apart from the sole
permitted redaction of the operator's discovered agent configuration;
none was present in these captures (probes passed
`--no-foreign-personal-context`, and stdout does not echo rules files).
The seven/question captures were taken by the 2026-11-20 refresh run of
`bun run smoke:seven` / `smoke:questions`; the identity events' echoed
`escalation.observedOn` is the descriptor at capture time (anchor 1.4.2
then), not the current claim.
