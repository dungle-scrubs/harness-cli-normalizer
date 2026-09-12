# Review: RFC-03 Native transcript retrieval (draft-01, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/03_native-transcript-retrieval.rfc.md`, `revision: draft-01`, `status: Draft`, `type: protocol`.
- **Commit:** `d5dd1ccbacb16fa6490552c2b524151a7fd8a4ee`.
- **SHA-256:** `4b4bc3bb165602bd45cbaa3ca53aedd148d1c142a8028b72d63b3d3b6ab1c515` (checked with `sha256sum` before writing this review).
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation.
- **Inputs used:** the RFC; `AGENTS.md`; `CONTEXT.md`; ADR 0002 and ADR 0007; the four resolution files in `/Users/kevin/dev/harness-cli-normalizer/.scratch/transcript-planning/publication/`; and both research summaries. `git hash-object` shows that each research file matches the blob at the commit the RFC links (`a7c40bd`, `7fb91e1`). HCN source is cited per finding.
- **Kind of review:** a planning review. It does not accept the RFC, authorize implementation, or decide whether to build the feature.

## Structural results

Command:

```
npx tsx /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts /private/tmp/hcn-transcript-contract-20260911/docs/rfc/03_native-transcript-retrieval.rfc.md
```

Output, verbatim:

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Evidence grades

Grades follow `blast-radius/references/EVIDENCE-LADDER.md`:

- **Rung 2:** points at RFC lines, resolution lines, or HCN source.
- **Rung 3:** traces existing HCN execution.

No finding reaches rung 4. The transcript protocol is not implemented, so no finding is reproduced by running code. A claim about runtime impact without a reproducer is labelled unproven.

Each finding is one of three kinds:

- **Contract gap:** the proposed contract is undefined or inconsistent.
- **Decision not carried:** the RFC drops or narrows a rule that a resolution states.
- **Code change needed:** the contract is coherent, but existing code must change to meet it.

RFC line numbers refer to the frozen file. Resolution files are cited by file name and line.

## Findings

Findings are in severity order.

### 1. Many required wire objects have no field names or value sets

- **Kind:** contract gap.
- **Where:** RFC lines 21, 98-100, 113, 116, 118, 128, 137, 139, 141, 151, 153-155. Also Open Question 1 at line 269.
- **What is wrong:**
  - Line 21 says the RFC renders the contract "into concrete wire fields". Line 269 says the concrete schema is ready for review.
  - The following objects are described only in prose, with no member names: `position` ("source key, native location unit, and location value"), relationship objects, part text and tool fields, evidence entries (only `standing` is named), `sources` entries, `versions`, `consistency`, `activeBranch`, `incompleteTail`, `methods`, and `sourceFormats`.
  - No object is named as the carrier of `contentStatus`.
  - The `coverage` and `limits` entries have no stated shape: object keyed by guarantee, or array.
  - These value sets are not listed: location units, relationship kinds, target kinds, basis values, source kinds, and `method` identifiers.
  - "Conditional prerequisites" and the flag for whether history must be reread (line 100) have no field.
- **Impact:** two independent consumers cannot parse one stream the same way. One example: line 139 requires that a known root is distinct from missing evidence, but nothing on the wire carries that difference. An empty relationship list means "root" to one consumer and "unknown" to another. (Rung 2.)

### 2. Guarantee names have three spellings with no mapping

- **Kind:** contract gap.
- **Where:** RFC lines 57, 100, 117-118, 151, 201. `capability-refusal-resolution.md:9`, `:17`.
- **What is wrong:**
  - `--accept-limits` uses `history`, `branches`, `original-records`, and `embedded-content`.
  - `capabilities` uses `retainedHistory`, `retainedBranches`, `originalRecords`, and `embeddedContent`, plus four more entries.
  - `requested`, `acceptedLimits`, the "per-guarantee" `coverage`, the named `limits`, and `failure.guarantee` never state which spelling they carry.
  - The RFC does not say which of the eight capability entries have a `coverage` entry (for example `activeBranch` or `incremental`).
  - The resolution fixes only the four opt-in names.
- **Impact:** one consumer looks up `coverage.history` and another looks up `coverage.retainedHistory`. (Rung 2.)

### 3. Historical loss and per-limit detail have no place on the wire

- **Kind:** decision not carried.
- **Where:** RFC lines 43, 72-74, 118, 151, 199, 214. `capability-refusal-resolution.md:19`, `:21`.
- **What is wrong:**
  - The resolution requires HCN to "report any established historical loss separately from whether all currently retained records were read" (line 21). RFC line 74 keeps the obligation but defines no separate field.
  - The coverage values `complete`, `limited`, `unknown`, and `not-applicable` cannot express "every retained record was read, but the harness lost history earlier".
  - The only other channel is `limits`. RFC line 43 defines a limit as a reduction that the caller permits. RFC line 214 fails an unaccepted limit with exit 1.
  - The resolution also requires each accepted reduction to state "what was requested, what was available, and what was returned" (line 19). RFC line 151 carries only names, reasons, and accepted status.
- **Impact:** the research documents in Codex source that some transient events are never persisted.
  - Implementer A reports `history: limited`, and a default read of a fully retained source fails with exit 1.
  - Implementer B reports `complete` with a prose reason, and consumers cannot detect the loss without parsing prose.
  - Both readings fit the RFC. (Rung 2.)

### 4. The skill handoff drops the confirmed update of verification scripts

- **Kind:** decision not carried.
- **Where:** RFC line 263. `conversation-identity-records-resolution.md:43`.
- **What is wrong:**
  - The human-confirmed resolution requires updating the HCN usage skill "in `~/dev/skills/skills/vendor/hcn/`, its references, examples, and verification scripts".
  - The RFC requires an audit or update of the skill and a run of the existing `check-claims.sh` and `check-claims.test.sh`.
  - The RFC does not require updating those scripts, so they need not cover the transcript commands, fields, or issue codes.
- **Impact:** the user requires the implementation to update and verify the skill. Transcript claims in the skill could pass scripts that never check them. Whether the current scripts would miss them is unproven, because the scripts were not read. (Rung 2 for the dropped requirement.)

### 5. `consistency: unknown` on a complete result contradicts the state machine, and the check for a first read is undefined

- **Kind:** contract gap.
- **Where:** RFC lines 45, 155, 165, 180-182, 195. `incremental-reads-resolution.md:23`. `capability-refusal-resolution.md:23`.
- **What is wrong:**
  - A verified batch requires source consistency (line 45).
  - The state machine moves Verify to Failed when consistency is "not established" (line 180).
  - The resolutions say each call "must establish its own consistent boundary" and forbid a "successful inconsistent batch".
  - Yet `consistency.method` includes `unknown` (line 155), and nothing forbids it on `complete`.
  - `validated-prefix` is defined only for bookmark continuation (line 165). The RFC does not define the check a file reader runs on a first read with no bookmark.
- **Impact:**
  - Implementer A returns `complete` with `consistency.method: "unknown"` for a single-pass file read.
  - Implementer B fails every first read that lacks a defined check. (Rung 2.)

### 6. The RFC does not mark which value sets are closed or say how consumers handle unknown values

- **Kind:** decision not carried, plus a contract gap.
- **Where:** RFC lines 94, 203-216, 234. `capability-refusal-resolution.md:17`, `:29`. `AGENTS.md` ("closed unions on purpose").
- **What is wrong:**
  - The resolution calls the transcript issue codes and the opt-in names "closed". The RFC drops that word for both.
  - Line 234 treats "closed normalized kinds" as compatibility-sensitive but does not list which sets are closed. The candidates are `status`, coverage values, `standing`, `originalKind`, normalized kind and role, part kinds, and consistency methods.
  - The RFC does not say whether adding a value is compatible within schema 1, or what a consumer does with an unknown value. Line 94 covers unknown envelope fields only.
  - "Unknown schema major version" has no defined meaning, because `schemaVersion` is the integer `1`.
- **Impact:** a consumer that follows the AGENTS.md rule and has no default branch fails on a new code. A lenient consumer keeps working. (Rung 2.)

### 7. The Claude enablement gate omits checks the fixed guarantees need

- **Kind:** contract gap in the implementation guidance.
- **Where:** RFC line 251, compared with lines 76, 210, 211, 218. `capability-refusal-resolution.md:13`, `:31`.
- **What is wrong:**
  - The gate allows "explicitly report the accepted limits of the selected method" for the SDK view.
  - The Claude/Codex research records a synthetic probe of SDK 0.3.233. Missing and invalid session IDs each returned an empty list, and a malformed line was skipped silently.
  - The RFC's fixed guarantees say opt-ins cannot relax integrity (line 76), a missing source is "never an empty successful read" (line 210), and a malformed middle record must fail (lines 211, 218).
  - The SDK method with accepted limits therefore conforms only if HCN detects those cases on its own. The gate row does not say so.
  - The resolution adds that a current-context API is not selected when a fuller passive read exists.
- **Impact:** an implementer who follows the table row can enable a reader that returns exit 0 and zero records for a wrong ID. This impact is unproven here, because the probe was not rerun. (Rung 2, based on the research's recorded probe result.)

### 8. The RFC drops the rule for large stored tool results, which leaves included files and external references overlapping

- **Kind:** decision not carried.
- **Where:** RFC lines 27, 66, 70, 141. `conversation-identity-records-resolution.md:19`, `:21`.
- **What is wrong:**
  - The resolution states: "Large stored tool results are covered by the same complete-data requirement; silent truncation is not preservation."
  - The RFC keeps only a batch rule for large entries (line 66). It then pairs "include all files that the native format identifies as parts of the conversation" (line 70) with "MUST NOT open" external file references (line 141).
  - The research lists externally stored tool results as unverified for Claude and Codex.
  - No RFC rule says whether a harness-owned file that holds one entry's tool result is a part of the conversation or an external reference.
- **Impact:** one reader includes the file. Another marks the result `not-included` and then fails a default read with `guarantee-unmet`. (Rung 2.)

### 9. Resolve-stage outcomes have no assigned code, and the limited-read hint only applies to refusals

- **Kind:** contract gap, plus a decision not carried.
- **Where:** RFC lines 80-81, 174-177, 206-207, 214, 218. `capability-refusal-resolution.md:11`, `:17`, `:27`.
- **What is wrong:**
  - The resolution puts exit 1 "after the read operation starts". The state machine allows Resolve to go only to Failed, so the consistent reading is exit 1 at Resolve.
  - No issue code covers a source-specific compatibility result that is unknown at Resolve. `transcript-unverified` is preflight-only. `guarantee-unmet` says "during reading".
  - The resolution also says "refuse any guarantee that depends on it" for unknown compatibility. "Refuse" suggests exit 2.
  - The resolution requires a hint that names "any verified limited read and the required opt-in" for any read that cannot establish a guarantee (line 17). RFC line 218 requires named limits only in "refusal metadata".
- **Impact:** for a source-specific shortfall found at Resolve, implementers can differ on exit code, issue code, and whether the opt-in hint is present. (Rung 2.)

### 10. `activeBranch` has no qualifier for what the source can observe

- **Kind:** decision not carried.
- **Where:** RFC lines 139, 154, 159. `incremental-reads-resolution.md:37`, `:50`.
- **What is wrong:**
  - The resolution says "the selected state must be qualified by what the read source can establish; do not claim a stronger live snapshot than the source provides".
  - RFC line 154 offers only "known native selection/reference with evidence, or an explicit unknown state". It has no field that separates live selection from selection derived from saved data.
  - Pi 0.84.2 rebuilds the leaf from the last non-header entry when it loads a file (Pi/Muse research). That is a native-format rule, which line 139 accepts as a basis.
  - Line 159 says a read "reports a selection change". The resolution's example returns "the available selected-branch information", and HCN keeps no earlier state to compare against.
- **Impact:** for a Pi file read, one implementer reports the reload leaf and another reports unknown. Consumers cannot tell whether `activeBranch` is a current value or a delta. (Rung 2.)

### 11. Inputs for `--id` resolution are unspecified, and existing store lookup is fixed to HOME and cwd

- **Kind:** contract gap. Meeting any chosen rule also needs a code change.
- **Where:** RFC lines 27, 55-60, 64. `conversation-identity-records-resolution.md:9`.
- **What is wrong:**
  - The RFC and the resolution offer only `--id` or `--file`. Neither says whether ID resolution uses the caller's cwd, searches every project store, or accepts a store root.
  - Line 64 rejects native-passthrough arguments and does not address a store-root override.
- **Existing behavior (rung 3, traced):**
  - `src/cli/session.ts:167-172` passes `process.env.HOME` and `cwd ?? process.cwd()` to `resumeStore` (`src/cli/resume-guard.ts:18-35`).
  - `resumeStore` calls `storePath` (`src/interpretation/store.ts:37-43`).
  - The Claude template is `{home}/.claude/projects/{cwdSlug}/{sessionId}.jsonl` (`src/knowledge/claude-code.ts:131`). The Pi template is `{home}/.pi/sessions/{cwdSlug}` (`src/knowledge/pi.ts:114`).
  - A grep of `src/` found no `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `PI_CODING_AGENT_DIR` handling (rung 2).
- **Impact:** the same `--id` read run from another directory can give `source-not-found` in one implementation and success in another. (Rung 2 for the gap.)

### 12. Positions and source keys have no stated stability across calls, and parent-conversation targets have no shape

- **Kind:** contract gap.
- **Where:** RFC lines 113, 127-128, 139, 167, 191. `conversation-identity-records-resolution.md:25`.
- **What is wrong:**
  - Records can repeat after a retry (line 191), and `nativeId` can be null (line 127).
  - The resolution and line 167 say incompatible changes invalidate positions. They imply stability across compatible appends but never require it.
  - Source keys are "local" (line 113), with no stated scope.
  - A relationship target in a parent conversation "MUST retain" its scope (line 139). That conversation is not in `sources` (line 70), so a local source key cannot name it.
- **Impact:** a consumer that deduplicates records with no native ID cannot rely on `position`. (Rung 2.)

### 13. Accepting a limit for an `unknown` capability is not stated in the RFC

- **Kind:** decision not carried.
- **Where:** RFC lines 44, 72, 206-207. `capability-refusal-resolution.md:19`.
- **What is wrong:**
  - The resolution says "permission to accept a limit is not proof that a gap exists. Unknown coverage remains unknown." Under that rule, an accepted guarantee with unknown support proceeds and reports `unknown`.
  - The RFC does not carry this sentence. `transcript-unverified` has no acceptance clause, while `transcript-divergence` has one.
- **Impact:** for `--accept-limits embedded-content` against an `unknown` capability, one implementer refuses with exit 2 and another reads with exit 0. (Rung 2.)

### 14. Interruption has no state or code, and temporary material is removed only on success

- **Kind:** contract gap.
- **Where:** RFC lines 171-187, 191, 203-216, 226, 228.
- **What is wrong:**
  - Line 191 describes behavior after interruption. The state machine has no interruption transition, and the issue table has no code for it.
  - Line 187 closes resources on "completion, failure, or interruption". Line 226 removes temporary material only "on normal completion".
- **Impact:** a signal during Read has no defined issue code. Private temporary copies can survive a failure. Whether an implementation would keep such copies is unproven. (Rung 2.)

### 15. The existing EPIPE handler exits 0

- **Kind:** code change needed. This is not a contradiction in the contract.
- **Where:** RFC lines 86, 216, 232. `src/cli/index.ts:12-20`. `scripts/build.ts:28-35`.
- **Existing behavior (rung 3, traced):**
  - The bin wrapper imports `./cli/index.js` and calls `run()`.
  - Loading that module registers stdout and stderr error handlers that call `process.exit(0)` on EPIPE for every command.
- **What is wrong:** RFC line 86 requires a nonzero exit when output breaks. Line 232 forbids changing existing command behavior, so the transcript command needs a handler scoped to itself. The RFC does not mention this.
- **Impact:** the exit status at runtime was not observed, so the impact is unproven. (Rung 3 for the handler path.)

### 16. RFC test lists are a subset of the normative conformance checklist

- **Kind:** decision not carried in the body. This is not a contradiction, because line 284 cites the checklist as normative.
- **Where:** RFC lines 255, 257. `custom-harness-resolution.md:31-38`.
- **What is wrong:** the RFC body omits these checklist cases:
  - passive lifecycle: old-format migration, empty files, hooks, extensions, accidental prompt or resume paths
  - identity: wrong-source bookmarks, ambiguity, child or forked separation
  - incremental: missing anchors, reused native IDs, concurrent appends
  - read consistency: malformed middle records, persistent incomplete tails
  - reports and exits: native reader failures, output failures, unfamiliar compatible versions
  - original data: no truncation of large entries, external references not opened
- **Impact:** an implementer who works from the RFC body alone can skip the passive-lifecycle and malformed-record tests. (Rung 2.)

### 17. No equality rule defines value preservation

- **Kind:** contract gap.
- **Where:** RFC lines 39, 94, 255. `custom-harness-resolution.md:33`.
- **What is wrong:** "Retain their values, including numeric precision" does not settle three cases: whether `1.0`, `1`, `1e0`, and `-0` are equal; duplicate keys in a native object; and lone-surrogate escapes. The conformance case "JSON value preservation, including large numeric values" needs a comparison rule.
- **Impact:** one implementation writes `1.0` as `1`, and a test that compares the literal text fails it. (Rung 2.)

### 18. The departure from ADR 0002 and the existing `issue` field is not recorded

- **Kind:** contract gap.
- **Where:** RFC lines 201, 281. `docs/adr/0002-structured-refusal-with-hint.md:3`. `src/execution/failure.ts:44-63`. `src/interpretation/refusal.ts:11-25`. `capability-refusal-resolution.md:33`.
- **What is wrong:**
  - ADR 0002 says every rejected summary carries `supportedBy` and `hint`. The RFC cites ADR 0002 as normative but has no `supportedBy`, and its `hint` is nullable.
  - The resolution gives the reason: no other harness can read this native conversation. The RFC does not record that reason.
  - The existing `FailureSummary.issue` is typed `RefusalIssue`, and failures use `class`. The RFC's `failure.issue` mixes exit-2 and exit-1 codes and has no `class`.
  - The RFC does not say whether the new codes extend `REFUSAL_ISSUES` or form a separate vocabulary.
- **Impact:** a consumer of both HCN surfaces reads a field named `issue` with two different scopes. (Rung 2.)

### 19. The output of a refused inspection is undefined

- **Kind:** contract gap.
- **Where:** RFC lines 62, 98. `src/cli/inspect.ts:25-29`, `:60-68`. `src/cli/index.ts:93-99`.
- **What is wrong:**
  - Line 62 says inspection "prints one JSON object" and that `--transcript` excludes other modes. It does not define refusal output for `inspect --transcript`.
  - Existing inspection refusals (`--capabilities --argv`, bad `--mode`, unknown harness) write prose to stderr and exit 2.
  - The resolution defines structured early refusals for the read command only.
- **Impact:** a machine consumer of the capability document has no structured refusal to branch on. (Rung 2.)

### 20. The RFC does not say whether content-derived bookmark fingerprints count as transcript content

- **Kind:** contract gap.
- **Where:** RFC lines 163, 165, 228.
- **What is wrong:**
  - File methods validate against "caller-held fingerprints" (line 165). Line 163 forbids embedding transcript content and forbids secret signing state, which rules out keyed hashes.
  - The RFC does not say whether an unkeyed hash of each record is embedded content.
- **Impact:** implementers can disagree on what a bookmark may carry (rung 2). A holder could use such a hash to confirm a guessed short record. That privacy impact is unproven (rung 1).

### 21. Customized-harness rules omit build identifiers and vendor builds of other harnesses

- **Kind:** decision not carried. Low severity.
- **Where:** RFC lines 100, 238. `custom-harness-resolution.md:11`, `:15`, `:29`.
- **What is wrong:**
  - The resolution lists "build identifiers" among the facts an integration describes. It requires an identified build when a native program is involved, and applies the same rule to "wrappers and vendor builds of other harnesses".
  - RFC evidence entries carry only "applicable versions/formats", and line 238 speaks only of Pi.
- **Impact:** a capability document cannot show which native build a method's evidence covers. (Rung 2.)

### 22. An informative reference uses local absolute paths

- **Kind:** contract gap. Low severity.
- **Where:** RFC line 292.
- **What is wrong:** `/Users/kevin/dev/trevor/...` paths in a source-public repository cannot be opened by any other reader. (Rung 2.)

## Cleared

Each item below was checked at rung 2 against the cited lines.

- **Structure:** the validator passed, with no errors or warnings.
- **Record and command decisions carried:** `hcn transcript read` with `--id` or `--file`; stdout JSONL as the export; one record per native entry with parts kept together; complete native objects without whitespace identity; embedded attachments included; external references not opened; native IDs kept separate from scoped positions; saved order kept; relationships only from native data. Compare RFC lines 55-60, 64, 133-141 with `conversation-identity-records-resolution.md:9-37`.
- **Incremental decisions carried:** caller-held bookmark with no HCN state; `fresh-read-required` with no automatic restart; entry-count batches with `more`; each call has its own boundary; bookmark only on success; repeats after interruption; unfinished-tail rule that does not allow skipping middle records; appended compaction treated as new data. Compare RFC lines 66, 156, 163-167, 189-195 with `incremental-reads-resolution.md:9-39`.
- **Capability decisions carried:** `inspect --transcript`; eight independent capabilities with statuses and standing; separate version facts; the four closed opt-in names with no `all`; opt-ins cannot waive fixed guarantees; 0/1/2 exit split; the issue-code list; malformed middle record fails even when limits are accepted; no global retry policy; passive-read requirement. Compare RFC lines 54-86, 98-102, 199-218, 224-226 with `capability-refusal-resolution.md:7-37`.
- **Customized-harness cases:** all three cases are present at RFC line 238, and Muse stays disabled without versioned evidence (line 253). Compare `custom-harness-resolution.md:7-9`, `:42`.
- **Scope:** consumer indexing, retention, search, watching, and presentation stay outside HCN (RFC lines 15, 27, 191, 265), and there is no `retryable` boolean (line 201). This is consistent with ADR 0007 and CONTEXT.md.
- **Claimed consistency scope:** the RFC does not assume atomic native snapshots (lines 189, 195, 226). Finding 5 is the remaining gap.
- **Framing:** one `source`, zero or more `record`, one `result`; empty reads keep both envelopes; failed and refused results carry a null bookmark. Lines 86, 92, 149, 156, and 193 agree.
- **No event-kind reuse:** `source`, `record`, and `result` are absent from `HarnessEvent` kinds (`src/execution/events.ts:44-69`), which matches line 232.
- **Existing codes and exit values:** `invalid-option-value` and `mutually-exclusive-options` exist (`src/interpretation/refusal.ts:15`, `:21`). Exit values match `src/cli/exit-codes.ts:3-5`.
- **Version pins:** the Implementation Notes pins match the descriptors (`claude-code.ts:24`, `codex.ts:13`, `pi.ts:15`, `muse.ts:16`).
- **Evidence table facts:** RFC lines 248-253 match both research summaries. Finding 7 concerns the gate wording, not the facts.
- **Layering:** RFC line 244 is consistent with the AGENTS.md purity, chat-seam, and dual-runtime invariants. RFC line 236 does not bump `verifiedAgainst` for the feature.

## Not reviewed

- **Published GitHub comments:** the comments cited in RFC lines 281-284 were not compared with the local resolution files. The local files were used.
- **Pinned third-party source clones:** Pi v0.84.2 and Codex 0.147.0 were not read. The research summaries were accepted as given, and the Claude probe was not rerun.
- **Skill scripts:** `check-claims.sh` and `check-claims.test.sh` were not read.
- **Trevor files:** the research and planning map in RFC line 292 are outside the brief.
- **Runtime:** no harness, model, probe, or HCN command ran. No private transcript, native store, credential, `.env`, or fixture was read.
- **Graph checks:** codebase-memory has no indexed project for this worktree, so no graph or coverage checks ran. Cited HCN source was read directly or searched with grep. No exhaustive code claim is made.
- **Rendering:** the Mermaid diagram was not rendered.
