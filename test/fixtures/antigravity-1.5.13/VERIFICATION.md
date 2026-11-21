# antigravity-1.5.13 verification

Status: Qualified anchor.

Captured 2026-11-20 against the installed Antigravity CLI 1.5.13
(`~/.local/bin/agy`, free Individual plan). All seven scenarios pass; the
question probe passed on gemini-3.8-flash-medium; the headless-session
compaction contract passed; a later process recalled LANTERN-1121.

## Probe settings

- The executable under test is the machine's own install, already upgraded
  to 1.5.13 for this refresh; no harness was upgraded or reconfigured by
  the probe. `hcn inspect antigravity --runtime` selected
  `/Users/kevin/.local/bin/agy` (1.5.13).
- Compaction was exercised at native defaults (agy exposes no threshold
  override): one persistent `--input-format stream-json` session planted
  the marker, fourteen inert 20,000-word blocks crossed the native
  threshold (the same block count the 1.5.9 probe needed; the 1.3.3
  seven-block probe no longer crosses), the session's own recall turn
  answered, and a separate resumed process answered exactly LANTERN-1121.
- One `step_update` checkpoint in state DONE normalized as `compacted`
  (duration 6.74 s). As on 1.5.9, the checkpoint record carries a `usage`
  object (input 22,425 / output 379 / cache read 226,474 / total 22,804) -
  the checkpoint's own model call; the decoder still deliberately reads no
  token counts from it, so `compactionReporting.tokens` stays false.
- The free-plan model roster is six slugs (`agy models` capture in
  `models.txt`): gemini-3.8-flash-high/-medium/-low,
  claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium. The
  1.3.3 fourteen-slug roster (gemini-3.7-flash, gemini-3.6-flash,
  gemini-3.1-pro gone) stays in the 1.3.3 fixture.

## What this anchor does not establish

- No native compaction failure was observed and none was forced.
- Lowered-threshold caveats do not apply (native defaults), but synthetic
  fill proves no full-capacity, pending-accounting, or lossless-recall
  claim; the checkpoint summary contents live in the brain store and were
  not inspected.
- No new permission, sandbox, or store surface was probed; the 1.2.7
  corpus still anchors those.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite
receipts. `version-source.snapshot.json` records the installed-version
observation. `fresh.ndjson`, `question.ndjson`, `compaction.ndjson` and
`later-recall.ndjson` are the raw native stream captures, byte for byte;
the init records list the harness's native tools only. The live probes
use synthetic data only. Old versioned fixtures remain intact.
