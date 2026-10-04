# Codex 0.160.0 verification

Captured on pro, 2026-10-03, using the Homebrew cask executable
`/opt/homebrew/Caskroom/codex/0.160.0/bin/codex`. The npm latest tag agrees;
`version-source.snapshot.json` records the registry observation.

## Live suites

The absolute checkout smoke scripts ran from distinct synthetic seven and
questions working directories. Both used `SMOKE_HARNESS=codex`,
`SMOKE_MODEL=gpt-6-astra`, matching `SMOKE_CWD`, and separate capture directories.
Six runnable scenarios pass, including the persistent app-server session's
same-process marker recall. Streaming alone skips because exec stdout is
message-granular. Questions pass with observation gpt-6-astra, 0.160.0,
2026-10-03. Native fresh, tool, session, establish, resume and question fixtures
are new recordings from this cycle.

## Native compaction

The marker HERON-519 was stored in a new synthetic session. Two subsequent
turns staged 2500 repetitions each of fictional planet sentences and requested
only SAVED, rather than asking the assistant to generate a long answer. These
turns and the recall used `-c model_auto_compact_token_limit=20000` and disabled
the native shell/unified-exec tools per call. No model was substituted.

Three automatic compactions completed. `compaction-rollout-records.json`
extracts each native ContextCompaction completion's identity and timing;
durations are 19276, 29329 and 31185 ms. The companion window fixture extracts
the replacement-history lengths 2, 3 and 3, and the window links. Each new
window points to its predecessor. These are field-only extractions of native
records, not reconstructed histories. Encrypted content and operator context
remain only in the local synthetic rollout.

`compaction-recall.ndjson` recalls HERON-519; `post-compaction.ndjson` is a
later process at the default threshold that recalls it again. Codex's exec
stream reports no compaction event, so reporting stays null. Lowered thresholds
do not establish full-capacity behavior or lossless recall.

An earlier generation-heavy synthetic filler hit the probe's 240-second
wall-clock deadline after reading the operator's delegation skills. Its raw
output is retained locally, not copied here. The replacement probe deliberately
stages synthetic content with tools disabled. An initial invalid discovery
option was refused by HCN before spawn; it was a probe error, not a native
incompatibility. Both failed attempts are reported in the task validation.

## Models, efforts and app-server

`codex debug models` returned the same eight visible curated IDs. No new model
ID was added. `models-curated.json` extracts slug, visibility, default effort
and native effort ladder only. Native runs confirm gpt-6.1-sol medium,
gpt-5.6-sol/terra/luna low and gpt-5.5 xhigh. GPT-5.5 minimal fails first because
web_search cannot use minimal; repeating with web_search disabled returns the
model's own unsupported_value error naming none/low/medium/high/xhigh.

The owned descriptor adds low to the three 5.6 ladders and replaces minimal
with xhigh on 5.5. HCN's closed vocabulary still excludes native ultra and none.

The schema fixtures are unmodified files emitted by
`codex app-server generate-json-schema --out <synthetic-evidence-directory>`.
The schema regression exercises HCN's initialize/open/start/steer encoding;
the live smoke independently proves a real persistent session. Native exec
errors still surface, and version metadata remains evidence rather than an
admission gate.

Accounting stays null. The 0.160.0 official release notes and current
app-server docs expose no full pending-prompt accounting operation matching
HCN's contract. Historical token usage is not pending accounting. A public
source-CLI context inspection returns unavailable/unsupported-adapter.

Operator configuration echoed in `session.ndjson` hook output fields
`params.run.entries[0].text` is replaced with field-and-original-length
redaction markers. Independent review found these fields after the initial
pattern audit. All other capture bytes are preserved.
No older fixtures were altered.
