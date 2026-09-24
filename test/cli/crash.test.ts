import { afterEach, describe, expect, test } from "vitest";
import { handleProcessCrash, markJsonCrashStream, reportMainCrash } from "../../src/cli/crash.js";

/** Capture process stdout/stderr writes and the exit code; restore after. */
const capture = (fn: () => void): { stdout: string; stderr: string; exitCode: number } => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const prevExit = process.exitCode;
  let stdout = "";
  let stderr = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    stderr += String(chunk);
    return true;
  };
  process.exitCode = 0;
  try {
    fn();
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = prevExit === undefined ? 0 : prevExit;
  return { stdout, stderr, exitCode };
};

afterEach(() => {
  markJsonCrashStream(false);
});

describe("crash tier: main-loop failure", () => {
  test("a --json stream gets the failure/done pair and exit 4", () => {
    markJsonCrashStream(true);
    const out = capture(() => reportMainCrash("uncaught in main", new Error("boom in dispatch")));
    expect(out.exitCode).toBe(4);
    expect(out.stdout).toContain('"kind":"failure"');
    expect(out.stdout).toContain('"class":"internal"');
    expect(out.stdout).toContain('"kind":"done"');
    expect(out.stdout).toContain('"cause":"crash"');
    expect(out.stdout).toContain('"exitCode":4');
    expect(out.stderr).toContain("Internal hcn failure");
    expect(out.stderr).toContain("boom in dispatch");
  });

  test("a text-mode crash writes stderr only, exit 4, stdout untouched", () => {
    markJsonCrashStream(false);
    const out = capture(() => reportMainCrash("uncaught in main", new Error("boom in dispatch")));
    expect(out.exitCode).toBe(4);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Internal hcn failure");
  });

  test("a non-Error rejection is stringified, not crashed on", () => {
    markJsonCrashStream(false);
    const out = capture(() => reportMainCrash("unhandledRejection", "just a string"));
    expect(out.exitCode).toBe(4);
    expect(out.stderr).toContain("just a string");
  });
});

describe("crash tier: process handler", () => {
  /** Run the handler with process.exit mocked; returns the exit code the
   * handler requested plus captured stdout/stderr. */
  const runHandler = (
    kind: string,
    error: unknown,
    write: (line: string) => void,
  ): { stdout: string; stderr: string; exitCode: number | undefined } => {
    const originalExit = process.exit;
    let code: number | undefined;
    (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => {
      code = c;
      throw new Error(`EXITED:${c}`);
    }) as unknown as typeof process.exit;
    let stdout = "";
    let stderr = "";
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      stdout += String(chunk);
      return true;
    };
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      stderr += String(chunk);
      return true;
    };
    try {
      handleProcessCrash(kind, error, write);
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("EXITED:"))) throw err;
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
      process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    }
    return { stdout, stderr, exitCode: code };
  };

  test("json stream: synchronous pair, then exit 4", () => {
    markJsonCrashStream(true);
    const syncLines: string[] = [];
    const out = runHandler("uncaughtException", new Error("timer death"), (line) => {
      syncLines.push(line);
    });
    expect(out.exitCode).toBe(4);
    expect(syncLines).toHaveLength(2);
    expect(syncLines[0]).toContain('"kind":"failure"');
    expect(syncLines[1]).toContain('"cause":"crash"');
    expect(out.stderr).toContain("timer death");
  });

  test("text mode: stderr, no pair, exit 4", () => {
    markJsonCrashStream(false);
    const syncLines: string[] = [];
    const out = runHandler("uncaughtException", new Error("timer death"), (line) => {
      syncLines.push(line);
    });
    expect(out.exitCode).toBe(4);
    expect(syncLines).toHaveLength(0);
    expect(out.stderr).toContain("timer death");
  });

  test("a throwing sync writer still exits 4", () => {
    markJsonCrashStream(true);
    const out = runHandler("uncaughtException", new Error("x"), () => {
      throw new Error("stdout gone");
    });
    expect(out.exitCode).toBe(4);
  });
});
