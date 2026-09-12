# Review of RFC-03: Native transcript retrieval, draft-04

## What was reviewed

- **RFC:** `docs/rfc/03_native-transcript-retrieval.rfc.md`
- **Revision:** draft-04
- **Status:** Draft
- **Commit:** `1797f30e68cdb61b8ce6b1d392db1e7c1ee0c63c`
- **SHA-256:** `2bc4140e16ead5e90993f09bdfce0fc2e30d906d1cd5f7dc61b540ef16a1a007`
- **Reviewer:** Sol xhigh
- **Coverage:** Every RFC section was read. The review time limit interrupted further cross-checking after the findings below were established.

## Structural results

The driver supplied this validator output for the exact reviewed file:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F1 - High: The four retrieval guarantees have no defined `Capability.status` semantics

**Location:** Message Formats, “Shared vocabulary” and “Meanings of non-coverage capabilities,” lines 108, 115-139; Protocol Overview, “Coverage, history, and files,” lines 77-88.

**Problem:** `CapabilityMap` contains all eight capability keys, including `history`, `branches`, `original-records`, and `embedded-content`. Each value is a `Capability` whose status can be `available`, `limited`, `unavailable`, or `unknown`. The RFC defines what “complete” means for each retrieval guarantee and separately defines the four states of `Assessment`. It only defines the status meanings for the four non-coverage capabilities. It never specifies what the four `Capability.status` values mean for a retrieval guarantee or how they map to `Assessment.state`.

**Consequence:** Independent implementations can emit different capability documents for the same evidence. Consumers cannot reliably use inspection results to decide whether a read requires an opt-in, is impossible, or merely lacks evidence. The ambiguity also reaches method selection, source and result capability maps, and the preflight `transcript-divergence` versus `transcript-unverified` decision.

**Evidence:** Rung 2, document citation. This is a schema-level omission identified from the normative tables. It is unproven at runtime.

### F2 - Medium: `Method.passivity` reuses `Capability` without defining its valid states

**Location:** Message Formats, lines 115, 155, 158-160; Error Handling, lines 338 and 354; Security Considerations, lines 364-366.

**Problem:** Each `Method` has `passivity: Capability`, so the schema permits `available`, `limited`, `unavailable`, and `unknown`. The status table expressly covers only `active-branch`, `incremental`, `paging`, and `record-identity`. The RFC says passivity cannot be waived and says when it is available, but it does not define the meaning of limited passivity, prohibit that state, or map unavailable and unknown passivity to exact inspection behavior.

**Consequence:** A descriptor can be schema-valid while reporting an uninterpretable passivity state. Producers can disagree about whether `limited` is invalid, equivalent to unavailable, or equivalent to unknown. That affects method eligibility and the required preflight failure.

**Evidence:** Rung 2, document citation. This is a normative type and state-machine inconsistency. It is unproven at runtime.

### F3 - Medium: Relationship names do not constrain the kinds of their targets

**Location:** Message Formats, “Record envelope and references,” lines 210-227.

**Problem:** `RelationshipMap` fixes the keys `parent-entry`, `tool-call`, `first-kept-entry`, `branch-origin`, and `parent-conversation`. A `Relation` can contain any `Reference`, and `Reference.kind` can be `entry`, `tool-call`, or `conversation`. The RFC defines identity rules for each reference kind but never states which kinds are valid for each relationship key.

**Consequence:** The normative schema permits contradictory values such as a `parent-entry` targeting a conversation or a `parent-conversation` targeting a tool call. Producers can emit incompatible normalized graphs while conforming to the stated field types, and consumers must invent validation rules.

**Evidence:** Rung 2, document citation. This is a missing wire invariant. It is unproven at runtime.

## Cleared

The whole-document pass found these areas internally specified:

- The CLI separates inspection from passive reads and requires exactly one read selector.
- Retrieval coverage, historical loss, batch completeness, and unfinished tails are distinct concepts.
- Original JSON value preservation covers large numbers, negative zero, duplicate keys, Unicode escape semantics, and invalid UTF-8.
- Bookmark transport, continuity validation, fixed boundaries, method compatibility, and unsuccessful progress are specified.
- Source, record, result, failure, position, reference, consistency, and continuation objects have required field tables.
- Draft-04 gives separate identity rules for entry, tool-call, and conversation references.
- Paging and incremental capability states and request gates are defined, including the prohibition on `limited`.
- Refusal and runtime failure phases, precedence, cleanup, interruptions, output failure, and terminal framing are covered.
- Versioning distinguishes extensible protocol objects from maps with fixed keys.
- Passivity, private transcript handling, external references, and no-history-write requirements are present.
- The scope stays within passive normalization and does not add cross-call HCN storage, search, watching, or acknowledgements.
- The supplied structural validator reported no errors or warnings.

These clearances are rung 2 document findings. They do not prove implementation or native harness behavior.

## Not reviewed

The 180-second limit interrupted additional consistency searches after the three findings above were established. No further findings should be inferred from that cutoff.

The following were deliberately outside this document-only review:

- Current codebase behavior or drift from the proposed contract.
- Native harness source, official documentation, selected-version claims, or runtime behavior.
- Synthetic or real conformance execution.
- Feasibility, performance, and implementation cost.
- Private transcripts, secrets, and credential material.
- Previous review files. Their disposition tables were read only as sections of this RFC; the linked reports were not opened.
- Acceptance, rejection, revision, implementation, release, or publication decisions.
