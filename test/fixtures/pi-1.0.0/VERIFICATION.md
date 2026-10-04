# Pi 1.0.0 verification

Captured on pro, 2026-10-03, primary model `openai-codex/gpt-6.1-sol`.
Both required capability tripwires passed using distinct capture directories
and synthetic workspaces. `seven.snapshot.json` has seven passes;
`questions.snapshot.json` attests Pi 1.0.0, this model and this date.
`fresh.ndjson` and `question.ndjson` are the corresponding native first captures.

## Additional native contracts

- `provider-only.hcn.ndjson`: Pi requires model alongside provider. Hcn exits
  1 with native failure/nativeExitCode 1, preserving the startup crash outcome.
- `strict-tools.ndjson`: explicit read-only allowlist drops runtime extension
  registrations; the captured synthetic observer reports only `read` active.
- `mcp-resume.ndjson`: a resumed disposable session calls the explicitly granted
  synthetic stdio MCP tool. No remote server or authentication is involved.
- `rpc-live.ndjson`: Pi acknowledges prompt-with-steering as queued, applies
  it to the current run and emits two agent_settled boundaries. The associated
  hcn phantom-turn close defect was corrected in the execution layer after
  this capture; native behavior was unchanged. Corrected live verification
  confirmed proper next-input correlation and an 8 ms close.
- `recovery.native.ndjson`, `recovery.hcn.ndjson`: one process first uses an
  explicitly selected synthetic error provider, preserving a task failure,
  then explicitly returns to the primary model and completes cleanly. A
  malformed set_model request is rejected without losing native state. Two
  independent live trials confirmed stable ID/PID, one spawn and EOF exit 0
  without any signals. This was not an automatic alternative-model retry.

## Automatic compaction and separate-process recall

`compaction-json.*` and `compaction-rpc.*` each contain native automatic
threshold reporting, the matching persisted synthetic session, and later
process recall. Both histories supplied a unique marker only in the original
seed, before the installed kept boundary. The summary retained the marker;
the recall prompt did not resupply it. Regression tests compare native result
summary, boundary, tokensBefore, details and usage against the persisted entry,
then decode the compaction pair and check native recall.

The project was trusted process-locally through `--approve`. Observed model
window: 272,000. Project reserve: 256,000, keepRecentTokens: 500. Native
pre-compaction tokens: 53,313; estimated replacements: 1,610 JSON / 1,611 RPC.
These lowered-threshold checks prove replacement installation and this marker's
recall, not steady full-capacity behavior or lossless recall.

`compaction-abort.native.ndjson` preserves a resultless automatic aborted end,
followed by Pi's later automatic successful compaction during the same trial.
`compaction-malformed.native.ndjson` preserves Pi accepting an extension's
nonexistent firstKeptEntryId. It is an upstream observation, not a successful
rejection test or proof of valid replacement installation. Hcn reports the
native outcome rather than inventing a guard.

Default-threshold probes separately observed no compaction for the tested
small history, and native overflow compaction/recovery for an untrimmed
1,266,890-byte incoming prompt. Those findings do not establish calibrated
steady-state behavior at the maximum context capacity or later marker recall
under default settings.

## Redaction and evidence consumption

Native bytes are unchanged except operator configuration in system-message
sections `project_context`, `docs`, `skills`, and descriptions of non-builtin
toolsAdded entries, replaced with field/length-naming redaction markers.
The question probe also read an operator skill file. Its tool-result preview
and repeated `details._fullText` fields are replaced with the same markers;
native tool arguments, paths, identities and all other bytes are preserved.
Compaction session/stream files were captured with discovery/tools disabled
and a synthetic system prompt; their audited fixture copies are byte-identical.
An initial pattern audit missed that skill-read result. Independent review
found it, and a field audit corrected the fixture copies.
Old Pi recordings are preserved.

Consumed by `test/knowledge/pi-evidence.test.ts`,
`test/knowledge/pi-1.0-evidence.test.ts`, and
`test/knowledge/pi-1.0-compaction.test.ts`. Version-source package identity
remains `@earendil-works/pi-coding-agent`; the selected installed package and
runtime both report 1.0.0. The descriptor's anchors update together after the
required live gates, not as a runtime version ceiling.
