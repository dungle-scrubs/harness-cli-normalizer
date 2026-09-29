/**
 * Direct tests for the per-worker state sandbox module
 * (test/cli/setup-state.ts), covering the two contracts the recheck
 * blocked on:
 *
 * 1. An operator-set HCN_STATE_DIR never reaches a spawned CLI: the
 *    module saves it at its first call, binds a directory the test
 *    process created under hcn-test-state-, and restores the operator
 *    value only at teardown. The operator's directory is never written
 *    to and never deleted.
 * 2. The teardown signal handlers preserve signal failure semantics: a
 *    child that loads the module and receives SIGTERM cleans its sandbox
 *    up and dies by SIGTERM, not by exit code 0.
 *
 * Both run in child Node processes because the module captures the
 * operator value at its FIRST call, which happens at setup-file load,
 * before any test code runs; only a fresh process exercises that first
 * call honestly. Node 24 strips types natively, so the generated drivers
 * import the real setup-state.ts by absolute path - no reimplementation
 * that could drift from the module under test.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureDist } from "./stub-dist.js";

const setupModule = join(import.meta.dirname, "setup-state.ts");
const testStatePrefix = join(tmpdir(), "hcn-test-state-");

/** A stand-in for an operator's state directory: made by the test, empty,
 * and something no test code ever writes into by design. */
const standInDir = (): string => mkdtempSync(join(tmpdir(), "hcn-setup-standin-"));

/** Removes a fixture this file created, only under one of its own prefixes. */
const removeOwned = (dir: string): void => {
  const owned = ["hcn-setup-standin-", "hcn-setup-driver-", "hcn-setup-signal-"].some((p) =>
    dir.startsWith(join(tmpdir(), p)),
  );
  if (!owned || dir.includes("..")) throw new Error(`refusing to delete ${dir}`);
  rmSync(dir, { recursive: true, force: true });
};

describe("ensureTestStateSandbox (operator-set HCN_STATE_DIR)", () => {
  test("a spawned CLI writes to an hcn-test-state- sandbox; the operator stand-in is unchanged and restored at teardown", () => {
    const cli = ensureDist();
    const standIn = standInDir();
    const workDir = mkdtempSync(join(tmpdir(), "hcn-setup-driver-"));
    try {
      const driver = join(workDir, "driver.ts");
      writeFileSync(
        driver,
        `import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureTestStateSandbox, testStateSandboxCleanup } from ${JSON.stringify(setupModule)};

const cli = process.argv[2];
if (cli === undefined) throw new Error("usage: driver.ts <cli> <standIn>");
// The stand-in comes from argv, NOT from HCN_STATE_DIR: ESM imports
// hoist, so the setup module (which replaces the variable) has already
// run by the time any later statement reads process.env.
const standIn = process.argv[3] ?? "";
const sandbox = ensureTestStateSandbox(); // later call: the import-time call was the first
const again = ensureTestStateSandbox(); // idempotent: same directory back
const run = spawnSync("node", [cli, "--help"], { encoding: "utf8", env: process.env, timeout: 20000 });
const report = {
  status: run.status,
  sandbox,
  sameDir: again === sandbox,
  sandboxLedger: existsSync(join(sandbox, "commands.jsonl")),
  standinLedger: existsSync(join(standIn, "commands.jsonl")),
  standinEntries: readdirSync(standIn),
};
testStateSandboxCleanup();
console.log(
  "REPORT " +
    JSON.stringify({
      ...report,
      restored: process.env.HCN_STATE_DIR ?? null,
      sandboxGone: !existsSync(sandbox),
    }),
);
`,
      );
      const result = spawnSync("node", [driver, cli, standIn], {
        encoding: "utf8",
        env: { ...process.env, HCN_STATE_DIR: standIn },
        timeout: 30000,
      });
      expect(result.stderr?.toString() ?? "").toBe("");
      const line = (result.stdout ?? "")
        .split("\n")
        .filter((l) => l.startsWith("REPORT "))
        .at(-1);
      if (line === undefined) throw new Error(`driver printed no report: ${result.stdout}`);
      const report = JSON.parse(line.slice("REPORT ".length)) as {
        status: number | null;
        sandbox: string;
        sameDir: boolean;
        sandboxLedger: boolean;
        standinLedger: boolean;
        standinEntries: string[];
        restored: string | null;
        sandboxGone: boolean;
      };
      expect(report.status).toBe(0);
      // The CLI wrote to a directory the test process created, and the
      // repeated call returned that same directory.
      expect(report.sandbox.startsWith(testStatePrefix)).toBe(true);
      expect(report.sandbox).not.toBe(standIn);
      expect(report.sameDir).toBe(true);
      expect(report.sandboxLedger).toBe(true);
      // The stand-in for the operator's directory is unchanged: no
      // ledger line, no new entry - checked in the driver AND from the
      // parent, so a late write cannot slip through either view.
      expect(report.standinLedger).toBe(false);
      expect(report.standinEntries).toEqual([]);
      expect(readdirSync(standIn)).toEqual([]);
      expect(existsSync(join(standIn, "commands.jsonl"))).toBe(false);
      // Teardown removed the sandbox it created and restored the
      // operator's value.
      expect(report.sandboxGone).toBe(true);
      expect(report.restored).toBe(standIn);
    } finally {
      // Stand-in and driver dir are this test's own fixtures; the
      // driver's sandbox was already removed by its own teardown.
      removeOwned(standIn);
      removeOwned(workDir);
    }
  });
});

describe("teardown signal handlers", () => {
  test("a child that loads the setup module and gets SIGTERM cleans its sandbox and dies by SIGTERM", async () => {
    const standIn = standInDir();
    const workDir = mkdtempSync(join(tmpdir(), "hcn-setup-signal-"));
    try {
      const driver = join(workDir, "driver.ts");
      const sandboxReport = join(workDir, "sandbox.path");
      writeFileSync(
        driver,
        // Write then rename: the parent polls for the report's existence, and
        // a plain write can be seen created but still empty.
        `import { renameSync, writeFileSync } from "node:fs";
import { ensureTestStateSandbox } from ${JSON.stringify(setupModule)};

const sandbox = ensureTestStateSandbox();
writeFileSync(${JSON.stringify(`${sandboxReport}.tmp`)}, sandbox);
renameSync(${JSON.stringify(`${sandboxReport}.tmp`)}, ${JSON.stringify(sandboxReport)});
setInterval(() => {}, 1000000);
`,
      );
      const child = spawn("node", [driver], {
        env: {
          ...process.env,
          HCN_STATE_DIR: standIn, // stand-in operator value; never written
        },
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (!child.pid) throw new Error("child.pid not defined");
      // Wait for the sandbox path report, then signal the child.
      const deadline = Date.now() + 5000;
      while (!existsSync(sandboxReport)) {
        if (Date.now() > deadline) throw new Error("child never reported its sandbox");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const sandbox = readFileSync(sandboxReport, "utf8");
      process.kill(child.pid, "SIGTERM");
      const closed = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      // The child died BY SIGTERM (re-raised after cleanup), not by
      // exit code 0 - an interrupted worker stays a failed run.
      expect(closed.signal).toBe("SIGTERM");
      expect(closed.code).toBeNull();
      // Its sandbox was removed by the signal handler first.
      expect(sandbox.startsWith(testStatePrefix)).toBe(true);
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(sandboxReport)).toBe(true); // driver dir kept until below
    } finally {
      removeOwned(standIn);
      removeOwned(workDir);
    }
  });
});
