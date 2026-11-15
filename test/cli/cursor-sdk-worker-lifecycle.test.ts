import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CLOSE_GRACE_MS } from "../../src/execution/open-session.js";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { ensureDist } from "./stub-dist.js";

/** One real worker process (dist/execution/cursor-sdk-worker.js) with the
 * scripted fake SDK loaded through the test-only module loader - the same
 * seam the built-CLI lane uses, aimed directly at the worker so its own
 * process lifecycle (signals, failed writes) can be driven without the
 * runners in between. */
interface DrivenWorker {
  readonly child: ChildProcess;
  /** Resolve once stdout has contained the text (bounded). */
  waitFor(text: string): Promise<void>;
  write(line: string): void;
  destroyStdout(): void;
  /** The parent-vanished shape: destroy every pipe at once - the read
   * ends of stdout and stderr, and the write end of stdin (EOF). */
  destroyPipes(): void;
  /** Await exit; SIGKILLs and fails after deadlineMs. */
  exit(deadlineMs: number): Promise<{ code: number | null; signal: string | null }>;
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
  readonly calls: () => ReadonlyArray<Record<string, unknown>>;
  cleanup(): void;
}

const FAKE_DIR = fileURLToPath(new URL("./cursor-sdk-fake", import.meta.url));

const driveWorker = (script: unknown): DrivenWorker => {
  // ensureDist returns the cli entrypoint; the worker ships beside it.
  const workerEntry = join(dirname(ensureDist()), "execution", "cursor-sdk-worker.js");
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-cursor-worker-"));
  const scriptPath = join(root, "script.json");
  const recordPath = join(root, "calls.ndjson");
  writeFileSync(scriptPath, JSON.stringify(script));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.NODE_OPTIONS = `--import ${JSON.stringify(join(FAKE_DIR, "register.mjs"))}${env.NODE_OPTIONS ? ` ${env.NODE_OPTIONS}` : ""}`;
  env.HCN_TEST_CURSOR_SDK_SCRIPT = scriptPath;
  env.HCN_TEST_CURSOR_SDK_RECORD = recordPath;
  env.HCN_OBSERVER = "";
  const nodeBin = process.execPath.includes("node") ? process.execPath : "node";
  const child = spawn(nodeBin, [workerEntry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: root,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  // Destroyed read ends (the failed-write case) must not crash the driver.
  child.stdout?.on("error", () => {});
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stderr?.on("error", () => {});
  const waitFor = (text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`worker never wrote ${text}`)), 10_000);
      const observe = () => {
        if (stdout.includes(text)) finish();
      };
      const stopped = () => finish(new Error(`worker exited before writing ${text}`));
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        child.stdout?.off("data", observe);
        child.off("exit", stopped);
        if (error) reject(error);
        else resolve();
      };
      child.stdout?.on("data", observe);
      child.once("exit", stopped);
      observe();
    });
  const calls = (): ReadonlyArray<Record<string, unknown>> => {
    try {
      return readFileSync(recordPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  return {
    child,
    waitFor,
    write: (line) => {
      child.stdin?.write(line);
    },
    destroyStdout: () => {
      child.stdout?.destroy();
    },
    destroyPipes: () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    },
    exit: (deadlineMs: number) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `worker did not exit within ${deadlineMs}ms; stdout=${stdout}\nstderr=${stderr}`,
            ),
          );
        }, deadlineMs);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          resolve({ code: child.exitCode, signal: child.signalCode });
        }
      }),
    stdoutText: () => stdout,
    stderrText: () => stderr,
    calls,
    cleanup: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    },
  };
};

const openAndPrompt = (worker: DrivenWorker): void => {
  // The parent's one-shot shape: open and prompt in one write, the same
  // wire streamCursorSdkTurn writes.
  worker.write(`${JSON.stringify({ hcn: "open", id: "open" })}\n`);
  worker.write(`${JSON.stringify({ hcn: "prompt", id: "hcn-send:1", message: "hi" })}\n`);
};

const wireLines = (stdout: string): ReadonlyArray<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Cursor SDK worker process (fake SDK)", () => {
  test("SIGTERM runs the same finish path as EOF: native cancel, native dispose, cancelled turn end, clean exit inside the outer grace", async () => {
    const worker = driveWorker({
      agentId: "agent-00000000-0000-4000-8000-000000000001",
      sends: [{ holdOpen: true }],
    });
    try {
      openAndPrompt(worker);
      await worker.waitFor('"hcn":"receipt"');
      const signaled = Date.now();
      worker.child.kill("SIGTERM");
      const exit = await worker.exit(CLOSE_GRACE_MS);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - signaled).toBeLessThan(CLOSE_GRACE_MS);
      // Terminal settlement on the wire: the run ended cancelled, natively.
      const lines = wireLines(worker.stdoutText());
      expect(lines.at(-1)).toEqual({ hcn: "turn-end", status: "cancelled" });
      // The SDK saw the native cancellation and the agent's own disposal.
      const phases = worker.calls().map((call) => call.phase);
      expect(phases).toContain("cancel");
      expect(phases).toContain("dispose");
      expect(worker.stderrText()).not.toContain("unhandledRejection");
    } finally {
      worker.cleanup();
    }
  });

  test("SIGINT runs the same finish path: native cancel, native dispose, cancelled turn end, clean exit inside the outer grace", async () => {
    const worker = driveWorker({
      agentId: "agent-00000000-0000-4000-8000-000000000001",
      sends: [{ holdOpen: true }],
    });
    try {
      openAndPrompt(worker);
      await worker.waitFor('"hcn":"receipt"');
      const signaled = Date.now();
      worker.child.kill("SIGINT");
      const exit = await worker.exit(CLOSE_GRACE_MS);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - signaled).toBeLessThan(CLOSE_GRACE_MS);
      const lines = wireLines(worker.stdoutText());
      expect(lines.at(-1)).toEqual({ hcn: "turn-end", status: "cancelled" });
      const phases = worker.calls().map((call) => call.phase);
      expect(phases).toContain("cancel");
      expect(phases).toContain("dispose");
      expect(worker.stderrText()).not.toContain("unhandledRejection");
    } finally {
      worker.cleanup();
    }
  });

  test("a failed stdout write (EPIPE after the reader disappears) finishes the worker: cancel, dispose, clean exit, no unhandled rejection", async () => {
    const worker = driveWorker({
      agentId: "agent-00000000-0000-4000-8000-000000000001",
      // One replayed delta lands after the read end is destroyed, so the
      // worker's next wire write fails the way a vanished reader fails.
      sends: [
        {
          holdOpen: true,
          replayDelayMs: 300,
          events: [{ delta: { type: "text-delta", text: "H" } }],
        },
      ],
    });
    try {
      openAndPrompt(worker);
      await worker.waitFor('"hcn":"receipt"');
      worker.destroyStdout();
      const exit = await worker.exit(10_000);
      // The write failure routed through the idempotent finish path: the
      // run was cancelled natively, the agent disposed, the process exited
      // itself - no crash, no unhandled rejection bypassing disposal.
      expect(exit).toEqual({ code: 0, signal: null });
      const phases = worker.calls().map((call) => call.phase);
      expect(phases).toContain("cancel");
      expect(phases).toContain("dispose");
      const stderr = worker.stderrText();
      expect(stderr).not.toContain("unhandledRejection");
      // The failure was observed at the seam and reported, not hidden.
      expect(stderr).toContain("hcn cursor-sdk worker: stdout write failed");
    } finally {
      worker.cleanup();
    }
  });

  test("both dead pipes (parent vanished: stdout, stderr and stdin destroyed at once) still finish cleanly: cancel, dispose, exit 0", async () => {
    const worker = driveWorker({
      agentId: "agent-00000000-0000-4000-8000-000000000001",
      sends: [{ holdOpen: true }],
    });
    try {
      openAndPrompt(worker);
      await worker.waitFor('"hcn":"receipt"');
      worker.destroyPipes();
      const exit = await worker.exit(10_000);
      // The stdin EOF ran the idempotent finish; the turn-end write to the
      // dead stdout and every diagnostic to the dead stderr were absorbed
      // instead of surfacing as an uncaught EPIPE that bypasses disposal.
      expect(exit).toEqual({ code: 0, signal: null });
      const phases = worker.calls().map((call) => call.phase);
      expect(phases).toContain("cancel");
      expect(phases).toContain("dispose");
    } finally {
      worker.cleanup();
    }
  });

  test("a rejecting native cancel (SIGTERM) still disposes the agent: run cleanup failure reported, clean exit inside the outer grace", async () => {
    const worker = driveWorker({
      agentId: "agent-00000000-0000-4000-8000-000000000001",
      sends: [{ holdOpen: true, cancelFails: true }],
    });
    try {
      openAndPrompt(worker);
      await worker.waitFor('"hcn":"receipt"');
      const signaled = Date.now();
      worker.child.kill("SIGTERM");
      const exit = await worker.exit(CLOSE_GRACE_MS);
      // The cancel refused; the agent's own disposal still ran, the run
      // cleanup failure was reported under its own name, and nothing hung
      // waiting a run that was never cancelled.
      expect(exit).toEqual({ code: 0, signal: null });
      expect(Date.now() - signaled).toBeLessThan(CLOSE_GRACE_MS);
      const phases = worker.calls().map((call) => call.phase);
      expect(phases).toContain("cancel");
      expect(phases).toContain("dispose");
      expect(worker.stderrText()).toContain("hcn cursor-sdk worker: run cleanup failed");
    } finally {
      worker.cleanup();
    }
  });
});
