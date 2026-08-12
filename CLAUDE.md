@AGENTS.md

# Claude Code-specific mechanics

Harness-independent guidance lives in `AGENTS.md` above; this file holds only
Claude Code mechanics. Apply `AGENTS.md` first, then this file.

- Run `pnpm check` before declaring work done - it is the full gate (lint,
  typecheck, vitest, bun test). Both test lanes must pass.
- Do not edit files under `test/fixtures/`. They are captured real harness
  output kept as evidence; scrubbing them breaks the tests that rely on them.
- Preserve the layer purity enforced by `test/interpretation/purity.test.ts`
  and `test/no-chat-imports.test.ts`. If a change seems to require crossing
  those seams, stop and reconsider the design first.
