/**
 * N1/N2: the run resume guard checks the CHILD's effective environment.
 * CLI-level pins through `dispatch`, following the F-23 pattern in
 * cli.test.ts: a stub harness binary on a temp PATH proves the guard
 * passed by being spawned. Never runs a real harness CLI. Ported from
 * cursor to pi when cursor's headless surface became the SDK backend
 * (#440): pi is the remaining create-on-missing harness whose store the
 * run guard consults; the guard walk finds a pi session by any entry name
 * carrying the id under the resolved root.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dispatch } from "../../src/cli/index.js";
import { resumeStore } from "../../src/cli/resume-guard.js";
import { piCli } from "../../src/knowledge/pi.js";

// Helper to capture stdout/stderr and exitCode for dispatch (as in cli.test.ts).
const captureDispatch = async (
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> => {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
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
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const originalExit = process.exit;
  let exited: number | undefined;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exited = code;
    process.exitCode = code;
    throw new Error(`process.exit:${code}`);
  }) as unknown as typeof process.exit;
  let caught: unknown;
  try {
    await dispatch(argv);
  } catch (err) {
    caught = err;
    if (!(err instanceof Error && err.message.startsWith("process.exit:"))) throw err;
  }
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  process.exit = originalExit;
  const rawCode = exited ?? process.exitCode;
  const code = rawCode === 0 ? undefined : rawCode;
  process.exitCode = prevExit;
  if (caught && !(caught instanceof Error && caught.message.startsWith("process.exit:")))
    throw caught;
  return { stdout, stderr, exitCode: code };
};

/** File a pi session marker where the guard resolves the store: the same
 * rootEnv/defaultRoot precedence, so the file lands under
 * <root>/sessions/<slug>/ the way pi files <stamp>_<id>.jsonl. */
const filePiSession = (home: string, cwd: string, sessionId: string, envRoot?: string): void => {
  const { path } = resumeStore(piCli, {
    home,
    cwd,
    sessionId,
    env: envRoot === undefined ? {} : { PI_CODING_AGENT_DIR: envRoot },
  });
  if (path === null) throw new Error("pi store path unresolved");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `20260101T000000_${sessionId}.jsonl`), "");
};

/** A stub `agent` that records its argv and exits at once. Spawned only
 * when the resume guard passes, so its calls file pins "not refused". */
const installStubPi = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, "pi-calls");
  writeFileSync(
    join(dir, "pi"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\nexit 0\n`,
    { mode: 0o700 },
  );
  return calls;
};

const ENV_KEYS = ["HOME", "HCN_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PATH"] as const;

const saveEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

describe("N2: the run wiring passes --env through to the guard", () => {
  test("--env PI_CODING_AGENT_DIR=<tmp> with a valid session there is not refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-n2-home-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2-cfg-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n2-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n2-ccfg-"));
    const calls = installStubPi(binDir);
    const id = "55555555-5555-4333-8333-555555555555";
    filePiSession(home, cwd, id, cfg);
    const saved = saveEnv();
    process.env.HOME = home;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "pi",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        `PI_CODING_AGENT_DIR=${cfg}`,
      ]);
      expect(out.stderr).not.toContain(`no pi session ${id} found at`);
      expect(out.exitCode).not.toBe(2);
      expect(existsSync(calls)).toBe(true);
    } finally {
      restoreEnv(saved);
      for (const d of [home, cwd, cfg, binDir, hcnCfg]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  test("process PI_CODING_AGENT_DIR set plus --env PI_CODING_AGENT_DIR= refuses the now-stale id", async () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-n2r-home-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2r-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2r-cfg-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n2r-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n2r-ccfg-"));
    installStubPi(binDir);
    const id = "66666666-6666-4333-8333-666666666666";
    filePiSession(home, cwd, id, cfg);
    const saved = saveEnv();
    process.env.HOME = home;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    // The inherited root alone would find the session...
    process.env.PI_CODING_AGENT_DIR = cfg;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "pi",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        "PI_CODING_AGENT_DIR=",
      ]);
      // ...but the child deletes the key, so it files under the default
      // root where the id is stale, and the guard refuses.
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(`no pi session ${id} found at`);
      expect(out.stderr).toContain(join(home, ".pi", "agent"));
    } finally {
      restoreEnv(saved);
      for (const d of [home, cwd, cfg, binDir, hcnCfg]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

describe("N1: the guard reads home from the child's effective env", () => {
  test("--env HOME=<tmp> with a session under <tmp>/.pi/agent is not refused", async () => {
    const childHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n1-home-")));
    const procHome = mkdtempSync(join(tmpdir(), "hcn-n1-prochome-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n1-cwd-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n1-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n1-cfg-"));
    const calls = installStubPi(binDir);
    const id = "44444444-4444-4333-8333-444444444444";
    filePiSession(childHome, cwd, id);
    const saved = saveEnv();
    process.env.HOME = procHome;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "pi",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        `HOME=${childHome}`,
      ]);
      expect(out.stderr).not.toContain(`no pi session ${id} found at`);
      expect(out.exitCode).not.toBe(2);
      expect(existsSync(calls)).toBe(true);
    } finally {
      restoreEnv(saved);
      for (const d of [childHome, procHome, cwd, binDir, hcnCfg]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
