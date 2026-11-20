# cursor-sdk-1.4.2 verification

Status: Qualified SDK anchor. Captured 2026-11-20 against the repository's
`@cursor/sdk` 1.4.2 dependency pin (package.json; installed with no
release-age exception), executing the native agent at
~/.local/share/cursor-agent/versions/2026.11.11-043ef28 through hcn's owned
worker (`hcn inspect cursor --runtime` selection at capture time). The
1.0.38 fixture directory is retained as the prior SDK anchor; the native
CLI grammar facts in the descriptor remain anchored to agent
2026.10.01-e373342.

- `seven.snapshot.json`: all seven scenarios pass on the worker backend
  (single-turn, streaming fidelity, tool use, one-process session
  continuity, resume continuity, kill-and-resume, error propagation).
- `questions.snapshot.json`, `questions/01.ndjson`: the genuine
  staging/production decision produces a normalized question and ends
  awaiting input, observed on grok-4.7-high.
- `seven/`: the worker wire for each scenario, byte-identical except the
  operator-configuration redaction in the stderr files (registered hook
  event names, ruleCount and skillCount values, each replaced with an
  original-length marker).
- `models.json` / `models.full.snapshot.json`: `Cursor.models.list()`
  metadata capture (no agent, no turn). The account catalog holds 50
  models; relative to 1.0.38 it adds claude-fable-5-2, gemini-4-carbon,
  gemini-4-hydrogen and gemini-4-neon, and drops gemini-3.6-flash and
  gemini-3.7-flash. The auth status is normalized to the bare login
  state; account identity fields were never captured in the fixture.
- `compaction-ladder.ndjson`, `compaction-later-recall.ndjson`,
  `compaction.provenance.json`: the native-compaction contract on the SDK
  path. A fifteen-turn synthetic file-read ladder drove input tokens past
  ~1.01M three times; each crossing dropped the context back to ~325k
  (automatic replacement installation), and a separate resumed worker
  process answered exactly LANTERN-1121. The ladder excerpt keeps every
  opened/receipt/turn-end record, all fifteen usage records and the final
  assistant message byte-identical in source order; bulk text deltas,
  tool-call records carrying the synthetic file contents, and the earlier
  SAVED messages are omitted. The raw 3.6 MB capture stays in the
  evidence tree.

## What this anchor does not establish

- The SDK run stream carries no compaction or summary record
  (compactionReporting stays null); the compaction evidence is the usage
  shape plus cross-process marker recall, the same method as the CLI-era
  anchor.
- No threshold override exists on the SDK surface; full-capacity behavior,
  replacement contents and lossless recall are not claimed.
- Vision and image surfaces remain unprobed and stay conservatively false.

The live probes use synthetic data only. Old versioned fixtures remain
intact.
