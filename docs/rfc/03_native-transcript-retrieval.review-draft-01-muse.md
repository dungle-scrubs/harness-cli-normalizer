# RFC-03 Review: Native transcript retrieval

## What was reviewed

Assumption: the requested reviewer "Muse at xhigh" means an independent document-only review at extra effort, performed here as Muse Code powered by Meta Muse Spark.

- Document: `/private/tmp/hcn-transcript-contract-20260911/docs/rfc/03_native-transcript-retrieval.rfc.md`, lines 1-292, read in full.
- Frozen identity supplied by the driving session: RFC-03 Native transcript retrieval; draft-01; status Draft; commit d5dd1ccbacb16fa6490552c2b524151a7fd8a4ee; SHA-256 4b4bc3bb165602bd45cbaa3ca53aedd148d1c142a8028b72d63b3d3b6ab1c515.
- Hash and commit were supplied, not independently verified by this review.
- Reviewer: Muse at xhigh, implemented as Muse Code powered by Meta Muse Spark.
- Scope: document coherence only. No code exists in this task. No runtime, codebase, transcript, secret, or environment check was performed.
- All findings below are document-only unless marked otherwise.

## Structural results

The driving session ran the deterministic structural check before this review. Output is quoted verbatim. This review did not run it.

Command reported by the driving session:

`npx tsx /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts /private/tmp/hcn-transcript-contract-20260911/docs/rfc/03_native-transcript-retrieval.rfc.md`

Verbatim output:

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Structural check passed with no errors or warnings.

## Findings

### F1: Capability document has no wire shape

Section: Capability document, lines 96-102.

Problem: the RFC lists capability keys and evidence concepts but defines no field names, types, or object shapes for `sourceFormats`, `methods`, per-capability entries, evidence entries, incremental reread behavior, or record-identity detail. Conditional prerequisites "MUST be explicit" but the RFC names no field to carry them.

Impact: two consumers cannot emit or parse `transcript-capabilities` consistently. Method identity, passive-lifecycle evidence, and per-harness limits will diverge.

Evidence: rung 2, document citation only, unproven at runtime.

### F2: Guarantee names differ across CLI, capabilities, source, and result

Sections: CLI lines 53-58; Selection lines 72-76; Capability lines 100-101; Source envelope lines 117-118; Final result line 151.

Problem: CLI tokens are `history,branches,original-records,embedded-content`. Capability keys are `retainedHistory,retainedBranches,activeBranch,originalRecords,embeddedContent,incremental,paging,recordIdentity`. Coverage uses unnamed "per-guarantee" keys. The RFC defines no mapping between these three vocabularies. It also leaves the scope of `branches` undefined. A caller that accepts `branches` may mean retained branches, unknown active branch, or both.

Impact: an accepted limit means different things to different readers. Coverage reports cannot be compared. Interop fails on the main control for reduced coverage.

Evidence: rung 2, document citation only, unproven at runtime.

### F3: Source envelope object shapes are undefined

Section: Source envelope, lines 104-120.

Problem: `sources`, `nativeHeaders`, `versions`, `requested`, `acceptedLimits`, and `coverage` lack wire keys and types. Examples: `sources` needs local key, source kind, identity or location, and format version, but the RFC gives no property names. `nativeHeaders` says "attached to its source key" but does not say map versus array. `versions` lists three version facts with no property names. `coverage` needs per-guarantee state, reason, and evidence with no schema.

Impact: source identification, multi-file conversation assembly, header preservation, and provisional coverage cannot be implemented twice with the same bytes.

Evidence: rung 2, document citation only, unproven at runtime.

### F4: Record position has no usable encoding, including for unlocatable methods

Sections: Common framing line 94; Source envelope lines 106 and 113; Transcript record lines 122-133.

Problem: `position` requires source key, location unit, and location value. The RFC defines no property names and no closed or open set of location units. Numeric positions are decimal strings, but timestamp-like, offset-like, and cursor-like units have no form. Line 106 says null is allowed only where specified, and `position` is not marked nullable. A method "unable to locate records" therefore has no valid wire value. It must either invent identity, which line 128 forbids, or violate the required-field rule.

Impact: record identity and incremental continuation diverge. Methods without stable positions cannot conform.

Evidence: rung 2, document citation only, unproven at runtime.

### F5: Normalized content fields lack wire names and types

Section: Transcript record, lines 135-141.

Problem: `normalized` lists `kind`, `role`, `timestamp`, `parts`, and `relationships`. Nullability uses two sentinels without a per-field rule: null versus the string `unknown`. Part kinds are listed, but normalized text, tool-call ID, and tool-name fields have no property names because line 137 uses SHOULD without naming them. `timestamp` has no wire type. `contentStatus: "not-included"` has no stated home on part versus record. Relationships require kind, target kind, target, basis, and scope, but the RFC gives no relationship-kind vocabulary, no property names, and no scope encoding. The distinction between missing evidence and known root has no encoding.

Impact: consumers can read `original` but cannot use `normalized` consistently. Search, index, and tool-call linking will differ.

Evidence: rung 2, document citation only, unproven at runtime.

### F6: Final result shapes and refused-result values are undefined

Sections: Final result lines 143-159; State Machine lines 189-195.

Problem: `coverage`, `limits`, `incompleteTail`, `activeBranch`, `consistency`, and `bookmark` lack schemas. `limits` needs actual limits plus accepted or unaccepted status with no object form. `activeBranch` needs selection or reference plus evidence with no form. `consistency` needs boundary and source facts plus limits with no form. `incompleteTail` needs position plus reason with no form. Refused results still emit the result envelope, but the RFC does not state values for `recordsReturned`, `more`, `consistency`, `activeBranch`, or `coverage` on refusal. Line 193 allows a successful result to "retain the previous progress boundary" while line 84 speaks of an "advancing bookmark", but the wire gives no way to tell retained from advanced.

Impact: retry, tail handling, branch-change detection, and bookmark advance cannot be implemented consistently.

Evidence: rung 2, document citation only, unproven at runtime.

### F7: Bookmark transport and cross-method compatibility are undefined

Sections: CLI lines 53-58; Final result line 156; Bookmarks lines 161-167.

Problem: `bookmark` has no wire type. `--since <bookmark>` therefore has no defined CLI encoding for a string, JSON object, or file reference. Size limits, shell escaping, and redaction handling are absent. Line 163 allows a token to "contain or reference" evidence while forbidding HCN-owned registries, but it does not state that all evidence travels inside the caller-held token. Cross-method or cross-format continuation needs an "explicit compatibility rule" with no stated carrier. Consumers cannot predict or test when a bookmark survives a method change.

Impact: incremental reads work only within one implementation. Bookmarks are not portable.

Evidence: rung 2, document citation only, unproven at runtime.

### F8: Numeric-precision rule has no JSON mechanism

Section: Common framing, lines 92-94.

Problem: the RFC requires preserved JSON values including numeric precision and calls a lossy JavaScript number conversion non-compliant. JSON text itself carries no integer-precision guarantee in common parsers. The RFC prescribes no mechanism such as raw-text retention, string-encoded integers, or a bignum path.

Impact: large native integers may change value between HCN output and consumer parse even when HCN emits correct JSON. The MUST cannot be tested on the wire as written.

Evidence: the missing mechanism is rung 2 from the document. Any claim about actual loss in a specific runtime is rung 1, unproven in this task.

### F9: Error precedence is undefined for overlapping failures

Section: Error Handling, lines 199-218.

Problem: several issues overlap. `transcript-unverified` versus `passive-read-unverified` can both apply when lifecycle and other guarantee evidence are unknown. `source-changed` during a call versus `fresh-read-required` between calls can both describe a rewrite. `transcript-divergence` before reading versus `guarantee-unmet` during reading can both describe an unaccepted limit found at different times. The RFC gives temporal hints but no precedence rule when more than one applies.

Impact: the same event can yield different `issue` values and different exits 1 versus 2 across implementations. Consumers cannot route on `issue` reliably.

Evidence: rung 2, document citation only, unproven at runtime.

### F10: Key terms drift across sections

Sections: Terminology lines 33-45; Read sequence lines 80-84; Bookmarks lines 161-167; State Machine line 193; Versioning line 234.

Problem: the RFC uses `bookmark`, bare `token`, and `position token` for the same caller-held object. It uses `advancing bookmark` and "retain the previous progress boundary" without defining whether retention emits an equal token, a new token, or null. It says consumers "may ignore unknown native fields while preserving them", which combines two actions without stating who preserves what on re-emit.

Impact: implementers will read different normative scope from different sections. Tests may assert token equality, token renewal, or null for the same tail case.

Evidence: rung 2, document citation only, unproven at runtime.

### F11: Version-compatibility and custom-Pi gates have no wire test

Sections: Read sequence lines 80-82; Versioning lines 232-238; Implementation Notes lines 246-258.

Problem: an unfamiliar writer or reader version alone is "insufficient for refusal when compatibility can still be established", but the RFC defines no compatibility rule, rule identifier, or capability field to record the decision. Customized Pi qualifies through preserved semantics and tested passive behavior, but the capability document has no conformance marker for stock versus compatible-custom behavior. Copying a stock version string is called insufficient, yet no separate evidence field is wired.

Impact: enablement stays subjective. Two readers can accept and reject the same custom build while both claim conformance.

Evidence: rung 2, document citation only, unproven at runtime.

### F12: Export-process mapping and failure-path cleanup are uncovered

Sections: Capability document line 98; Transcript record line 129; State Machine line 187; Error Handling line 216; Security lines 226-228.

Problem: methods include files, native API, or native export process, but `originalKind` allows only `saved-record` or `api-record`. An export-process record has no defined kind. Temporary material "MUST" be removed "on normal completion", with no rule for failure or interruption. `output-failed` permits a failure result "only if still possible", but the RFC does not state whether partial records before that failure stay valid for a failed batch beyond the `recordsReturned` count.

Impact: export-based readers cannot label records correctly. Failed runs may leave temp state or leave consumers unsure whether partial records are usable.

Evidence: rung 2, document citation only, unproven at runtime.

No direct MUST versus MUST-NOT contradiction was found. The gaps above are under-specification and naming drift, not conflicting normative orders.

## Cleared

The following focus concerns were checked against the text and found internally consistent. All are rung 2, document-only, unproven at runtime.

- Retained history stays distinct from current context. Definitions at lines 36-37 separate them. The Claude SDK view must report limits rather than pose as complete originals at lines 133 and 251. Compaction appears as data, including a `compaction` entry kind and a rule for appended compaction records at lines 135 and 189.
- Passivity survives coverage opt-ins. Lines 76, 208, 218, and 224-225 state that opt-ins cannot waive passive reads, integrity, value preservation, or bookmark validity. Unsafe current-context APIs stay ineligible even with accepted limits.
- Scope exclusions hold. No listing operation, HCN-owned store, index, search, watcher, retry, acknowledgement, human-readable export, automatic attachment read, automatic child or fork read, deleted-data recovery, new-harness registration, or Trevor ownership change is specified. Child and forked conversations stay references at lines 25-27 and 70.
- Multi-file and segmented sources are addressed in principle. Line 70 forbids treating one readable file as complete. Codex segments and Pi leaves are named as reasons at lines 70 and 250-253.
- Batch framing is coherent in principle. Exactly one source, zero or more records, and one terminal result are stated at lines 86 and 92. Empty success still emits source plus result. Provisional records belong to failed batches at lines 150, 195, and 218. The unfinished-tail exception is narrow: it excludes only the final unfinished record, stops the bookmark before it, forbids skipping corrupt middle records, and promises no writer completion at lines 193-195.
- Exit and issue structure is coherent in principle. The 0, 1, 2 split, terminal `failure` object, and no-prose-parsing rule at lines 199-202 give consumers a stable routing base, subject to finding F9 on precedence.
- Security posture is consistent with passivity and privacy. No model request, no history write, no instruction or extension load, no external dereference, validated paths and bookmarks, no extra logging of bodies or tokens, and synthetic-only verification appear at lines 222-228.
- No parity is claimed. Uneven per-harness evidence, unknown or unavailable support, per-capability evidence, and per-method attribution appear at lines 25, 100-102, 236, and 246-254. A separate SDK-based harness stays a separate future integration at line 238.
- Compatible customized Pi and future harnesses are accommodated in principle, subject to finding F11. Extension records can remain unknown without being dropped, changed formats need new evidence, and no runtime registration interface is created at line 238.
- HCN usage-skill update duty is explicit. Line 263 requires the audit and update plus `check-claims` runs. Trevor ownership stays unresolved at lines 267-272.

## Not reviewed

- Repository context and cited sources were not opened: CONTEXT.md, AGENTS.md, ADRs 0002 and 0007, GitHub issues and comments, research documents, planning map, and Trevor local paths.
- Validator source, harness code, native session stores, actual transcripts, credentials, secrets, fixtures, and environment values were not opened, per task limits.
- Runtime truth of the version table was not checked: Pi 0.84.2, Claude 2.1.233, SDK 0.3.233, Codex 0.147.0, and Muse 0.1.0 behavior remain implementation gates, not review evidence.
- No execution trace, test, script, or running-product observation supports this review. No finding rises above rung 2 except where F8 marks a runtime-loss prediction as rung 1.
- Conformance tests, ticket slicing, dual-runtime checks, skill updates, and publication steps are future work and were not verified.
