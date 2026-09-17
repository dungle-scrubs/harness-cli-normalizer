/**
 * L6: SIGINT to `hcn run` reaches the harness child while the approval
 * observer runs. A stub `muse` announces an identity (so the observer
 * spawns its helper), records the signal its exec process receives, and
 * exits on it; the test sends SIGINT to the hcn process only and asserts
 * exec saw SIGTERM, the run reports killed, and both stubs are reaped.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureDist, expectStubsReaped } from "./stub-dist.js";

const STUB = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const dir = process.env.STUB_PID_DIR ?? "/tmp";
if (process.argv[2] === "exec") {
  writeFileSync(join(dir, "exec.pid"), String(process.pid));
  process.on("SIGTERM", () => {
    appendFileSync(join(dir, "exec.signals"), "SIGTERM\\n");
    process.exit(0);
  });
  process.stdout.write(JSON.stringify({ stream: { kind: "session", id: "bb04301d-8756-4a8b-ae3e-aac0e71f7265" } }) + "\\n");
  setInterval(() => {}, 1000000);
} else if (process.argv[2] === "serve") {
  writeFileSync(join(dir, "serve.pid"), String(process.pid));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: {} }) + "\\n");
    } else if (msg.method === "approval/listPending") {
      process.stdout.write(
        JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: { approvals: [], userInputs: [] } }) + "\\n",
      );
    }
  });
}
`;

const waitFor = async (path: string, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("SIGINT to hcn run with the muse observer running (L6)", () => {
  test("SIGINT reaches the harness child and reaps both stubs", async () => {
    const cli = ensureDist();
    const tmp = mkdtempSync(join(tmpdir(), "hcn-muse-sigint-"));
    try {
      const stubDir = join(tmp, "bin");
      const outDir = join(tmp, "out");
      const cwdDir = join(tmp, "cwd");
      mkdirSync(stubDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(cwdDir, { recursive: true });
      const { writeFileSync: write } = await import("node:fs");
      write(join(stubDir, "muse"), STUB);
      chmodSync(join(stubDir, "muse"), 0o755);
      const nodeDir = dirname(process.execPath);
      const child = spawn(
        "node",
        [
          cli,
          "run",
          "muse",
          "--json",
          "--model",
          "muse-spark-1.3-contributor",
          "--effort",
          "high",
          "--access",
          "write",
          "--timeout",
          "120",
          "--cwd",
          cwdDir,
          "Run: sleep 60",
        ],
        {
          env: {
            PATH: `${stubDir}:${nodeDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            HOME: process.env.HOME ?? "/tmp",
            TMPDIR: tmp,
            LANG: "C",
            STUB_PID_DIR: outDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (child.pid === undefined) throw new Error("test setup: hcn child has no pid");
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // The observer helper is up: signals from here on must still reach
      // the harness child, not the helper.
      await waitFor(join(outDir, "serve.pid"), 20_000);
      process.kill(child.pid, "SIGINT");
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 30_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exitCode, `hcn exited (stderr: ${stderr.slice(-500)})`).not.toBeNull();
      expect(exitCode).toBe(1);
      const signals = existsSync(join(outDir, "exec.signals"))
        ? readFileSync(join(outDir, "exec.signals"), "utf8")
        : "";
      expect(signals).toContain("SIGTERM");
      const done = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { kind?: string; cause?: string })
        .at(-1);
      expect(done).toMatchObject({ kind: "done", cause: "killed" });
      expectStubsReaped(outDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
