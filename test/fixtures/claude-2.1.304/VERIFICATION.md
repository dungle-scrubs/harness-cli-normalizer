# claude-2.1.304 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Claude 2.1.304 with sonnet on 2026-10-20. Fresh and resumed native context estimates passed, and the original synthetic source transcript hash did not change. Automatic compaction completed; a later process recalled HERON-CLAUDE-1010. The lowered trigger (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2) is a probe setting, not an HCN default. The npm source remains @anthropic-ai/claude-code.

Malformed and failed accounting operations remain unavailable through the deterministic inspect-context suite (test/cli/inspect-context.test.ts), which validates the operation independent of version metadata; no live malformed probe was re-run for this anchor.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts. `version-source.snapshot.json` records the published npm version observation. Fresh and question NDJSON files contain selected native identity/assistant/result records. Configuration-bearing hook and user frames are omitted; these are excerpts, not complete native streams. Their init records replace operator skill and command names, custom agent names, configured MCP names and plugin names/paths/name-bearing sources with field-naming markers that report the original string or compact JSON value length; native commands, built-in agents, native terminal command names, native tool names and all bytes outside those configuration fields are preserved. Non-init records are unchanged.

Compaction/accounting files are selected native records. The accounting `memoryFiles` paths remain session metadata, not operator instruction content. Other fields remain unchanged.

The live probes use synthetic data only. Lowered thresholds do not establish full-capacity handling or lossless recall. A smoke pass alone does not prove native replacement-history installation. Old versioned fixtures remain intact.
