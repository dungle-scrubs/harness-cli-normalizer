# Native tool results and usage are observations, not verdicts or derived totals

Accepted 2026-10-14.

hcn reports `tool-result` and `usage` as lossless observations, preserving
native tool payloads and native accounting scope. A tool failure does not
replace the harness's terminal turn verdict, and a clean turn is not a verdict
on an extension's workflow status. Interpreting that status belongs to the
caller, as does aggregation across turns or processes (ADR 0007).

Tool results keep structured values and native call identifiers rather than
flattening them into text. An absent error flag remains unknown. Completion
of a command does not establish a zero exit status when the native exit status
is missing.

Usage is sparse: absent counts and prices are unknown, not zero. Native
per-operation counts and cumulative session snapshots cannot be treated as the
same thing. Claude's main-loop turn tokens and cumulative session cost have
different coverage, including subagent and restored spend in the latter.
Consequently hcn emits the reported scope, cache-overlap relationship and
per-model breakdown where known; it derives no totals, prices or turn deltas.
The caller decides which observations its accounting needs.

## Considered alternatives

- Attaching one aggregate usage total to `done` would require deriving deltas
  from cumulative snapshots and deciding which nested operations to include.
  Keeping native scopes avoids that accounting policy.
- Treating failed tools or extension-specific status fields as turn failure
  would override the harness's verdict. Reporting the native result instead
  preserves the separation between an observation and a work verdict.

## Consequences

Only `token` and `progress` remain droppable. Consumers must accept the new
kinds and optional `tool.callId`, or ignore additions they do not understand.
Closed event schemas and context projectors need companion updates before
adopting this producer, as ADR 0009 already notes for additive kinds. hcn does
not import consumer protocol types or own those updates.

The [event contract](../reference.md#tool-results-and-usage) records the field
schema and current per-harness mappings; those facts are not duplicated here.
