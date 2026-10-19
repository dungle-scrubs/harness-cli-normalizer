@AGENTS.md

# Claude Code-specific mechanics

Harness-independent guidance lives in `AGENTS.md` above; this file holds only
Claude Code mechanics. Apply `AGENTS.md` first, then this file.

- Do not edit files under `test/fixtures/`. They are captured real harness
  output kept as evidence; scrubbing them breaks the tests that rely on them.
  The single exception is the operator-configuration redaction that `AGENTS.md`
  defines. It is required, not optional, and it never touches a field a test
  reads.
- Preserve the layer purity enforced by `test/interpretation/purity.test.ts`
  and `test/no-chat-imports.test.ts`. If a change seems to require crossing
  those seams, stop and reconsider the design first.
