# pi-1.6.0 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Pi 1.6.0
(pi-managed install, npm latest 1.6.0) with the hosted zai/glm-5.3 on
2026-11-20 - no local inference ran. JSON and RPC automatic compaction
completed at moved thresholds. The installed summaries retained
HERON-PI-1121, and later processes recalled it. No native compaction
failure was observed in the successful qualifying run, and no failure
outcome was forced.

## Probe settings

- JSON-mode compaction: a project `.pi/settings.json` in the probe's
  disposable workspace, with the compaction settings nested under a
  `compaction` object (`compaction.reserveTokens` 985000,
  `compaction.keepRecentTokens` 500) and `--approve`. The 1.5.2-qualifying
  970000 no longer crosses on the first recall turn (the effective window
  grew again); the qualifying run crossed on turn 1 (84,497 -> 26,319
  tokens), turn 2 answered exactly the marker, and a separate later
  process answered exactly the marker. The session store holds three
  installed compaction entries, each summary carrying the marker.
- RPC-mode compaction: the same nested settings shape at
  `compaction.reserveTokens` 1000000, driven over the `--mode rpc`
  JSONL command stream with three turns; the threshold compaction landed
  at the crossing turn's end (81,976 -> 24,283 tokens), the marker was
  recalled before and after the compaction, and the capture ends with a
  trailing `compaction_start` whose end never arrived (the probe closed
  stdin while a second compaction was beginning - the same artifact the
  1.5.2 capture holds).
- The 1.5.2-era compaction-warning lesson held: near the threshold pi
  appends a compaction-warning custom message quoting the operator's
  global instructions verbatim, and models obey that text instead of
  answering until the prompt names it boilerplate. One JSON attempt and
  one RPC attempt were lost to it before the disclaimer prompts; the RPC
  workspace also had to sit outside the machine's `.scratch/<task>/`
  pattern, or the quoted "update the task's checkpoint" line points the
  model at a real task folder (both failed attempts retained in the task
  evidence tree).

## Observed compaction numbers

- JSON mode: threshold compaction on turn 1 (`reason=threshold`), 84,497
  tokens before and 26,319 estimated after, `result` present, not
  aborted; further threshold compactions on the recall turns (26,565 ->
  26,986 and 27,271 -> 27,510).
- RPC mode: threshold compaction at the crossing turn's end, 81,976
  tokens before and 24,283 estimated after, `result` present, not
  aborted.
- Turn 2 and separate later processes recalled HERON-PI-1121 exactly.
- Native core tool descriptions (read, bash, edit, write) hash identical
  to the 1.4.0 SDK digests.

## What this anchor does not establish

- Lowered thresholds do not establish full-capacity behavior or lossless
  recall.
- No native compaction failure was observed and none was forced.
- MCP tool-selection behavior was not exercised.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite
receipts. `version-source.snapshot.json` records the published npm
version observation. Fresh and question NDJSON files contain selected
native identity/assistant/result records. Configuration-bearing system,
user and custom frames are omitted; these are excerpts, not complete
native streams. Native thinking stays intact except for the exact quoted
span of operator instructions in the later-recall capture, which carries
a field-naming marker and the original character count (56).

`installed-compactions.snapshot.json` holds the three compaction entries
pi installed in its own session store for the qualifying session. Each
entry's system message carries the operator's discovered agent
configuration: operator-owned `project_context`, `docs`, `skills`,
`rules` and `tools` sections and extension tool descriptions carry
field-naming markers with their original character counts. The native
`read`, `bash`, `edit` and `write` descriptions match the installed Pi
1.6.0 SDK and remain byte for byte. The summaries, the entry
identifiers, the token counts and every other field are unchanged.

The live probes use synthetic data only. Old versioned fixtures remain
intact.
