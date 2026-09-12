# Native transcript reads

Use `hcn inspect <harness> --transcript` to inspect passive read methods and their evidence. Use `hcn transcript read` to export one native conversation as JSONL. These commands do not resume a model, load instructions or extensions, or modify native history.

```sh
hcn inspect pi --transcript
hcn transcript read pi --file /path/to/native.jsonl > transcript.jsonl
hcn transcript read pi --id NATIVE_ID --cwd /path/to/project --limit 100
hcn transcript read pi --file /path/to/native.jsonl --since OPAQUE_BOOKMARK --limit 100
```

The file path identifies a native conversation. It is not an HCN capture or consumer ID. Pi ID lookup uses the selected workspace's native session directory under `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. An explicit file is useful for native custom session directories. Missing sources fail; HCN never creates them. Codex ID lookup searches exact native filenames under CODEX_HOME/sessions and CODEX_HOME/archived_sessions (default ~/.codex). Database-only or renamed locations require an explicit file. Inherited storage still resolves within CODEX_HOME. Referenced attachments and separate parent/child conversations stay references. A Codex history_base is an explicit bounded storage range, not permission to export the rest of that parent conversation.

The stream contains one `source`, zero or more `record` objects, and one terminal `result`. A batch succeeds only when `result.status` is `complete` and the producer exits 0. Invalid requests and descriptor refusals exit 2; read, cleanup, interruption, and output failures exit 1. Records are provisional until success. Broken pipes do not establish successful exports.

Each record retains its complete native `original` object alongside normalized message parts, tool identifiers, timestamps, and established relationships. Unknown native fields stay in `original`; unfamiliar entry kinds and links stay unknown. Native IDs can be null. Positions are source coordinates, not permanent HCN IDs. Use a lossless JSON parser or retain the original wire text when preserving native numbers beyond JavaScript's exact range. Plain `JSON.parse` can round them.

Coverage describes the accessible retained history, including saved branches and pre-compaction entries. `--limit` counts whole native entries in one finite view. It does not limit bytes or validation work. Current context is not substituted for retained history. `historicalLoss` separately describes established native persistence omissions; complete retained coverage does not reconstruct deleted or never-persisted events.

Save a returned bookmark only after successful delivery. Send it back unchanged through `--since`. HCN verifies the native identity and the entire committed prefix. Empty and EOF reads can return usable same-boundary bookmarks. Earlier edits, truncation, incompatible methods, or an unknown bookmark version fail rather than silently restarting. Caller-supplied relocation can work when identity and the prefix still match. HCN keeps no bookmark registry, index, watcher, retention policy, or search service.

## Enabled methods and evidence

| Harness | Enabled view | Limits and disabled work |
| --- | --- | --- |
| Pi | `pi-file-v1`: native v3 JSONL, ID/file selection, full retained records, batches and bookmarks | Saved reload selection only, never a live branch claim. Unknown/legacy formats are rejected without migration. A required bookmark over 65536 encoded bytes disables continuation for that source. |
| Codex | `codex-rollout-file-v1`: uncompressed legacy and paginated rollouts identifying CLI 0.147.0; ID/file selection, batches and bookmarks | Native history_base ranges are assembled oldest first and verified across every source. Missing bases, ambiguous IDs, invalid ordinals/cutoffs and incomplete subagent initialization fail. Compressed sources are unsupported. Native transient-event omissions are historical loss. |
| Claude | No enabled method | Claude 2.1.233 can rewrite files in place and use alternate storage. SDK 0.3.233 is a filtered projection. Source assembly and a suitable consistency rule remain unverified. |
| Muse | No enabled method | Muse 1.1.1 export exists, but rounds some decimal values and accepts malformed or unidentified input with exit 0. Exact-value, identity, assembly, consistency and full lifecycle checks remain unverified. |

Inspection carries pinned public evidence and method rules. Descriptor `verifiedAgainst` still describes the existing harness verification anchor; transcript method evidence is separate. A file format does not reveal an unknown writer build, so Pi source `writerBuild` remains null-valued. Codex's observed `cli_version` identifies its version, but not a build hash. No native reader process runs.

Claude and Muse inspection includes [selected-version findings and remaining requirements](transcript-evidence.md). Their read refusals point to inspection and explain the blocker before opening the requested source. `--accept-limits` does not enable these readers.

Pi facts are anchored to [0.84.2 session-manager source](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts). Codex assembly follows the [selected native lineage rules](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/thread-store/src/local/rollout_lineage.rs). Other Codex facts are anchored to [0.147.0 rollout persistence](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout/src/recorder.rs) and [persistence policy](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout/src/policy.rs). Earlier selected-version research is linked from [RFC-03](rfc/03_native-transcript-retrieval.rfc.md); it is not repeated here.

## File consistency and custom harnesses

The enabled methods rely on the identified native append-only write protocol. They capture a regular file's device/inode identity and finite size, read the same prefix twice through one open handle (the verification pass uses bounded chunks), compare every byte, and verify path/handle identity and absence of truncation. Later appends are outside that view. Only LF-complete entries are parsed; an unfinished final framing unit is reported with its position and excluded from progress. Required consistency checks are reported individually. All file closes start together and share one one-second cleanup bound. For multi-source histories, every captured prefix is rechecked after all contributing sources have been captured.

The checks detect observed replacement, truncation, and prefix edits. They are not a filesystem snapshot against arbitrary in-place writers that can change bytes and restore them between observations. The native writer assumptions are part of applicability, not a waived coverage limit. Customized Pi qualifies only while preserving the v3 one-file conversation, native identity, append/order/framing, and saved selection semantics. Unknown extra fields and entry kinds are preserved; identical version labels alone do not establish arbitrary custom lifecycle behavior.

A from-scratch harness needs its own immutable descriptor facts, passive lifecycle, source assembly/order rules, native identity rules, normalization mappings, and synthetic conformance evidence before a method is enabled. Existing HCN does not provide a runtime harness-registration or custom-reader plugin API. A consumer owns its native-format extensions until they meet that contract. `--accept-limits` cannot waive passivity, integrity, identity, consistency, or requested bookmark/paging behavior.

## Verification and remaining slices

All added tests use synthetic histories. The CLI tests cover inspection/refusals, full Pi export, ID lookup, bounded continuation, retained branches/tool results, Codex legacy and inherited export, archive lookup, invalid cutoffs/identity/cycles, incomplete initialization, and output failure. Injected filesystem/clock/output tests cover interruption, bounded cleanup, in-call changes, and emission interruption. Conformance tests cover empty/EOF bookmarks, incomplete UTF-8 tails, corruption and duplicate keys, exact numbers/Unicode, and input validation. Method-selection tests cover unwaivable passivity, unavailable retrieval, preference for full history, and explicit reduced-view opt-ins.

No private native transcript was read. These tests verify HCN's reader behavior; pinned native source supplies documented writer evidence. They do not claim an observed live native writer experiment.

Claude and Muse reading remain unbuilt pending the evidence described above. Codex compressed storage and database-only ID resolution are not supported. The RFC permits disabled methods when fixed guarantees cannot be established. Those slices are not reported as implemented. No Trevor ownership ticket is changed.

The current file pipeline retains buffers for contributing source ranges and parsed originals, uses bounded verification chunks, and hashes each committed byte once per read. It uses memory proportional to source size and revalidates the full prefix even for small batches. Whole native entries are never truncated to fit memory. A large-source read can fail with `source-inaccessible` if allocation or I/O cannot complete. Streaming validation can reduce peak memory without changing the wire contract.

Review dispositions: the selected Pi implementation writes `branch_summary.fromId` from the same branch origin used for `parentId`; a differing pair is outside that verified mapping, so it remains original data with an unknown normalized origin. File compatibility is conditional on the declared native format/write protocol, not authentication of an arbitrary custom writer. See the method applicability before using a modified writer.
