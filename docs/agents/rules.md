# Enforced agent rules

| Rule | Enforcement | Proof |
| --- | --- | --- |
| Run an explicit `pnpm build` before either raw test runner, including unit-only selections. `dist/cli.js` must exist and be at least as new as every `src/**/*.ts` file. | `test/cli/build-state.ts` owns validation; `test/cli/setup-build.ts` runs first in Vitest `setupFiles` and Bun `test.preload`. The CLI stub spawn seam reuses the same validator. Errors name the missing/stale path and `pnpm build`; no test startup rebuilds output. | `test/cli/build-state.test.ts` covers missing output, nested stale source, fresh and equal timestamps. Native child Vitest/Bun runs load the checked-in startup configuration: bad builds fail before test-file evaluation without leaking isolated state; fresh controls execute and clean up isolated state. |
| Durable task state belongs in the primary checkout's `.scratch/<task>/`, not a disposable linked checkout. Top-level outputs need an existing repository owner or deliberate staging as project history. | `scripts/task-state.ts` checks this checkout's names and structure. `pnpm check:task-state` runs first in `pnpm check` and its CI mirror, and unconditionally at precommit. Diagnostics direct artifacts to the Git-resolved primary checkout. `.scratch` symlinks and nonempty linked `.scratch` fail even when ignored; adding an ignore pattern does not establish ownership. | `test/task-state.test.ts` creates controlled primary/linked Git repos. It covers ignored scratch, arbitrary output roots/files, source/index ownership, generated/local config owners, portable diagnostics, non-destructive failure, spaces/newlines, separate Git directories and unresolved/bare primaries. It executes the CLI and default `pnpm check` entry and contract-tests CI/precommit wiring. |

## Placement boundary

The placement gate reads names, Git metadata and directory structure, not artifact
contents. Source roots come from the Git index, so ordinary new files under
existing roots need no staging. New top-level project files or roots must be
staged deliberately; private local instructions stay untracked. Generated outputs
and local configuration have explicit repository owners in the helper, independent
of ignore patterns. Disposable CLI fixtures use `.test-tmp/cli-fixtures`, retaining
their CommonJS package and Git-discovery boundaries.

Empty linked `.scratch` directories are harmless. Primary `.scratch` is allowed.
The gate does not inspect other worktrees or infer intent inside valid source or
generated roots; it cannot prevent arbitrary writes there. It never moves or
deletes anything. Git's first NUL-framed porcelain record identifies the primary;
if Git reports a separate metadata directory, an explicit Git `core.worktree`
owner is required. Bare, missing or unresolvable primaries fail with an actionable
limitation rather than selecting a linked checkout.

## Build boundary

This is an mtime guard for the observed test-before-build mistake, not a fingerprint
of every build input or native metadata. It rejects bad build state without moving
builds into active test runs. The earlier tracked ordering fix is `a648628`;
historical command-order replay is a separate maintainer proof.
