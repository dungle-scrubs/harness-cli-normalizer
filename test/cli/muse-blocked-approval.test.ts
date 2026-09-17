/**
 * Issue #179, gap 2: the stub-binary scenario as a CLI-level test. A stub
 * `muse` first on PATH announces a session id like real `muse exec --json`
 * and answers `approval/listPending` with a judge-escalated network
 * approval on every poll; the built CLI must end the turn promptly with
 * the typed failure instead of hanging, and both stub processes must be
 * reaped. The escalated case reports at once, so this stays under a few
 * seconds. The consecutive-poll path and the fail-closed paths are covered
 * at the observer and runner seams (muse-approvals, muse-approval-blocked).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureDist, expectStubsReaped } from "./stub-dist.js";

const STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const dir = process.env.STUB_PID_DIR ?? "/tmp";
if (process.argv[2] === "exec") {
  writeFileSync(join(dir, "exec.pid"), String(process.pid));
  process.stdout.write(JSON.stringify({ stream: { kind: "session", id: "aa04301d-8756-4a8b-ae3e-aac0e71f7265" } }) + "\\n");
  setInterval(() => {}, 1000000);
} else if (process.argv[2] === "serve") {
  writeFileSync(join(dir, "serve.pid"), String(process.pid));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize" && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: {} }) + "\\n");
    } else if (msg.method === "approval/listPending" && msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          id: msg.id,
          jsonrpc: "2.0",
          result: {
            approvals: [
              { approvalId: "a", judgeEscalated: true, subject: { kind: "network" } },
            ],
            userInputs: [],
          },
        }) + "\\n",
      );
    }
  });
}
`;

describe("muse blocked approval against a stub binary (issue #179)", () => {
  test("a judge-escalated stub approval ends the run with a typed failure", () => {
    const cli = ensureDist();
    const tmp = mkdtempSync(join(tmpdir(), "hcn-muse-stub-"));
    try {
      const stubDir = join(tmp, "bin");
      const outDir = join(tmp, "out");
      const cwdDir = join(tmp, "cwd");
      mkdirSync(stubDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(cwdDir, { recursive: true });
      const stub = join(stubDir, "muse");
      writeFileSync(stub, STUB);
      chmodSync(stub, 0o755);
      const nodeDir = dirname(process.execPath);
      const start = Date.now();
      // dist/ is the node build: run it under node even when this file
      // itself runs on bun (there process.execPath is the bun binary).
      const result = spawnSync(
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
          "60",
          "--cwd",
          cwdDir,
          "Run: curl -sS https://example.com",
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            // The stub dir stays first so `muse` resolves to the stub, but
            // the inherited PATH is kept (not replaced): the M3 lane runs
            // on bun, where process.execPath is the bun binary and a
            // minimal PATH would hide `node` and skip the run via ENOENT.
            PATH: `${stubDir}:${nodeDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            HOME: process.env.HOME ?? "/tmp",
            TMPDIR: tmp,
            LANG: "C",
            STUB_PID_DIR: outDir,
          },
        },
      );
      const wallMs = Date.now() - start;
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return; // node not on PATH
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const events = String(result.stdout)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { kind?: string });
      expect(events.map((e) => e.kind)).toEqual(["identity", "error", "failure", "done"]);
      expect(String(result.stdout)).toMatch(/network/);
      const failure = events.find((e) => e.kind === "failure") as {
        class?: string;
        retryable?: boolean;
      };
      expect(failure.class).toBe("task");
      expect(failure.retryable).toBe(false);
      expect(String(result.stdout)).toMatch(/--autonomy/);
      const done = events.at(-1) as { cause?: string; exitCode?: number | null };
      expect(done.cause).toBe("failed");
      expect(done.exitCode).toBeNull();
      // The escalated path reports at once: well under the 30s stuck window.
      expect(wallMs).toBeLessThan(30_000);
      expectStubsReaped(outDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
