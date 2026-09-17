/**
 * N1/N2: the run resume guard checks the CHILD's effective environment.
 * CLI-level pins through `dispatch`, following the F-23 pattern in
 * cli.test.ts: a stub `agent` on a temp PATH proves the guard passed by
 * being spawned. Never runs a real harness CLI.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dispatch } from "../../src/cli/index.js";
import { storePath } from "../../src/interpretation/store.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

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

/** File a cursor session the way the harness does: <root>/chats/<md5>/<id>/. */
const fileCursorSession = (home: string, cwd: string, sessionId: string, root?: string): void => {
  const filed = storePath(cursorCli, {
    home,
    cwd,
    sessionId,
    ...(root !== undefined ? { root } : {}),
  });
  mkdirSync(join(filed, sessionId), { recursive: true });
};

/** A stub `agent` that records its argv and exits at once. Spawned only
 * when the resume guard passes, so its calls file pins "not refused". */
const installStubAgent = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, "agent-calls");
  writeFileSync(
    join(dir, "agent"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\nexit 0\n`,
    { mode: 0o700 },
  );
  return calls;
};

const ENV_KEYS = [
  "HOME",
  "HCN_CONFIG_DIR",
  "CURSOR_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "PATH",
] as const;

const saveEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const restoreEnv = (saved: Record<string, string | undefined>): void => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

describe("N2: the run wiring passes --env through to the guard", () => {
  test("--env CURSOR_CONFIG_DIR=<tmp> with a valid session there is not refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-n2-home-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2-cfg-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n2-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n2-ccfg-"));
    const calls = installStubAgent(binDir);
    const id = "55555555-5555-4333-8333-555555555555";
    fileCursorSession(home, cwd, id, cfg);
    const saved = saveEnv();
    process.env.HOME = home;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    delete process.env.CURSOR_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "cursor",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        `CURSOR_CONFIG_DIR=${cfg}`,
      ]);
      expect(out.stderr).not.toContain(`no cursor session ${id} found at`);
      expect(out.exitCode).not.toBe(2);
      expect(existsSync(calls)).toBe(true);
    } finally {
      restoreEnv(saved);
      for (const d of [home, cwd, cfg, binDir, hcnCfg]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  test("process CURSOR_CONFIG_DIR set plus --env CURSOR_CONFIG_DIR= refuses the now-stale id", async () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-n2r-home-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2r-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n2r-cfg-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n2r-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n2r-ccfg-"));
    installStubAgent(binDir);
    const id = "66666666-6666-4333-8333-666666666666";
    fileCursorSession(home, cwd, id, cfg);
    const saved = saveEnv();
    process.env.HOME = home;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    // The inherited root alone would find the session...
    process.env.CURSOR_CONFIG_DIR = cfg;
    delete process.env.XDG_CONFIG_HOME;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "cursor",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        "CURSOR_CONFIG_DIR=",
      ]);
      // ...but the child deletes the key, so it files under the default
      // root where the id is stale, and the guard refuses.
      expect(out.exitCode).toBe(2);
      expect(out.stderr).toContain(`no cursor session ${id} found at`);
      expect(out.stderr).toContain(join(home, ".cursor", "chats"));
    } finally {
      restoreEnv(saved);
      for (const d of [home, cwd, cfg, binDir, hcnCfg]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

describe("N1: the guard reads home from the child's effective env", () => {
  test("--env HOME=<tmp> with a session under <tmp>/.cursor/chats is not refused", async () => {
    const childHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n1-home-")));
    const procHome = mkdtempSync(join(tmpdir(), "hcn-n1-prochome-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-n1-cwd-")));
    const binDir = mkdtempSync(join(tmpdir(), "hcn-n1-bin-"));
    const hcnCfg = mkdtempSync(join(tmpdir(), "hcn-n1-cfg-"));
    const calls = installStubAgent(binDir);
    const id = "44444444-4444-4333-8333-444444444444";
    fileCursorSession(childHome, cwd, id);
    const saved = saveEnv();
    process.env.HOME = procHome;
    process.env.HCN_CONFIG_DIR = hcnCfg;
    delete process.env.CURSOR_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    try {
      const out = await captureDispatch([
        "run",
        "cursor",
        "hi",
        "--resume",
        id,
        "--cwd",
        cwd,
        "--env",
        `HOME=${childHome}`,
      ]);
      expect(out.stderr).not.toContain(`no cursor session ${id} found at`);
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
