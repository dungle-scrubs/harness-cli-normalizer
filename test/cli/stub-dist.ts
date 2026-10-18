import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { ensureCurrentBuild } from "./build-state.js";
import { ensureTestStateSandbox } from "./setup-state.js";

// The built CLI this helper points tests at writes the durable command
// ledger on every invocation. Keep those appends out of the operator's
// real state directory: the spawned processes' HCN_STATE_DIR points at a
// per-worker temp sandbox (spawned CLIs inherit the environment). Both
// lanes load test/cli/setup-state.ts before any test file; the import-time
// call is the idempotent fallback for a lane that somehow does not. The
// ensureDist call is the spawn-time seam: ledger.test.ts binds the
// variable to its own fixture and unbinds it in afterEach, so every
// spawn re-binds a sandbox first. Teardown lives in setup-state.ts.
ensureTestStateSandbox();

export const ensureDist = (): string => {
  ensureTestStateSandbox();
  return ensureCurrentBuild();
};

/** Both stub processes must be reaped when the run ends - kill(pid, 0)
 * throws once no process holds the pid. */
export const expectStubsReaped = (outDir: string): void => {
  for (const name of ["exec.pid", "serve.pid"]) {
    const pid = Number(readFileSync(join(outDir, name), "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0, `${name} holds a pid`).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }
};
