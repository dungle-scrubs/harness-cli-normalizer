# RFC-03 draft-02 document review

Reviewer: muse-spark-1.3-contributor@muse, effort xhigh.

Reviewed version: RFC-03, revision draft-02, status Draft. Frozen identity supplied by the driving session: commit c1a365321bcc01f4050f8df2a74ce6e291aafcb2, SHA-256 4a101f9d4102b172beb3ec1a75568a9b3bbd3495dcccc77b0eca90c470bc0724. Frontmatter in the file read shows number 03, title Native transcript retrieval, status Draft, revision draft-02, date 2026-09-11. Commit and hash were not independently verified.

## What was reviewed

The complete file at `/private/tmp/hcn-transcript-contract-20260911/docs/rfc/03_native-transcript-retrieval.rfc.md`, lines 1-527, read in full. Scope was the wire contract only: CLI and source selection, coverage and history, schema tables, source and record and result envelopes, positions and references, bookmarks and validation, state machine, errors and precedence, security, versioning, implementation notes, conformance checklist, synthetic outcomes, JSON examples, draft-01 dispositions, open questions, and references as cited text.

Assumption: the frozen identity and validator output below are taken as driving-session inputs without independent verification.

Core question answer: independent consumers can interpret most of the contract consistently, with four document-only gaps below. No material contradiction blocks consistent parsing of nullable positions, coverage versus historical loss, limits, fixed boundaries, bookmarks, branch observations, or error precedence. Two gaps affect result interpretation after failures. None of the findings is proven at runtime.

## Structural results

Driving-session validator output, attributed to the driving session and not run in this review:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Structural checks observed in the document: RFC 2119 keywords declared. Schema conventions define required fields, nullability, arrays, maps, counts, enums, and opaque identifiers. Shared vocabulary tables define Build, Applicability, Evidence, Capability, Assessment, Limit, HistoricalLoss, LossDetail, and Rule. Capability and coverage maps have fixed keys and canonical order. Method, SourceFormat, BookmarkCompatibility, source, record, position, normalized, part, relation, reference, result, boundary, check, continuation, failure, and hint shapes have normative tables. Closed enums are stated as closed in schema version 1. Opaque method, format, and rule IDs have syntax and uniqueness rules.

Explicit skill-verification updates are present. The implementation must update SKILL.md, references, examples, and verification scripts, then run `check-claims.sh` and `check-claims.test.sh` against the updated binary. Conformance gates are present. Method-specific checklists, synthetic outcomes, and enablement rules condition each reader on isolated synthetic proof, with failure leaving the method disabled or explicitly limited or unknown.

## Findings

All findings are document-only, evidence rung 2 by citation to the RFC text, unproven at runtime. No tests or runtime outcomes were invented.

F1: Required checks that gate a complete result lack a marking. The result section requires verified compatibility, a known consistency method, passing required checks, and only accepted limited or unknown coverage. The Check object has ruleId, outcome, and description, with no required flag. The Consistency object has ruleIds, boundaries, checks, and assumptions, with no rule that maps a check to required versus informational. Location: Result envelope and observations, lines 231-236. Effect: two consumers can agree on check outcomes yet disagree on whether a complete result was permitted. Severity: moderate.

F2: Continuation input status on non-preflight unsuccessful results is undefined. Preflight refusal pins input to absent or not-checked based on whether a bookmark was supplied, plus malformed encoding as not-checked. Failed and refused results pin bookmark null and output unavailable. The value of input after Resolve, Read, or Verify failure with a supplied bookmark is not pinned. Location: lines 234-238. Effect: consumers cannot consistently tell whether the input bookmark was verified, invalid, or not checked when a mid-read failure occurs. This affects retry interpretation. Severity: moderate.

F3: Conversation Reference validity wording is ambiguous for location-only targets. The text states a conversation Reference has a nativeId equal to scope.conversationId or a non-null scope.location, with null position. It does not state whether null nativeId with non-null location satisfies the shape, nor the validity rule when both conversationId and location are present. Location: Record envelope and references, line 202. Effect: producers and validators can diverge on acceptance of location-only conversation targets. Severity: minor.

F4: Native-field relation basis permits an empty location. A format-rule basis requires ruleId. A native-field basis identifies its originalPaths, with no non-empty requirement. Unknown already has a defined empty encoding with unknown basis, empty paths, and null ruleId. Location: line 200. Effect: the same absence can be encoded two ways, and a native-field relation with empty paths carries no location while passing the field schema. Severity: minor.

These are specification gaps, not implementation defects. They differ from work the spec deliberately defers to implementation, such as per-harness synthetic proof, evidence collection, and verified method assumptions for snapshots and rewrites. Those deferred items have explicit gates and do not create consumer divergence by themselves.

## Cleared

The following core-question areas have explicit normative text in draft-02. Disposition claims for draft-01 points were not re-verified against the prior reports, which were not read. Clearance below rests only on the draft-02 text cited.

Nullable positions: record position is Position or null with sourceKey still required. Position units, zero-based byte and index rules, decimal string encoding, and opaque native cursors are defined. Boundary null-position meanings with zero versus positive counts are defined. Missing IDs and nullable positions route to record-identity capability without synthesized IDs. Lines 183, 192, 206, 208, 232.

Reference scope: JsonPath stays within the same original object. RelationshipMap has five fixed keys. Known, none, unknown, and not-applicable states have target, basis, path, and ruleId rules. Reference scope must identify the native conversation or source location under format rules. Stream sourceKey use versus external conversationId or location targets is distinguished. ReferencePosition is interpreted within its scope and can identify an external target without opening it. Lines 194-202.

Coverage versus historical loss: every read requests complete coverage for four fixed guarantees. Coverage describes the accessible retained view at the call boundary. Deleted or never-saved events report under historicalLoss, never as a retrieval reduction. Complete retained coverage can coexist with known-loss or unknown loss. None-established requires positive evidence. Lines 77-86, 118-122.

Limits: the four guarantee names apply across flags, capabilities, coverage, limits, and errors. Accept-limits permits limited or unknown only, never waives fixed guarantees. Limits list exactly the limited or unknown returned guarantees in name order. Accepted permission alone creates no Limit. Failed results retain observed assessments and use unknown for the remainder. Lines 88, 117, 122.

Fixed boundaries: initial and continuation reads capture a finite assembly and boundary, verify exact bytes and prefix consistency, and exclude later appends. Source envelope is provisional, and later discovery of an omitted unit fails the batch. Boundary counts and positions, more versus incompleteTail, and tail handling for verified complete prefixes are defined. Lines 174, 232-236, 252-254, 284.

Bookmarks: token alphabet, unpadded base64url form, JSON envelope with positive bookmarkVersion, 65536-byte bound, preflight invalid cases, unknown-version handling, opaque consumer treatment, no HCN cross-call state or signing service, digest preference, relocation only by caller-supplied location with verification, and cross-method compatibility rules are defined. Continuation advanced, same-boundary, and unavailable behavior, including EOF and empty-source bookmarks, is defined. Lines 244-254.

Branch observations: BranchObservation is an observed value with known, unknown, and not-applicable states and live, saved, and unknown views. Known requires selection and known view. Saved reload selection is not presented as live. Zero-entry reads still return the available observation. Consumers compare values. Lines 230, 240.

Error precedence: Validate, Resolve, Read, Verify, Cleanup, and Emit phases, issue codes with exits, input and capability check order, source versus bookmark check order, in-call change precedence, simultaneous-cause order, interruption and output-failure supersession, and cleanup-failure preservation are defined. Same-conversation hint behavior and the ADR 0002 exception are defined. Lines 292-333.

Consumer and ownership boundaries: consumers own indexing, retention, search, watch, presentation, retries, and acknowledgements. No listing operation, HCN store, model request, history write, attachment dereference, or Trevor ownership change is added. Lines 15, 25-27, 504-507.

## Not reviewed

No runtime verification was performed. No shell command, native harness, model call, fixture, private transcript, history store, credential, secret, or environment value was read or executed. The validator was not run and its source was not read. Draft-01 review reports were not read, so disposition sufficiency beyond the draft-02 text above is not judged. External references and URLs in the References section were not fetched. Commit and SHA-256 identity was not independently verified. Acceptance, implementation, release, and publication decisions are out of scope and no acceptance decision is made.
