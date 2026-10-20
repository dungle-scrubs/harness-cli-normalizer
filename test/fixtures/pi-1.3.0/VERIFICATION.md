# pi-1.3.0 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Pi 1.3.0 with openai-codex/gpt-6.1-sol on 2026-10-20. JSON and RPC automatic compaction completed. The installed summary retained HERON-PI-1010, and a later process recalled it. Lowered thresholds (project .pi/settings.json with reserveTokens 480000 and keepRecentTokens 500, plus --approve) and disabled discovery are probe settings, not HCN defaults; 1.3.0 gives openai-codex/gpt-6.1-sol a 500K context window, so the 1.1.0 probe's 256000 reserve no longer crossed the trigger. No native compaction failure was observed in the successful qualifying run, and no failure outcome was forced; that initial trigger miss - the first attempt completing clean turns without compaction before the 480000 rerun - was an uncrossed threshold, not a native compaction failure. MCP tool-selection behavior was not exercised. The npm source remains @earendil-works/pi-coding-agent.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts. `version-source.snapshot.json` records the published npm version observation. Fresh and question NDJSON files contain selected native identity/assistant/result records, preserved byte for byte. Configuration-bearing hook and user frames are omitted; these are excerpts, not complete native streams. Other native fixture fields are unchanged.

The live probes use synthetic data only. Lowered thresholds do not establish full-capacity handling or lossless recall. A smoke pass alone does not prove native replacement-history installation. Old versioned fixtures remain intact.
