/**
 * Direct tests for the shared terminate-and-reap helper (reap.ts): a
 * live child that ignores SIGTERM must be ended by the cleanup, and the
 * fixture directory deleted only afterwards. The stub writes its pid so
 * a run that leaves it alive can be cleaned up by hand from the kept
 * directory; the happy path never needs that.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cleanupSandbox, terminateAndReap } from "./reap.js";

const prefix = join(tmpdir(), "hcn-reap-");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stub that installs a SIGTERM handler and keeps running, so only
 * SIGKILL can end it. */
const immortalStub = (dir: string): { script: string; pidFile: string } => {
  const script = join(dir, "immortal.mjs");
  const pidFile = join(dir, "stub.pid");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000000);
`,
  );
  chmodSync(script, 0o755);
  return { script, pidFile };
};

const waitForFile = async (path: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`stub never wrote ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("terminateAndReap / cleanupSandbox", () => {
  test("a live child that ignores SIGTERM is ended by the cleanup, and only then is the directory deleted", async () => {
    const dir = mkdtempSync(prefix);
    const { script, pidFile } = immortalStub(dir);
    const child = spawn("node", [script], { stdio: "ignore" });
    if (!child.pid) throw new Error("child.pid not defined");
    // Wait for the pid file: it is written after the SIGTERM handler is
    // installed, so the child is provably SIGTERM-proof from here on.
    await waitForFile(pidFile);
    expect(alive(child.pid)).toBe(true);
    await cleanupSandbox({ pids: [child.pid], dirs: [dir], prefix, label: "reap test" });
    // Both must hold: the child ended, and the directory was deleted -
    // and the deletion can only have happened after the reap, because
    // cleanupSandbox rejects (and never deletes) while a pid lives.
    expect(alive(child.pid)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("an already-exited child and an empty pid list delete cleanly under the prefix", async () => {
    const dir = mkdtempSync(prefix);
    const { script, pidFile } = immortalStub(dir);
    const child = spawn("node", [script], { stdio: "ignore" });
    if (!child.pid) throw new Error("child.pid not defined");
    await waitForFile(pidFile);
    // SIGKILL directly: the helper sees an exited pid and must not
    // signal anything (signaling a reaped pid would be an ESRCH error
    // path, not a failure).
    process.kill(child.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await terminateAndReap([child.pid, 0, -1], "reap test");
    await cleanupSandbox({ pids: [], dirs: [dir], prefix, label: "reap test" });
    expect(existsSync(dir)).toBe(false);
  });
});
