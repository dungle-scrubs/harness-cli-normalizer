# muse-1.4.4-R5419.1 verification

Status: Partial verification; anchor held at 1.4.2.

Six compatibility cells passed on Muse 1.4.4-R5419.1 with muse-spark-1.3-contributor on 2026-10-10; single-process continuation remains the intentional skip. The question probe passed. A stable summary-preserved-suffix/v1 synthetic file-read probe completed automatic compaction from 170718 to 25861 tokens at lowered soft/hard thresholds 0.16/0.22. Later-process recall was stopped because native approval/listPending repeatedly returned -32603 with classify turns: session fork rejected: MalformedJsonl. The same error persisted after the previous writer exited and flushed its logs. Successful view/page compaction metadata does not override an unavailable approval set. The HCN observer remains fail-closed. These captures do not qualify a new native-context anchor.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts. `version-source.snapshot.json` records the published npm version or installed-only source observation. Fresh and question NDJSON files contain selected native identity/assistant/result records, preserved byte for byte. Configuration-bearing hook and user frames are omitted; these are excerpts, not complete native streams. Other native fixture fields are unchanged.

Compaction/accounting files, where present, are selected native records. Muse `compaction-items.snapshot.json` contains native completed-item field excerpts, not a complete MSP page; `msp-approval-failure.ndjson` preserves the actual error responses. Fixture replay exercises the existing decoder and context/compaction normalization interfaces. Old versioned fixtures remain intact.

The live probes use synthetic data only. Lowered thresholds do not establish full-capacity handling or lossless recall. A smoke pass alone does not prove native replacement-history installation.
