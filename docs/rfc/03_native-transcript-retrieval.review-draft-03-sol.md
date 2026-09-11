# RFC-03 Native transcript retrieval review - draft-03

## What was reviewed

- RFC: `docs/rfc/03_native-transcript-retrieval.rfc.md`
- Revision: `draft-03`
- Status: Draft
- Commit: `d200b953abc313d9547f6252e1bcd2475d6b0805`
- SHA-256: `6f3a8f78adcdf6ae4b4726dd2b7600b867a39708ed369ab2c9021b35c59ff58e`
- Reviewer: Sol xhigh

I read every section of the RFC, including its normative schema tables, state machine, failure precedence, conformance checklist, prior-review dispositions, open questions, and references.

## Structural results

The driver supplied this validator result for the exact reviewed file:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F1 - High: Reference validity rules conflate conversation IDs with entry and tool-call IDs

**Location:** Message Formats, “Record envelope and references,” lines 196-202.

`Reference.nativeId` has different meanings according to `kind`: an entry ID for `entry`, a call ID for `tool-call`, and a conversation ID for `conversation`. The following unconditional rule then says:

> If nativeId is non-null, scope.conversationId MUST equal it

Applied as written, an entry reference requires its enclosing conversation ID to equal the entry ID, and a tool-call reference requires it to equal the call ID. Those requirements contradict the preceding definitions. If the condition was intended to apply only to conversation references, the normative text does not state that scope.

**Consequence:** Conforming producers cannot encode ordinary entry or tool-call references without either violating this MUST or placing the wrong value in `scope.conversationId`. Consumers cannot determine which interpretation is authoritative.

**Evidence:** Rung 2, direct contradiction within the RFC at lines 196-202. No runtime claim is made.

### F2 - Medium: The four non-coverage capability statuses lack complete normative meanings

**Location:** Protocol Overview lines 73 and 77-88; Message Formats lines 108, 115, 138, 143, 206, and 230-254.

The RFC defines exact completeness meanings for `history`, `branches`, `original-records`, and `embedded-content`. It adds `active-branch`, `incremental`, `paging`, and `record-identity` to `CapabilityName`, and allows every capability to report `available`, `limited`, `unavailable`, or `unknown`.

The document describes behavior related to those four added capabilities, but it does not define what each status means for each capability. In particular, it does not state what a `limited` `paging`, `incremental`, `active-branch`, or `record-identity` capability guarantees compared with `available`.

**Consequence:** Two descriptors can report different statuses for the same behavior while both claiming conformance. Top-level capability aggregation and preflight refusal then produce inconsistent results across harnesses.

**Evidence:** Rung 2, comparison of the complete guarantee definitions with the capability schema and aggregation rules. No implementation or runtime behavior was inspected.

### F3 - Medium: Inspection-error extensibility conflicts with schema-version extensibility

**Location:** “Capability document and inspection errors,” line 145; “Schema conventions and value preservation,” line 98; Versioning, lines 345-348.

The schema convention permits added optional fields under Versioning, and Versioning says adding an optional protocol field is compatible within schema version 1. The inspection-error definition instead says the object has “exactly” the listed fields.

**Consequence:** A producer cannot know whether adding an optional field to `transcript-inspection-error` is permitted by schema version 1 or forbidden by the object’s exact-field rule. Consumers likewise cannot know whether to ignore or reject such a field.

**Evidence:** Rung 2, conflicting document statements at the cited locations. No runtime claim is made.

## Cleared

The whole-document pass found these areas internally coherent:

- The RFC keeps transcript retrieval within HCN’s normalization role and leaves indexing, retention, search, watching, and cross-call acknowledgement to consumers.
- Coverage of retained data is separated from historical loss.
- Bounded batches are separated from coverage completeness.
- Bookmark validity is separated from source position and native identity.
- Initial, empty, incremental, failed, and interrupted reads have defined continuation outcomes.
- Successful results require verified compatibility, a known consistency method, and passing required checks.
- Source corruption, unfinished tails, prior-history changes, and changes during a call have distinct outcomes.
- Failure phases, exit codes, and precedence cover every state-machine failure transition.
- Passivity, transcript privacy, temporary-material cleanup, and output failure have explicit requirements.
- The conformance checklist covers every major protocol area and distinguishes method-specific enablement evidence from shared interface tests.
- No dangling named wire object or issue code was found beyond the findings above.

## Not reviewed

- Repository implementation, architecture integration, tests, and current CLI behavior.
- Native Claude, Codex, Pi, or Muse behavior and capability claims.
- The RFC’s linked issues, ADRs, research documents, and earlier review reports.
- Runtime reproduction, synthetic execution, and private transcripts.
- Broad implementation feasibility, performance, and delivery estimates.

These exclusions follow the document-only brief and the review time limit. This report makes no acceptance decision, implementation recommendation, or revision of the RFC.
