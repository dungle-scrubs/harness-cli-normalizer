# pi-1.4.0 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Pi 1.4.0 with zai/glm-5.3 on 2026-10-29. JSON and RPC automatic compaction completed. The installed summary retained HERON-PI-420, and a later process recalled it. No native compaction failure was observed in the successful qualifying run, and no failure outcome was forced. The npm source remains @earendil-works/pi-coding-agent.

## Probe settings

- JSON-mode compaction: a project `.pi/settings.json` in the probe's disposable workspace, with the compaction settings nested under a `compaction` object (`compaction.reserveTokens` 950000, `compaction.keepRecentTokens` 500) and `--approve`. The nested settings block is probe configuration observed on 1.4.0; it is not a proven behaviour change in 1.4.0. Top-level `reserveTokens` keys do not apply - three uncrossed attempts at reserve 950000/970000/985000 with about 56k tokens of context were observed, and the qualifying run used the nested shape.
- RPC-mode compaction: the same nested settings shape in the RPC workspace. The first RPC attempt was killed mid-turn by the probe driver's own idle heuristic; the qualifying attempt is the retained one.
- The hosted model `zai/glm-5.3` was used. No local inference ran.

## Observed compaction numbers

- JSON mode: threshold compaction on turn 1 (`reason=threshold`), 77,335 tokens before and 19,994 estimated after, with a `result` present and the compaction not aborted. The installed compaction entry in the task-owned session store carries `tokensBefore` 77335, `firstKeptEntryId` and a summary with the marker.
- RPC mode: threshold compaction on the `--mode rpc` stream, 77,411 tokens before and 20,135 estimated after, with a `result` present and the compaction not aborted.
- Turn 2 and a separate later process both recalled HERON-PI-420. The later recall's answer is exactly the marker, with no prose added by the model.

## What this anchor does not establish

- Lowered thresholds do not establish full-capacity behavior or lossless recall.
- No native compaction failure was observed and none was forced.
- MCP tool-selection behavior was not exercised.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts. `version-source.snapshot.json` records the published npm version observation. Fresh and question NDJSON files contain selected native identity/assistant/result records. Configuration-bearing system, user and custom frames are omitted; these are excerpts, not complete native streams. Selected records retain their original order. Native thinking stays intact except for exact quoted spans of operator instructions, which carry a field-naming marker and the original character count. The surrounding thinking and its original JSON escape bytes remain unchanged. Native tool names, model names, usage, timestamps and session identifiers are unchanged.

`installed-compactions.snapshot.json` is the compaction entry pi installed in its own session store. Its system message carries the operator's discovered agent configuration. Operator-owned `project_context`, `docs`, `skills`, `rules` and `tools` sections and extension descriptions carry field-naming markers with their original character counts. The native `read`, `bash`, `edit` and `write` descriptions match the installed Pi1.4.0 SDK and remain byte for byte. The summary, the entry identifiers, the token counts and every other field are unchanged.

The live probes use synthetic data only. Old versioned fixtures remain intact.
