# Enforced agent rules

| Rule | Enforcement | Proof |
| --- | --- | --- |
| Run an explicit `pnpm build` before either raw test runner, including unit-only selections. `dist/cli.js` must exist and be at least as new as every `src/**/*.ts` file. | `test/cli/build-state.ts` owns validation; `test/cli/setup-build.ts` runs first in Vitest `setupFiles` and Bun `test.preload`. The CLI stub spawn seam reuses the same validator. Errors name the missing/stale path and `pnpm build`; no test startup rebuilds output. | `test/cli/build-state.test.ts` covers missing output, nested stale source, fresh and equal timestamps. Native child Vitest/Bun runs load the checked-in startup configuration: bad builds fail before test-file evaluation without leaking isolated state; fresh controls execute and clean up isolated state. |

This is an mtime guard for the observed test-before-build mistake, not a fingerprint
of every build input or native metadata. It rejects bad build state without moving
builds into active test runs. The earlier tracked ordering fix is `a648628`;
historical command-order replay is a separate maintainer proof.
