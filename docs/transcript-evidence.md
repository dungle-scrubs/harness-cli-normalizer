# Native transcript readers: selected-version evidence

Checked September 12, 2026. This continues the selected-version research linked from [RFC-03](rfc/03_native-transcript-retrieval.rfc.md). For Muse and Claude, only public distributions, documentation and synthetic histories were read. No private native transcript or credential was read. The Cursor and Antigravity sections below rest on structural observation of local stores written by hcn's own runs; they say exactly what was inspected. The implemented methods read native files directly under the separate [filesystem snapshot rule](transcript-snapshot.md). These findings do not change a harness's broader `verifiedAgainst` pin.

Method applicability is a format contract: one identified native conversation in the declared local format, preserved native objects, physical record order and a successfully acquired filesystem clone. These conditions do not require guessing the last writer's build. Selected-build evidence is reported separately from that format applicability. The inference is bounded: unknown fields can remain opaque, but an alternate storage format, schema, identity model or source assembly does not qualify merely because some fields match. No source writer build is inferred. Claude's per-record `version` remains in each original; neither format establishes one build for the whole file.

## Muse 1.1.1

Selected vendor binary: `muse-bin-1.1.1-R2514.1`. Its SHA-256 is `7dfd75e1e2dd7c763e60b7e379f4146b8b2b10478a2830c8cdbb35ae9961881e`. `--version` reports `Muse Code 1.1.1 (1.1.1-R2514.1)`; its export identifies reader semver `1.1.1`, SHA `b934305d21`, and export schema version 1. Synthetic inputs do not establish a native writer build. Integration preserves upstream's broader Muse 1.1.1, Claude 2.1.263 and Codex 0.153.4 pins. The older Claude/Codex transcript evidence below and in their method declarations remains separately scoped; integrating upstream does not re-verify those methods for newer writers.

Meta's [public stable channel](https://api.meta.ai/muse-code/channels/muse-stable) resolved to this version on the verification date. Its [versioned release manifest](https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.1.1-R2514.1&file=manifest.json) identifies the [aarch64 macOS artifact](https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.1.1-R2514.1&file=muse-aarch64-macos), SHA-256 above, and size 260444384 bytes. These match the local binary. The [captured manifest](../research/transcripts/muse-111/manifest.json) retains those official artifact facts.

The selected binary's `export --help` documents explicit `--session <id|path>`, raw export, and an offline local-file operation. The probe captures the exact version/help outputs in its results. Help points to `docs/session-export.md`, which was not obtained as a versioned standalone document. The binary's [captured bundled envelope example](../research/transcripts/muse-111/bundled-envelope.txt) includes its binary byte offset and native stream identity, sequence, payload type and payload. Current [official automation docs](https://dev.meta.ai/docs/muse-code/extending) describe export, but are not evidence for a specific build's integrity or snapshot rules.

The [reproducible probe](../research/transcripts/muse-111/probe.mjs) checks the binary hash before invocation. It supplies only generated files through an explicit selector, isolates HOME/XDG/cwd and the environment, avoids the credential and updater wrappers, caps each invocation at five seconds, and removes its own temporary directory. Run it with Node and the absolute path to that exact vendor binary. The [recorded results](../research/transcripts/muse-111/results.json) contain synthetic summaries only.

Observed outcomes:

- Unknown envelope payloads survive the raw export, including unknown fields.
- Malformed lines, incomplete tails, duplicate records and input without valid identity all exit 0. The export reports some of these in diagnostics. An input with a sequence gap reports `gaps: 0`; that diagnostic alone does not establish contiguous source coverage.
- An explicit file containing two native session streams produces two sessions. An HCN adapter must validate the selected conversation instead of accepting export success as identity proof.
- The integer `9007199254740993` survives, but the native decimal `1.234567890123456789` becomes `1.2345678901234567`. Native export output alone cannot satisfy HCN's exact-original-value contract for those values.
- All generated source bytes remain unchanged. No authentication is supplied. These probes do not instrument network calls or exhaust arbitrary configuration, hook, extension or concurrent-writer behavior; they do not prove the full passive lifecycle.

`muse-file-v1` bypasses the exporter. The selected binary's bundled read-session documentation, starting near byte 203540400, identifies a main `session.jsonl`, separate `subagents/<child-id>/session.jsonl` logs and external tool-output files. Its schema-1 envelope example near byte 203543600 supplies record ID, session stream ID, sequence, microsecond timestamp, payload type and payload version. Native ID lookup uses the documented date-sharded `${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/*/*/*/<id>/session.jsonl` layout. HCN scans exact ID path suffixes and rejects multiple matches before validating the selected file's stream identity. It never merges child conversations or opens external content references.

The bundled diagnostic helper supplies additional field evidence. `_event` near byte 203470800 extracts `payload.event`; `_project` near byte 203480100 maps user/assistant events. Near byte 203481387, `assistant_tool_calls_committed` contains `tool_calls`, each with a native call ID, name and arguments. Near byte 203483374, tool result variants contain `results` or one result with `tool_call_id`/`call_id` and `text`/`output`/`result`. Serializer strings near byte 205081994 corroborate `ToolResultBatchCommitted` and `ToolResultBatchEntry`. HCN preserves the full original instead of copying the diagnostic helper's redaction, truncation or renamed tool labels.

HCN validates one schema-1 session stream, unique record IDs and increasing native sequences, preserves unknown payloads and exact decimal tokens, and reads complete framing units from one filesystem clone. Gaps and a nonzero first sequence do not establish their cause; historical loss remains unknown. Saved/live branch selection and unfamiliar relationships remain unknown. This establishes a direct-file method without asserting an undocumented append-only writer rule. Export success remains insufficient evidence for another method, and coverage opt-ins cannot waive the fixed requirements.

## Claude 2.1.233

Selected public distribution: [@anthropic-ai/claude-code-darwin-arm64 2.1.233](https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.233.tgz). Registry SHA-512 was verified as `mB2FyJQ0a+FTWbBTSQ3ZTAmm6Qxr5fSU2jA8JpHQ7XslcoKzmDV+/zN8CdGkshwY3kRLx432kDiHcBoTQuc/Dg==`. The extracted binary SHA-256 is `bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d`.

The following evidence is embedded implementation text in that exact distribution, not runtime observation. Byte offsets are zero-based in the binary and locate the named functions:

| Locator | Finding |
| --- | --- |
| `sXf.appendEntry`, byte 283145756 | Entry policy routes agent records to separate files. Some writes use a storageV5 backend or remote persistence. The local-main-file method does not claim those separate formats. |
| `jJf`, byte 283236103 | User/assistant/system/attachment/progress entries use transcript deduplication; some metadata always appends; content-replacement/fork-context-ref/observer-ref can route by agent. |
| `sXf.performRemoveByUuid`, byte 283139783 | Opens the existing file with `r+`, truncates it at a removed entry and writes a retained suffix back. Its fallback rewrites the same path with `writeFile`. This is an in-place writer, not an append-only protocol. |
| `sXf.performCompactTranscript`, immediately following `performRemoveByUuid` | Computes retained ranges, stages a replacement, validates samples/inode, copies a completed appended tail and replaces the original. Disk compaction can delete retained entries. |
| `dJa`, byte 283152250 | Uses a storageV5 append when a backend is supplied, otherwise appends to the local file. |

Earlier matched Agent SDK 0.3.233 research remains applicable: `getSessionMessages` selects a parent chain and filters original fields and record kinds; it skips malformed rows and can omit pre-compaction data in large files. Empty results do not independently distinguish missing identity from empty history. The current [official session-browser guide](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) describes the API but does not replace selected-version evidence.

`claude-file-v1` reads the main local JSONL format. The backend dispatch above chooses another persistence format when supplied; HCN does not infer an additional local segment or query a remote backend. Agent sidechains are separate conversations and are refused by this method. A fork's `parentSessionId` and `parentLastUuid` (native `v3a`, byte 283150805; hydration near byte 283153588) remain scoped references, not instructions to load another conversation. Native UUIDs, parent links and every retained metadata row remain intact. `Ujr` near byte 283150158 records an explicit saved `last-prompt` leaf; it does not establish a live selection.

ID lookup scans exact `<id>.jsonl` names under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`, rejects duplicate matches and checks the embedded session ID. Current [official settings documentation](https://code.claude.com/docs/en/settings) confirms that `CLAUDE_CONFIG_DIR` relocates session history. This current location-setting documentation is separate from the selected 2.1.233 field evidence. An explicit file can address another known local location without scanning native stores.

The snapshot rule covers in-place changes without invoking the SDK or writer. HCN preserves complete pre-compaction rows and abandoned branches that remain in that view. Disk compaction may already have removed data; the reader does not reconstruct it or promise lifetime completeness. The selected `compact_boundary` record can expose `compactMetadata.preservedSegment.headUuid` as a first-kept-entry reference. Unknown future rows stay opaque. A native format label is not authentication of an arbitrary customized writer, and no claim is made that the selected 2.1.233 evidence re-verifies every behavior in 2.1.263.

## Cursor 2026.09.15-d2fe57e

Checked September 19, 2026, on macOS with the installed `agent` 2026.09.15-d2fe57e. No vendor source or format documentation was found, so this method rests on observed local stores. All 71 stores under `$XDG_CONFIG_HOME/cursor/chats` on the verification machine were written by hcn smoke, qualification and end-to-end runs. The inspection recorded schemas, field names, part types, counts and ordering only. No store or message content was copied into this repository.

Observed format:

- Each chat is `chats/<md5-of-cwd>/<agent-id>/store.db` with a sibling `meta.json`. The database uses WAL mode, 4096-byte pages and UTF-8 text.
- The schema has exactly two tables: `blobs (id TEXT PRIMARY KEY, data BLOB)` and `meta (key TEXT PRIMARY KEY, value TEXT)`. One meta row with key `0` holds hex-encoded JSON with `agentId`, `latestRootBlobId`, `name`, `mode`, `isRunEverything`, `createdAt` and `blobEncryptionKey`.
- A blob ID is the SHA-256 of its bytes. The latest root blob is protobuf. Its repeated field 1 holds 32-byte message blob IDs in conversation order; the other fields hold context accounting, the workspace URI and client metadata.
- Message blobs are AI SDK message JSON: `system`, `user`, `assistant` and `tool` roles; string content or `text`, `reasoning`, `redacted-reasoning`, `tool-call` and `tool-result` parts. All 386 referenced messages across the 71 stores parsed as single JSON objects.
- Every store also retained earlier root blobs, and every earlier root's message list was a prefix of the latest root. No summarization rewrite was observed; the reader fails closed if one appears.
- After a turn ends, the WAL is empty or deleted. During a live turn it is nonempty for the whole turn: 54 of 60 reads taken while a resumed turn ran were refused with `guarantee-unmet`, 6 completed before the turn wrote, and none returned a malformed or partial view.

Verification: `cursor-store-v1` read all 71 stores under Node and Bun. Its message IDs, order and originals matched a `node:sqlite` query of the same stores for all 386 records, and no output contained a `blobEncryptionKey`. An end-to-end `hcn run cursor`, `transcript read`, `run --resume`, `transcript read --since` sequence returned only the resumed turn with a verified continuation.

The meta `blobEncryptionKey` suggests Cursor can encrypt blobs. Every observed blob was plaintext; an encrypted or otherwise non-JSON message blob fails as `source-malformed`.

## Antigravity 1.2.7

Checked September 19, 2026, on macOS with the installed `agy` 1.2.7. The store location comes from the [harness assessment](research/2026-09-19-antigravity-cli-harness-assessment.md); the step-log format rests on observed local logs. All 29 conversations under `~/.gemini/antigravity-cli/brain` were written by hcn qualification and end-to-end runs. Only field names, step types, counts and byte comparisons were recorded.

Observed format:

- Each conversation directory holds `.system_generated/logs/transcript.jsonl` and `transcript_full.jsonl`, plus chunked copies under `logs/chunks/`. One conversation had no logs directory.
- Steps are JSON objects with `step_index`, `source`, `type`, `status` and `created_at`. Types seen: `USER_INPUT`, `PLANNER_RESPONSE` (with `thinking`, `content` and `tool_calls` of `{name, args}`), `GENERIC` (tool execution output, with `error` when `status` is `ERROR`) and `SYSTEM_MESSAGE`.
- `transcript.jsonl` truncates long fields, marks them in `truncated_fields` and re-quotes tool arguments. `transcript_full.jsonl` carried no truncation marker in any log, so the method reads only that file.
- In all 28 logs, `step_index` started at 0 and increased by 1 per line. Every log ended with a line feed. Each log fit in one chunk; chunk rollover was not observed, so the reader refuses a log that does not start at step 0.
- Steps carry no conversation ID, record ID or tool call ID. Identity comes from the `brain/<id>` directory.

Verification: `antigravity-file-v1` read all 28 logs under Node and Bun. An end-to-end run, read, resume and `--since` sequence returned only the resumed turn's steps with a verified continuation.
