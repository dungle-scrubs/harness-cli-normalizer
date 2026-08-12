<!--
  Thanks for the PR! Keep the layer purity and chat-seam invariants intact,
  and make sure both test lanes pass (`pnpm check`).
-->

## Summary

<!-- What does this change do, and why? -->

## Related issue

<!-- "Closes #123" if applicable -->

## Checklist

- [ ] `pnpm check` passes (lint, typecheck, vitest, bun test)
- [ ] Purity invariants intact (`src/interpretation`, `src/knowledge` stay pure)
- [ ] Chat-seam invariant intact (no `src/` import of consumer protocol types)
- [ ] No changes to `test/fixtures/` (captured real harness output)
- [ ] Commit messages follow Conventional Commits
