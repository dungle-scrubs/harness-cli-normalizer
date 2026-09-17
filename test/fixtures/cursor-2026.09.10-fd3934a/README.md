# Cursor 2026.09.10-fd3934a verification

Captured logged-in, 2026-09-16, against `agent` version
`2026.09.10-fd3934a`, in disposable scratch workspaces under the spike
directory (see the spike report and `spike-addendum.md` in the
scratchpad). Only the captures the Phase 4 tests consume are copied
here; the full candidate list (probes 09-38 plus 40-55 plus 60-61 plus
70-71) stays in the spike `out/` directory.

## Normalization

One mechanical replacement, applied to the capture-machine scratch prefix
wherever it appears as a run path:

- `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/5a45c2a9-6252-4aae-9c22-f86a4afa9c3b/scratchpad/cursor-spike`
  becomes `/hcn-cursor-spike`.

Absolute paths outside that prefix are kept as captured. In particular,
`probe-51.ndjson` carries model-reported `/Users/kevin/.cursor/projects/`
paths in the dash-slugged form inside search-result prose; those are
evidence, not run paths, and are not normalized.

Run-specific session UUIDs, timestamps, and model display names are kept
as captured: they are evidence, and the decoder treats them as data.
`models.txt` is verbatim (it carries no paths).

## Files

| File | Source probe | Evidence |
| --- | --- | --- |
| `probe-11.ndjson` | 11-partial | Token-granular tool-free turn: per-fragment `assistant` deltas plus the end-of-turn flush |
| `probe-11b.ndjson` | 11b-stream | Message-granularity turn: full-text `assistant` records, no deltas |
| `probe-13.ndjson` | 13-edit | Tool turn on plain `stream-json`: pre-tool `assistant` segments carrying both `timestamp_ms` and `model_call_id` |
| `probe-15.ndjson` | 15-fetch | Denials: rejected `webSearchToolCall` with no preceding `started` (lines 39-41), the approval-flow query pair, empty shell-denial reasons |
| `probe-20.ndjson` | 20-askq | Default-mode ask-question call: the query pair arrives before `started`; no `--mode` in its argv |
| `probe-43.ndjson` | 43-partial-tools | Partial flag on a tool turn: same delta shape as probe 11 with tool calls |
| `probe-51.ndjson` | 51-force-search | `--force` web search: the query pair arrives before `started` with a pre-approved response; `started` precedes `completed` |
| `probe-52.ndjson` | 52-force-fetch | `--force` web fetch: the query pair lands mid-call; the shell call runs with no query pair at all |
| `trust-01.stderr.txt` | 01 | The trust-gate stderr (`Workspace Trust Required`, exit 1, empty stdout) |
| `help-50.stdout.txt` | 50 | `agent --help` usage (`agent [options] [command] [prompt...]`): no documented `--` handling |
| `prompt-join-41.stdout.txt` | 41 | Post-`--` tokens join the prompt as text (prompt `pong41 --continue`), exit 0 |
| `models.txt` | models | The 223-slug `agent models` output the descriptor transcribes |

## Secret scan

Scanned at capture time over the spike `out/` (clean) and re-scanned
here for `crsr_`, `sk-`, `key_`, bearer tokens, JWT shapes, and emails:
one pattern hit, the English word `ask-question` in the probe-20 user
prompt prose, adjudicated a false positive. Zero secrets, zero emails.
`apiKeySource` reads the string `login`, never a key.
