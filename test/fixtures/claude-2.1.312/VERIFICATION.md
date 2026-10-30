# claude-2.1.312 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Claude 2.1.312 with sonnet on 2026-10-29. Fresh and resumed native context estimates passed, and the original synthetic source transcript hash did not change. Automatic compaction completed; a later process recalled HERON-CLAUDE-420. No native compaction failure was observed in the successful qualifying run, and no failure outcome was forced. The npm source remains @anthropic-ai/claude-code.

Malformed and failed accounting operations remain unavailable through the deterministic inspect-context suite (test/cli/inspect-context.test.ts), which validates the operation independent of version metadata; no live malformed probe was re-run for this anchor.

## Probe settings

- Tool isolation on every probe: `--tools '' --strict-mcp-config --mcp-config {"mcpServers":{}}`. The compact turn and the later recall also pass `--tools ''` with the same MCP isolation.
- The compaction ladder's compact turn exported `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` for that child only. Lowered thresholds are a probe setting, not an HCN default.
- The accounting probes rendered `--setting-sources project`, which is the adapter's discovery option, so they observe the native 1M model default window: 1,000,000 context window, 967,000 input limit, 3,104 tokens fresh and 18,269 tokens on the resumed fork. The product-surface CLI run loads the user's settings and reports the machine's env-sourced window (500,000 / 467,000) for the same exchange. Both are correct live observations; the fixture keeps the project-scoped ones, and the input limit is a function of the setting scope, not of the version.
- The ladder used `--resume` for turns after the first.

## What this anchor does not establish

- The worker's session-id reuse refusal was not retained as evidence, so this anchor makes no claim about it. The contract proof does not depend on it.
- Lowered thresholds do not establish full-capacity behavior or lossless recall. Summary retention is checked through marker recall, not byte-for-byte comparison.
- No native compaction failure was observed and none was forced.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts. `version-source.snapshot.json` records the published npm version observation. Fresh and question NDJSON files contain selected native identity/assistant/result records. Configuration-bearing hook and user frames are omitted; these are excerpts, not complete native streams. Their init records replace operator skill and command names, custom agent names, configured MCP names, configured MCP tool names and operator-configured plugin names/paths/name-bearing sources with field-naming markers that report the original character length of the content they replace. Native commands, bundled skills, built-in agents and plugins, native terminal command names, native tool names and all bytes outside those configuration fields are preserved. Non-init records are unchanged.

Compaction/accounting files are selected native records. The accounting `memoryFiles` paths remain session metadata, not operator instruction content. Other fields remain unchanged.

`accounting-fresh.proof.snapshot.json` and `accounting-resume.proof.snapshot.json` are per-probe proof snapshots derived from the raw captures: the captured argv, the exact staged synthetic prompt, a frame-type listing of the complete native recording, the replayed user message, the terminal result record and the usage control response copied verbatim (each pinned by the SHA-256 of its original native line), and the adapter's accounting result. The recordings' operator hook and init frames, the initialize control response and the command_lifecycle records are omitted under an explicit excerpt note inside each proof; copied records are not edited, truncated or redacted.

The live probes use synthetic data only. Old versioned fixtures remain intact.
