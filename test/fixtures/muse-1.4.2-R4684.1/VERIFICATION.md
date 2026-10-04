# Muse 1.4.2-R4684.1 verification, 2026-10-03

This is observed evidence for the current shipped build. Historical 1.4.1
fixtures remain separate. The seven native capability tripwires passed six
applicable cases; persistent one-process sessions are unsupported and skipped.
The native question tripwire passed. The snapshots pin the descriptor version,
model and observation date; stdout captures pin current decoding separately.

## Permission transaction frames

The native session begins with a schema-1 `session_permission_transaction`
retained frame. It contains two exact `record_json` strings for
`runtime.session.permission_format_declared` and
`runtime.session.permission_profile_committed`, indexes 0 and 1, sequences 1
and 2, one session identity, a transaction ID and outer ordinal 1. The next
ordinary envelope has sequence 3. These are permission metadata.

Muse's official [audit contract](https://dev.meta.ai/docs/cookbook/audit-agent-sessions#export-a-session)
describes an offline export with one event per retained log line in log order.
The current native exporter preserved the complete outer frame as one event.
Two independent synthetic exports contained 637 and 1452 events with all five
tolerance counters zero. HCN retained every export-derived original value and
the complete frame. These exports are different sessions from the live reader
target, and they are reference oracles, never passive acquisition fallbacks.

The live synthetic target contained 96 retained records. Before the repair,
the public read refused `Missing native Muse session identity`. After it, the
public read returned all 96 originals, pagination returned 1 then 95 records,
the continuation verified the committed prefix and the source hash stayed
unchanged. A byte-identical isolated copy listed under its recorded workspace.
The live source hash was
`8540536aeb721e150e8433124598ad49bf590b1077f9783228844b18d9dc1772`.
The committed fixture has only operator configuration fields redacted; its
hash therefore differs from the live source.

HCN emits one `saved-record` per outer frame. Its normalized kind is unknown;
exact child strings remain in `original`, rather than becoming separate
messages or positions. Embedded schema-1 envelopes establish identity and
ordering. The reader requires complete framing, ordered child indexes, unique
record and transaction IDs and increasing exact integer sequences/ordinals.
Malformed inputs receive structured source refusals; unfamiliar frame variants
or versions receive format refusals. These are conditional reader guarantees
for the observed format, not a claim that public Muse docs specify every
possible future frame. The docs do not publish these frame internals or the
checksum algorithm. `content_sha256` remains opaque and unauthenticated.

Tests preserve exact child strings, integers beyond Number precision, every
outer record, byte offsets, identity, order, prefix bookmarks and source bytes.
Negative cases cover truncation, duplicate JSON keys, conflicting identity,
duplicate IDs, invalid metadata, unsupported schemas and structured failures.
Independent parser review found no core defect before this documentation.

## MSP observer and compaction

The shipped offline MSP schema, schema version 1, fingerprint
`sha256:61afea3112e0906e9dc3a536144278a74cb4b36fc6e20901a91d4432ba3568e2`,
requires `ViewPageParams.limit` between 1 and 1000 and a session ID. The original
missing-limit request and its native -32602 refusal are retained. Corrected
HCN requests use limit 1000 and native event pages/cursors. The live HCN helper
capture and summary preserve ordered outcomes, including failed, cancelled
and no-op compactions, without turning them into successful installations.

Native tool-history records show hard and true mid-turn soft replacement
installations. A later process recalled MARIGOLD-903. Some seed/hard turns hit
the 90-second HCN deadline and a soft turn ended in native non-convergence;
these are retained failures, not clean-turn passes. Lowered thresholds prove
the mechanisms, without claiming full-capacity behavior or lossless recall.

Raw JSON captures remain native byte evidence, apart from the sole permitted
redaction of the operator's discovered agent configuration. Snapshot suffixes
exclude captured JSON from formatting; capture values were not reformatted.
