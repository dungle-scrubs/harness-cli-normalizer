/**
 * Per-worker test state sandbox (ADR 0011, finding 3): every test worker
 * binds a private HCN_STATE_DIR before any test file runs, so a spawned
 * CLI's durable command ledger never lands in the operator's
 * $XDG_STATE_HOME.
 *
 * The sandbox is ALWAYS test-owned. At its first call (setup-file load,
 * before any test code runs) the module saves whatever HCN_STATE_DIR the
 * operator had set, then binds a directory this process created under
 * hcn-test-state- in TMPDIR. The operator's value is used only to restore
 * process.env at teardown; it is never written to and never deleted, and
 * it is never returned to a caller, so it can never reach a spawned CLI.
 *
 * Later calls return the current binding: the module's own directory, or
 * a directory some test bound over it (ledger.test.ts binds its own
 * fixture and unbinds it in afterEach - that binding is a test's, never
 * the operator's, because the first call already replaced the operator's
 * value before any test ran). When the variable is unset or empty, the
 * module re-binds its own directory, creating it only once per process.
 *
 * Teardown removes every directory this module created, under the
 * hcn-test-state- prefix check - the same rule as any mkdtemp fixture:
 * delete only paths you created yourself, under a named prefix, checked
 * before deletion - and restores the operator's value.
 *
 * Teardown differs by lane because the runtimes differ: a Node process
 * runs `exit` handlers on normal exit, and a worker the pool tears down
 * by signal runs none unless the signal is caught - so this module
 * registers an `exit` handler plus SIGTERM/SIGINT/SIGUP handlers. Those
 * handlers clean up, remove themselves, and re-raise the same signal, so
 * an interrupted worker still dies by that signal instead of exiting 0.
 * Bun's test runner fires no `exit` handlers at all (verified on bun
 * 1.3.14), so the Bun lane uses setup-state.bun.ts, which registers the
 * same cleanup as a bun:test `afterAll` from the preload.
 *
 * Loaded by vitest `setupFiles` (this file) and bun `preload` (the
 * wrapper). test/cli/stub-dist.ts calls ensureTestStateSandbox at import
 * and again inside ensureDist (the spawn-time seam), so a lane that ever
 * loads test files without this setup still never writes to the
 * operator's state; the helper is idempotent against the env check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prefix = join(tmpdir(), "hcn-test-state-");

/** The operator's HCN_STATE_DIR as found at the first call, before any
 * test code ran. `operatorCaptured` false means the first call has not
 * happened yet. */
let operatorStateDir: string | undefined;
let operatorCaptured = false;

/** The sandbox this process created and currently binds; null before
 * the first bind and after teardown. */
let boundDir: string | null = null;

/** True once teardown ran: a post-teardown call must not mistake the
 * restored operator value for a test binding. */
let cleaned = false;

/** Every sandbox this process created and still owns. */
const created: string[] = [];

let handlersRegistered = false;

/** Removes every sandbox this process created, under the named prefix,
 * and restores the operator's value. Idempotent; safe to call from exit
 * handlers, signal handlers, and afterAll. */
export const testStateSandboxCleanup = (): void => {
  cleaned = true;
  const owned = created.splice(0);
  boundDir = null;
  if (owned.length === 0) return;
  for (const dir of owned) {
    // Check the named prefix before deletion; never a parent, TMPDIR,
    // HOME, or any path computed with '..'.
    if (dir.startsWith(prefix)) rmSync(dir, { recursive: true, force: true });
  }
  if (!operatorCaptured) return;
  if (operatorStateDir === undefined) delete process.env.HCN_STATE_DIR;
  else process.env.HCN_STATE_DIR = operatorStateDir;
};

/** Idempotent: returns the binding for spawned CLIs. At the first call,
 * captures the operator's value and binds a fresh test-owned sandbox
 * (never the operator's). At later calls, returns the current binding:
 * the module's own directory when still bound, or a test's own binding
 * (ledger.test.ts) that replaced it; binds a fresh one only when the
 * variable is unset, empty, or restored by an earlier teardown. */
export const ensureTestStateSandbox = (): string => {
  const existing = process.env.HCN_STATE_DIR;
  if (!operatorCaptured) {
    // First call: whatever the variable held came from the operator -
    // no test code has run yet. Save it for teardown restoration only.
    operatorCaptured = true;
    operatorStateDir = existing;
  } else if (!cleaned && existing !== undefined && existing !== "") {
    // A value bound after the first call: the operator's value was
    // replaced then, so this is a test's own binding. Keep it.
    return existing;
  }
  if (boundDir === null) {
    boundDir = mkdtempSync(prefix);
    created.push(boundDir);
  }
  process.env.HCN_STATE_DIR = boundDir;
  return boundDir;
};

const registerTeardown = (): void => {
  if (handlersRegistered) return;
  handlersRegistered = true;
  process.on("exit", () => testStateSandboxCleanup());
  // A worker terminated by a signal runs no 'exit' handler (Node fires
  // it only on normal exit or explicit process.exit), and the runner
  // pool tears its workers down by signal. Catch the common ones, clean
  // up, then remove this handler and re-raise the same signal so the
  // worker dies by that signal - an interrupted run stays a failed run,
  // never a success exit. process.exit(0) here would have turned a
  // SIGTERM into exit code 0.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = (): void => {
      testStateSandboxCleanup();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
};

// An operator-set observer must never reach a spawned CLI: a child env
// built from process.env would inherit it and run that external command.
// Tests that want an observer set HCN_OBSERVER on the child env themselves.
delete process.env.HCN_OBSERVER;
delete process.env.HCN_INVOCATION_ID;

ensureTestStateSandbox();
registerTeardown();
