# Passive transcript reads: Pi and Muse

Research for [Verify passive transcript reads for Pi and Muse](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/156), under [Decide HCN's transcript read and export contract](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/154).

Produced on 2026-09-11 by GPT-6 Astra in the driving Codex session. A Muse Spark 1.3 Contributor delegation timed out without findings; it supplied no evidence used here. This is source and documentation research. No Pi or Muse read probe ran, no private history was read, and no model was called as a probe.

## Finding that changes the decision

**Documented, source-verified:** Pi 0.84.2 has the required distinction between saved entries and current conversation messages. Its `get_entries` handler returns all loaded entries, including other branches, plus the current leaf. But opening a saved session through `SessionManager.open` is not an unconditional passive operation: legacy formats are migrated and rewritten, and an existing empty file is initialized. An HCN reader must establish a passive method separately from the existence of a read command. [RPC implementation](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L634-L648), [opening and migration](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L895-L930).

**Documented only for current Muse:** Meta documents `muse export --session <uuid> --out run.json`. This corrects any blanket claim that Muse has no documented export. The reviewed page does not pin the feature to Muse 0.1.0 or specify full-history coverage, original records, cursors, or passive startup. No selected-version export capability is established here. [Headless and CI, Resume and audit non-interactively](https://dev.meta.ai/docs/muse-code/extending#headless).

These findings do not accept HCN ownership, narrow the proposed history scope, or resolve Trevor's ownership ticket.

## Provenance and scope

HCN's selected versions are Pi 0.84.2 and Muse 0.1.0. Pi uses an npm version source; Muse uses the installed binary as its version source. These descriptor pins are not proof of installed executable versions or transcript support. [Pi descriptor](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/2e19ca2abdfc877a6a373941def104c175f2faca/src/knowledge/pi.ts#L12-L16), [Muse descriptor](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/2e19ca2abdfc877a6a373941def104c175f2faca/src/knowledge/muse.ts#L13-L20).

Pi evidence uses the public `earendil-works/pi` tag `v0.84.2`, resolved locally to `914cf1472e715297caa30db4b9535d534a9eb718`. Its package manifest says 0.84.2. Exact source was read from that checkout, without executing it. [Package manifest](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json#L1-L18). The [current RPC page](https://pi.dev/docs/latest/rpc#get_entries) was checked, but the pinned source below governs these findings.

Muse evidence uses Meta's current public docs, retrieved through the local-docs cache on the research date with a reported age under two hours. The cached overview and extending page contain text. The interactive page contains only a login shell; direct web access to the extending and rewind pages also returned a shell. No versioned 0.1.0 source or export schema was obtained. No installed binary was used as a substitute for that selected version.

The main HCN graph coverage check reported matching metadata for the Pi descriptor and changed metadata for Muse. Both selected-version fields and Muse's relevant descriptor comments were read directly. The new third-party checkout is not indexed; its conclusions come from the cited exact source, not a graph completeness claim.

This investigation reuses the purpose and prior HCN findings in `/Users/kevin/dev/trevor/.scratch/assistant-architecture/research/hcn.md` and its sibling `../map.md`. It does not repeat a broad harness survey. The current HCN command-surface check is recorded in the parent map.

## Per-version capability table

All Pi entries below are documented or source-verified, not runtime observations. Muse cells distinguish current documentation from the unverified selected version.

| Area | Pi 0.84.2 | Muse 0.1.0 |
| --- | --- | --- |
| One identified conversation | Session manager opens an explicit file; RPC reads its loaded session. Native session header has its own ID. | Selected-version passive method unverified. Current docs accept a session UUID for export. |
| Full retained history | `get_entries` returns all loaded non-header entries in append order, including pre-compaction and abandoned branches. | Unverified. |
| Current messages | `get_messages` returns agent message state, restored using branch and compaction context. It is not the full entry log. | Unverified. |
| Native identity and provenance | Header session ID; entry IDs, parent IDs, timestamps; optional parent-session path. Header is absent from `get_entries`. | HCN's resume identity and store hints do not establish export identity or provenance. Unverified. |
| Tools, custom data, media | Entries retain message objects and custom data. Documented content supports tool calls/results, images, and custom entries/messages. | Export content and original-data coverage unverified. |
| Branches | Entry links preserve saved branches; `get_tree` includes orphans. Live `leafId` is separate from append order. | Unverified. |
| Incremental | `since` is an entry ID; missing anchor fails. Result includes leaf even when no entries follow. No bounded page size in this handler. | Unverified. |
| Stopped source | A read-only file loader exists, but silently skips malformed rows and does not expose live leaf moves. Ordinary open can write. | Unverified. |
| Active source | RPC reads loaded in-memory state; no evidence here of a cross-process file snapshot or external-writer refresh guarantee. | Unverified. |
| Passive startup | Not guaranteed by these APIs. Migration, initialization, and extension lifecycle must be addressed. | Current docs describe hooks; selected-version export startup remains unverified. |

Table sources and limits follow. A cell saying unverified is not a claim of impossibility.

## Pi records, context, and branches

**Documented, source-verified:** `get_messages` returns `session.messages`, whose getter returns agent state. On restore, the SDK uses `buildSessionContext`; that follows one branch and omits entries summarized by the latest compaction. A raw entry log and restored model context therefore answer different questions. [RPC handlers](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L634-L674), [message getter](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts#L954-L957), [context construction](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L414-L469), [SDK restore](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/sdk.ts#L365-L377).

**Documented, source-verified:** `getEntries` filters only session headers from the loaded file entries. It does not project recognized fields from each entry. Custom data and extra fields therefore survive this step as parsed JSON. That is not byte-for-byte original file preservation: parsing, skipped invalid rows, and prior migration can change the representation. Header ID, cwd, version, and optional parent-session information need separate retrieval or source capture. [Record types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L31-L153), [header and entries access](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L1291-L1303).

**Documented:** Message content supports text, images, thinking, and tool calls; tool results carry the call ID, name, content, and optional details. Custom entries store extension data separately from custom messages. Preservation of external files referenced by an extension is unverified and cannot be inferred from preserving its JSON. [Selected session format](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/session-format.md#L40-L103), [custom entries](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/session-format.md#L263-L282).

**Documented, source-verified:** An entry ID is a strict-after cursor; an absent ID is an error. The result always includes the current leaf. `branch` changes the in-memory leaf without appending a record, while loading rebuilds the leaf from the last non-header entry. Thus a stopped-file read cannot prove the current live branch when a process has moved its leaf without appending. A client restart against the same live process differs from restarting the harness from its file. [RPC contract](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md#L694-L751), [index rebuild](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L958-L976), [branch movement](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L1354-L1374).

**Inference from those implementations:** An ID cursor alone does not detect a replaced or edited file when the same anchor ID survives. Native append-only expectations do not protect against an external editor. HCN's bookmark contract must decide how source identity and change detection work; this research does not choose that contract.

## Pi passive reads and failure distinctions

**Documented, source-verified:** `loadEntriesFromFile` opens a specified path for reading, parses lines, and closes the descriptor. It does not migrate or write. It returns an empty array for a missing file or invalid header and skips malformed lines, including an incomplete final line. File open/read errors are not converted to that same empty result. This is a useful primitive, but its return value alone cannot distinguish every missing, malformed, or partial source required by the proposed contract. [Loader](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L503-L555).

**Documented, source-verified:** `SessionManager.open` constructs a persistent manager. Legacy migration assigns IDs to v1 entries and rewrites the source; v2 migration changes a message role. Startup may also append a missing thinking-level entry. Session replacement calls ordinary open, and extension binding emits the session-start event. Read handlers themselves do not invoke a model, but that does not establish a no-model/no-history-write lifecycle for startup, selection, or shutdown. [Migration](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L231-L295), [open](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L1525-L1554), [SDK initialization](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/sdk.ts#L365-L377), [switch lifecycle](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts#L196-L224), [extension binding](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts#L2237-L2260).

**Unverified:** Process startup with isolated state and disabled extensions; atomicity with a concurrent writer; truncation or replacement during a read; memory limits on huge entries; all attachment forms; and behavior of a specific customized Pi. Source inspection of a helper does not prove safe importing of the whole package. No upstream RPC test was run: the inspected cursor and compaction tests prompt a model. [Those tests](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/test/rpc.test.ts#L308-L363).

## Muse limits

**Documented, current only:** Meta's export example uses a session UUID and output file. The docs say the export includes the producing CLI version. They also describe session lifecycle hooks and model-using observer agents. These descriptions establish why an ordinary running agent is not evidence of a passive export lifecycle; they do not establish that export invokes those mechanisms. [Export, hooks, and observers](https://dev.meta.ai/docs/muse-code/extending#headless).

**Unverified for 0.1.0:** Whether export exists; its schema and native identity; full versus compacted content; abandoned branches and related child sessions; tool results, attachments, and custom fields; original records; incremental cursors; active and stopped consistency; malformed, missing, inaccessible, replaced, and partial source behavior; no-model and no-history-write guarantees. The current documentation reviewed does not settle these. HCN's existing store-path and stream-identity hints are resume evidence, not an export contract. [Muse descriptor](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/2e19ca2abdfc877a6a373941def104c175f2faca/src/knowledge/muse.ts#L30-L77).

Evidence to settle this requires a version-identifiable 0.1.0 distribution or first-party versioned specification, followed by an isolated synthetic export probe. No private store should be sampled to fill these gaps. A future decision may instead select a newer Muse version; that is not done here.

## Conditions to test for customized Pi

These are inferred compatibility conditions for the next human decision, not an accepted HCN interface:

- Preserve session identity, format provenance, entry IDs, parent links, and append ordering, or declare the differences.
- Preserve full saved entries, custom records, tool fields, and non-text content independently of the model-context conversion.
- Preserve strict-after cursor behavior and missing-anchor errors. Report leaf changes independently of new entries and distinguish live leaf state from file-derived state.
- Provide a read path that does not migrate saved files, append initialization records, run model work, or depend on arbitrary extension lifecycle effects.
- Expose partial data and unsupported features explicitly. A fork using Pi's SDK does not establish any of these behaviors by itself.

A from-scratch harness can be assessed against the same questions without adopting Pi's storage or protocol. Its concrete requirements remain the later map decision.

## Validation and remaining work

Commit/path/line citations are checked against their owning local clones, with results in `pi-muse-citation-check.json`. The standard research citation verifier is also run against each owning clone; foreign-repository commits are classified separately from genuine failures. It also misreads prose about transcript branches as Git branch claims named `and`, `when`, and `movement`; these are not Git branch assertions. All 23 distinct pinned source links passed the owning-clone checks. No runtime support is claimed from citation validation.

Before a selected native read path can be called supported, synthetic probes still need to cover its startup and teardown, unchanged source bytes, zero model calls, compaction and branches, custom records, missing/invalid cursors, malformed/truncated/replaced sources, concurrent appends, and attachment limits. These are recorded gaps for the contract decisions and any later implementation work. They are not omitted findings or an accepted narrower product scope.
