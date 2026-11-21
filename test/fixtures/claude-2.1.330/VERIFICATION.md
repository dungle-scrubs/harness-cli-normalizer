# claude-2.1.330 verification

Status: Qualified anchor.

Seven compatibility cells and the question probe passed on Claude 2.1.330 with sonnet on 2026-11-21, run by the lead from a signed-in shell (the worker's own shell has no working Claude sign-in, so no live probe was rerun for this anchor; work proceeded from the lead's captures only). One of three question runs did not ask: run 1 answered by writing a file instead (its capture and snapshot are retained outside the fixture, as `questions-captures.run1/` and `questions.snapshot.run1.json` in the evidence tree); reruns 2 and 3 both asked, and this fixture carries run 3. Fresh and resumed native context estimates passed, and the original synthetic source transcript hash did not change. Automatic compaction completed (97,067 to 1,718 tokens); a later process recalled HERON-CLAUDE-442. No native compaction failure was observed in the successful qualifying run, and no failure outcome was forced. The npm source remains @anthropic-ai/claude-code.

Malformed and failed accounting operations remain unavailable through the deterministic inspect-context suite (test/cli/inspect-context.test.ts), which validates the operation independent of version metadata; no live malformed probe was re-run for this anchor.

## Probe settings

- Tool isolation on the accounting and compaction probes: `--tools '' --strict-mcp-config --mcp-config {"mcpServers":{}}`; the compact turn and the later recall pass the same. The seven-scenario and question smokes run with the harness's default tools (their init lists 32 tools, Bash and Write included).
- The executable under test was the machine's own claude at
  ~/.local/share/claude/versions/2.1.330 (~/.local/bin/claude), the binary
  `hcn inspect claude --runtime` selects. `version-source.snapshot.json` records the
  npm observation: at capture time the latest dist-tag was 2.1.330.
- The compaction ladder's compact turn resumed the session with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` exported for that child only (97,067 to 1,718 tokens). Lowered thresholds are a probe setting, not an HCN default.
- The accounting probes rendered `--setting-sources project`, the adapter's discovery option, and this generation observed the machine's env-sourced window on claude-sonnet-5-5: 500,000 context window, 467,000 input limit, 3,164 tokens fresh and 20,855 tokens on the resumed fork. The 2.1.312 generation observed the 1M model default window under the same flag; the reported window follows the machine's environment and the setting scope, not the version.
- The ladder used `--resume` for turns after the first.
- The init capture lists the Artifact, ArtifactComments and ArtifactData
  tools alongside Task, exactly as 2.1.329 did, and omits WebFetch from the
  default-enabled list. The 2.1.330 init also advertises one capability
  string 2.1.329 did not: `withdrawn_tools_v1` (observed only; nothing
  consumes it yet).
- WebFetch was probed on this version: absent from the init tool list on
  2.1.329 and 2.1.330 even with `--setting-sources ""`, so operator settings
  do not cause it; `--tools WebFetch --allowedTools WebFetch` together
  restored a working fetch (observed 2026-11-21 on 2.1.330, fetching
  example.com); CLAUDE_CODE_DISABLE_WEB_FETCH
  is not set; Claude's changelog from 2.1.312 to 2.1.330 records no default
  removal, and 2.1.323 notes organization policy can disable WebFetch. The
  absence is therefore most likely account or organization policy, not a
  harness default; the descriptor keeps `defaultEnabled: false`, which
  matches the captured init list.

## What this anchor does not establish

- Lowered thresholds do not establish full-capacity behavior or lossless recall. Summary retention is checked through marker recall, not byte-for-byte comparison.
- No native compaction failure was observed and none was forced.
- The question probe's run-1 miss (the model wrote a file instead of asking) was not reproduced; whether 2.1.330 asks more reliably than one-in-three under that prompt is not established by two passing reruns.

## Captured evidence

`seven.snapshot.json` and `questions.snapshot.json` are the smoke-suite receipts (the question snapshot is run 3, the second consecutive passing rerun). `version-source.snapshot.json` records the published npm version observation. Fresh and question NDJSON files contain selected native identity/assistant/result records. Configuration-bearing hook and user frames are omitted; these are excerpts, not complete native streams. Their init records replace operator skill and command names, custom agent names, configured MCP names, configured MCP tool names, the MCP-contributed slash command and operator-configured plugin names/paths/name-bearing sources with field-naming markers that report the original character length of the content they replace. Native commands, bundled skills (including the slides, artifact-diagramming, whiteboard and artifact-capabilities additions this generation lists), built-in agents and plugins, native terminal command names, native tool names and all bytes outside those configuration fields are preserved. Non-init records are unchanged.

Compaction/accounting files are selected native records. The accounting `memoryFiles` paths remain session metadata, not operator instruction content. Other fields remain unchanged.

`accounting-fresh.proof.snapshot.json` and `accounting-resume.proof.snapshot.json` are per-probe proof snapshots derived from the raw captures: the captured argv, the exact staged synthetic prompt, a frame-type listing of the complete native recording, the replayed user message, the terminal result record and the usage control response copied verbatim (each pinned by the SHA-256 of its original native line), and the adapter's accounting result. The recordings' operator hook and init frames, the initialize control response and the command_lifecycle records are omitted under an explicit excerpt note inside each proof; copied records are not edited, truncated or redacted.

The live probes use synthetic data only. Old versioned fixtures remain intact.
