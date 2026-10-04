# Popeye 0.1.4 verification, 2026-10-03

The selected source build is the clean detached public v0.1.4 tag. Unpublished
main is excluded. All six applicable native seven tripwires passed through the
configured loopback inference endpoint. Default tool use is unsupported and
skipped; escalation is unsupported and captured directly.

The current decoder reconstructs the live alpha tokens and final message.
The native seven-record journal binds the original session and retains the
assistant answer through parsePopeyeHistory and normalizePopeye. Current native
resume, interruption recovery and failure boundaries are retained independently.

Public passive transcript read has an existing unavailable embedded-content
guarantee. Coverage opt-ins cannot waive unavailable guarantees. The CLI test
pins the refusal, no records and byte-unchanged journal both with and without
opt-ins. It does not invent a text-only acquisition mode. Unsupported escalation,
context accounting and automatic compaction remain unsupported.

The first endpoint-less attempt failed and remains local evidence; only the
named successful native rerun justifies the current observation.
