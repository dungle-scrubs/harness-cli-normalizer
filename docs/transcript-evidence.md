# Disabled transcript readers: selected-version evidence

Checked September 12, 2026. This continues the selected-version research linked from [RFC-03](rfc/03_native-transcript-retrieval.rfc.md). Only public distributions, documentation and synthetic histories were read. No private native transcript or credential was read. The findings below do not enable a reader or change a harness's broader `verifiedAgainst` pin.

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

Retrieval stays disabled. Enabling it requires a complete passive-lifecycle rule, authoritative source assembly and ordering, exact-value preservation, independent identity/integrity validation, and a consistency rule that covers the selected writer. Export support exists; an HCN-compatible adapter is not established. Coverage opt-ins cannot waive the fixed requirements.

## Claude 2.1.233

Selected public distribution: [@anthropic-ai/claude-code-darwin-arm64 2.1.233](https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.233.tgz). Registry SHA-512 was verified as `mB2FyJQ0a+FTWbBTSQ3ZTAmm6Qxr5fSU2jA8JpHQ7XslcoKzmDV+/zN8CdGkshwY3kRLx432kDiHcBoTQuc/Dg==`. The extracted binary SHA-256 is `bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d`.

The following evidence is embedded implementation text in that exact distribution, not runtime observation. Byte offsets are zero-based in the binary and locate the named functions:

| Locator | Finding |
| --- | --- |
| `sXf.appendEntry`, byte 283145756 | Entry policy routes agent records to separate files. Some writes use a storageV5 backend or remote persistence. A selected local file alone does not establish all authoritative storage. |
| `jJf`, byte 283236103 | User/assistant/system/attachment/progress entries use transcript deduplication; some metadata always appends; content-replacement/fork-context-ref/observer-ref can route by agent. |
| `sXf.performRemoveByUuid`, byte 283139783 | Opens the existing file with `r+`, truncates it at a removed entry and writes a retained suffix back. Its fallback rewrites the same path with `writeFile`. This is an in-place writer, not an append-only protocol. |
| `sXf.performCompactTranscript`, immediately following `performRemoveByUuid` | Computes retained ranges, stages a replacement, validates samples/inode, copies a completed appended tail and replaces the original. Disk compaction can delete retained entries. |
| `dJa`, byte 283152250 | Uses a storageV5 append when a backend is supplied, otherwise appends to the local file. |

Earlier matched Agent SDK 0.3.233 research remains applicable: `getSessionMessages` selects a parent chain and filters original fields and record kinds; it skips malformed rows and can omit pre-compaction data in large files. Empty results do not independently distinguish missing identity from empty history. The current [official session-browser guide](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) describes the API but does not replace selected-version evidence.

Retrieval stays disabled. A Claude method needs authoritative source assembly, independent identity/integrity checks, and a passive snapshot or generation rule that covers in-place changes. Pi/Codex's append-only prerequisites do not cover this writer. Merely reading twice, requesting a coverage opt-in, or trusting an empty SDK response does not resolve those requirements. The Claude reader ticket remains unfinished.
