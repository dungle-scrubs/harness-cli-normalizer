/**
 * The Bun-lane half of the per-worker state sandbox: bunfig.toml preloads
 * this file. `bun test` fires no `exit` handlers (verified on bun 1.3.14),
 * so the cleanup registers as a bun:test `afterAll` instead; the vitest
 * lane uses the exit/signal handlers inside setup-state.ts itself. See
 * setup-state.ts for the sandbox rules.
 */
// "vitest" is imported, not "bun:test", because tsc types this tree
// with node types only; bun's test runner aliases vitest imports to its
// own implementation, so the hook registers in the Bun lane too.
import { afterAll } from "vitest";
import { ensureTestStateSandbox, testStateSandboxCleanup } from "./setup-state.js";

ensureTestStateSandbox();
afterAll(() => testStateSandboxCleanup());
