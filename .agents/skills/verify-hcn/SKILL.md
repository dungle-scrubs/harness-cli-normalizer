---
name: verify-hcn
description: Verify hcn CLI behavior through the built binary, isolated native-process fixtures and dual-runtime gates. Use when checking run-event claims, resume behavior, failure classification or access presets.
---

# Verify hcn

## Launch

From the checkout being verified, run `pnpm install --frozen-lockfile` if dependencies are absent, then `pnpm build`. There is no server or port. Each CLI integration test spawns the built `dist/cli.js` with its own disposable HOME, configuration, store and native executable. Use a separate worktree for each concurrent build; never rebuild a checkout another verifier is driving.

## Doctor

Run `node dist/cli.js --version`, `node dist/cli.js run --help` and `git status --short`. Confirm the build just succeeded at the revision under review. A version alone does not establish freshness. If fixture spawning fails, inspect `test/cli/fixture-tmpdir.ts` and the test's explicit environment before blaming the product. Do not read real credential files or personal transcripts.

## Drive

Read [the feature index](features/README.md), then drive every entry point relevant to each claim. The CLI is the product: internal-function tests supplement, not replace, built-CLI proof. Existing synthetic native executables replace only the external harness process boundary; they do not prove a provider or permission system's real behavior. For native behavior use committed captures and documented probes, or a task-owned fresh native run with explicit isolation and cost limits.

Run `pnpm check` as the final gate. It builds before CLI tests, runs both Node/Vitest and Bun lanes, then checks packaged skill claims and package contents. `pnpm check:skill` needs clone-capable TMPDIR (APFS on macOS); do not bypass `CHECK_CLAIMS_REQUIRE_SNAPSHOT=1`. A fresh verifier uses a different model family from the builder and returns one verdict per claim: verified, not verified or inconclusive. Any unverified claim blocks merge.

## Evidence

Capture commands, revision, stdout/stderr, exit status and observable event order in `.scratch/<task>/evidence/` in the main checkout, not a worktree. Verify side effects such as native argv and session files beside event output. Compare bug regressions with the pre-fix revision under the same conditions. A test that also passes before the fix is not red/green evidence. Inspect dry-run commands for actual effects instead of assuming their name guarantees isolation. Evidence cited by committed documentation or tickets belongs in committed `.evidence/<task>/`, otherwise cite the finding rather than a local path.

## Cleanup

Tests own and remove their disposable native fixtures in `finally` blocks. After failures inspect task-owned leftovers; remove only artifacts this run created. Never kill a process by name or touch personal harness stores. Retain evidence outside fixture teardown and confirm it remains readable. No daemon teardown is needed. Remove a verification worktree only after it is clean and its task is finished.

## Helpers

Use repository scripts and tests linked by the feature map; this skill adds no separate driver.
