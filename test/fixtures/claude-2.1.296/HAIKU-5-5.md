# Haiku 5.5 model selection verification

Captured 2026-10-11 with Claude Code 2.1.296 and the explicit selector
`claude-haiku-5-5`. All seven capability scenarios and the question probe
passed; the receipts are `haiku-seven.snapshot.json` and
`haiku-questions.snapshot.json`. The evidence test binds all seven passing
results and the question receipt's exact model/version observation.
`haiku-5-5.ndjson` preserves the first turn's native stream-event,
assistant, and result records byte for byte. It is an excerpt: system, hook,
and user records are not included. No operator configuration appears in the
retained records. The native assistant model and result `modelUsage` both
attest `claude-haiku-5-5`; the result completes cleanly with `alpha`.

[Anthropic's model overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
identifies `claude-haiku-5-5` as the released model ID.
[Claude Code's model configuration](https://code.claude.com/docs/en/model-config#model-aliases)
requires Claude Code 2.1.293 or newer and maps `haiku` to 5.5 on the Anthropic
API. HCN's alias follows that current mapping; explicit Haiku 4.5 remains
selectable. This model-list update does not change the existing harness
verification anchor or its historical Sonnet question observation.
