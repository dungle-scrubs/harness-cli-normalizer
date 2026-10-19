# Enforced agent rules

| Rule | Enforcement | Proof |
| --- | --- | --- |
| Run an explicit `pnpm build` before either raw test runner, including unit-only selections. `dist/cli.js` must exist and be at least as new as every `src/**/*.ts` file. | `test/cli/build-state.ts` owns validation; `test/cli/setup-build.ts` runs first in Vitest `setupFiles` and Bun `test.preload`. The CLI stub spawn seam reuses the same validator. Errors name the missing/stale path and `pnpm build`; no test startup rebuilds output. | `test/cli/build-state.test.ts` covers missing output, nested stale source, fresh and equal timestamps. Native child Vitest/Bun runs load the checked-in startup configuration: bad builds fail before test-file evaluation without leaking isolated state; fresh controls execute and clean up isolated state. |
| Durable task state belongs in the primary checkout's `.scratch/<task>/`, not a disposable linked checkout. Top-level outputs need an existing repository owner or deliberate staging as project history. | `scripts/task-state.ts` checks this checkout's names and structure. `pnpm check:task-state` runs right after `pnpm check:setup` in `pnpm check` and its CI mirror, and unconditionally at precommit. Diagnostics direct artifacts to the primary checkout registered by `pnpm setup:hooks`; with no registration the gate fails and teaches that setup. `.scratch` symlinks and nonempty linked `.scratch` fail even when ignored; adding an ignore pattern does not establish ownership. | `test/task-state.test.ts` creates controlled primary/linked Git repos. It covers ignored scratch, arbitrary output roots/files, source/index ownership, generated/local config owners, portable diagnostics, non-destructive failure, spaces/newlines, registered and ownerless conventional and separate Git directories, a partial-commit index, and invalid/bare primaries. It executes the CLI and the default `pnpm check` entry under the real pinned pnpm, and contract-tests CI/precommit wiring. |
| Git hooks are set up only by `pnpm setup:hooks`, run once from the primary checkout root. Installing dependencies never writes hooks. | `package.json` has no lifecycle script that sets up hooks; `test/hook-setup.test.ts` requires one workspace approval map (`allowBuilds`) with the Lefthook build denied; `lefthook.yml` sets `no_auto_install`. `scripts/install-hooks.ts` refuses linked checkouts, subdirectories and scripts from another repository before any write, registers the primary at cwd as `core.worktree`, and deploys a dispatcher, Lefthook copy and Node link from the script's checkout into `<git-common-dir>/hcn-hooks`; any configured hook it did not write needs `--replace` and is backed up. Lefthook parses only a plain-top-level-key copy of `lefthook.yml`, and readiness validates a closed manifest and the Node link target. `pnpm check:setup` (`scripts/check-hook-setup.ts`) runs first in `pnpm check` and CI, after CI's explicit setup. | `test/hook-setup.test.ts` covers the lifecycle contract, a real pnpm install of a synthetic package, primary-only setup in every metadata layout, a linked-checkout source and a foreign-repository source, malformed manifests, a replaced Node link, rejected config forms with a native-dump sentinel, conflicting and missing owners, inherited Git context, linked-checkout dispatch after the source install is deleted, hook arguments/stdin/exit status, the `--no-auto-install` witness, the historical producer's hooks, and readiness rejecting no-op or drifted setups. |

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
deletes anything. Git metadata cannot reveal where a primary checkout lives when
its metadata is separate, so the primary is whatever `pnpm setup:hooks`
registered as `core.worktree`, validated against Git and never guessed.
Unregistered, bare, missing or unresolvable primaries fail with an actionable
limitation rather than selecting a linked checkout.

## Build boundary

This is an mtime guard for the observed test-before-build mistake, not a fingerprint
of every build input or native metadata. It rejects bad build state without moving
builds into active test runs. The earlier tracked ordering fix is `a648628`;
historical command-order replay is a separate maintainer proof.
