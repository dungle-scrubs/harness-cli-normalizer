/**
 * Built-CLI fixture for the Cursor SDK backend (issue #440): spawns
 * dist/cli.js with the scripted fake SDK loaded into the worker through a
 * test-only module loader (NODE_OPTIONS --import), so run and session are
 * exercised end to end - the real argv builders, the real worker wire,
 * the real runners - with no network, credentials, or billed runs.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { ensureDist } from "./stub-dist.js";

const FIXTURE_DIR = fileURLToPath(new URL("./cursor-sdk-fake", import.meta.url));

export interface FakeSdkScript {
  readonly agentId?: string;
  readonly openDelayMs?: number;
  readonly openError?: { readonly name: string; readonly message: string } | null;
  readonly resumeError?: { readonly name: string; readonly message: string } | null;
  readonly catalog?: readonly unknown[];
  /** When set, Cursor.models.list throws this instead of listing. */
  readonly catalogError?: { readonly name: string; readonly message: string } | null;
  readonly sends?: readonly unknown[];
}

/** Write input after an observed output boundary. */
export interface FakeSdkInputChunk {
  readonly text: string;
  /** Write this chunk only after stdout has contained this text. */
  readonly waitFor?: string;
  readonly occurrences?: number;
}

export interface FakeSdkRun {
  /** The spawned CLI's stdout (NDJSON lines). */
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  /** The recorded SDK calls: one JSON line per Agent.create/resume/send. */
  readonly calls: ReadonlyArray<Record<string, unknown>>;
  readonly root: string;
  cleanup(): void;
}

export interface FakeSdkSpawn {
  readonly script: FakeSdkScript;
  readonly args: readonly string[];
  /** stdin fed to the CLI, in timed chunks (session command NDJSON). */
  readonly input?: readonly FakeSdkInputChunk[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly cliPath?: string;
}

const nodeExecutable = (): string => {
  const executable = process.execPath;
  return executable.includes("node") ? executable : "node";
};

const bunExecutable = (): string => "bun";

/** One scripted CLI run. `runtime` picks the process that runs the CLI
 * itself; the worker always runs under node either way (the spawn adapter
 * selects it), which is also what keeps the module loader path identical
 * across lanes. */
export const runCliWithFakeSdk = async (
  request: FakeSdkSpawn,
  runtime: "node" | "bun" = "node",
): Promise<FakeSdkRun> => {
  const dist = request.cliPath ?? ensureDist();
  const root = mkdtempSync(join(cliFixtureTmpdir(), "hcn-cursor-sdk-cli-"));
  const scriptPath = join(root, "script.json");
  const recordPath = join(root, "calls.ndjson");
  writeFileSync(scriptPath, JSON.stringify(request.script));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // The loader must ride NODE_OPTIONS so the worker child (spawned by the
  // CLI itself, under node) swaps the SDK module. An existing NODE_OPTIONS
  // prefix is preserved.
  const registerPath = join(FIXTURE_DIR, "register.mjs");
  env.NODE_OPTIONS = `--import ${JSON.stringify(registerPath)}${env.NODE_OPTIONS ? ` ${env.NODE_OPTIONS}` : ""}`;
  env.HCN_TEST_CURSOR_SDK_SCRIPT = scriptPath;
  env.HCN_TEST_CURSOR_SDK_RECORD = recordPath;
  env.HOME = root;
  env.USERPROFILE = root;
  env.XDG_CONFIG_HOME = join(root, "config");
  env.XDG_STATE_HOME = join(root, "state");
  env.XDG_DATA_HOME = join(root, "data");
  env.CURSOR_CONFIG_DIR = join(root, "cursor");
  env.HCN_CONFIG_DIR = join(root, "hcn-config");
  env.HCN_STATE_DIR = join(root, "hcn-state");
  env.HCN_OBSERVER = "";
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const nativeCli = join(binDir, "agent");
  writeFileSync(
    nativeCli,
    '#!/bin/sh\nprintf "unexpected native Cursor CLI execution\\n" >&2\nexit 98\n',
  );
  chmodSync(nativeCli, 0o755);
  env.PATH = `${binDir}:${env.PATH ?? "/usr/bin:/bin"}`;
  delete env.HERDR_ENV;
  const bin = runtime === "bun" ? bunExecutable() : nodeExecutable();
  const child = spawn(bin, [dist, ...request.args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: request.cwd ?? root,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const waitForOutput = (text: string, occurrences: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const matched = () => stdout.split(text).length - 1 >= occurrences;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout?.off("data", observe);
        child.off("exit", stopped);
        if (error) reject(error);
        else resolve();
      };
      const observe = () => {
        if (matched()) finish();
      };
      const stopped = () => finish(new Error(`CLI exited before output ${text}`));
      const timer = setTimeout(
        () => finish(new Error(`CLI did not emit output ${text}`)),
        request.timeoutMs ?? 30_000,
      );
      child.stdout?.on("data", observe);
      child.once("exit", stopped);
      if (matched()) finish();
      else if (child.exitCode !== null || child.signalCode !== null) stopped();
    });
  const status = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, request.timeoutMs ?? 30_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    void (async () => {
      for (const chunk of request.input ?? []) {
        if (chunk.waitFor !== undefined) {
          await waitForOutput(chunk.waitFor, chunk.occurrences ?? 1);
        }
        if (child.stdin === null) return;
        child.stdin.write(chunk.text);
      }
      child.stdin?.end();
    })().catch(() => {
      child.kill("SIGKILL");
    });
  });
  let calls: ReadonlyArray<Record<string, unknown>> = [];
  try {
    calls = readFileSync(recordPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    calls = [];
  }
  return {
    stdout,
    stderr,
    status,
    calls,
    root,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
};

/** Parse a CLI stdout of NDJSON lines into records. */
export const ndjsonOf = (stdout: string): ReadonlyArray<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** One send entry a simple scripted turn needs. */
export const sendOf = (entry: {
  readonly events?: readonly unknown[];
  readonly status?: string;
  readonly busy?: boolean;
  readonly holdOpen?: boolean;
  readonly error?: { readonly message: string; readonly code?: string } | null;
  readonly message?: string;
  readonly errorName?: string;
}): unknown => ({
  ...(entry.busy === undefined ? {} : { busy: entry.busy }),
  ...(entry.events === undefined ? {} : { events: entry.events }),
  ...(entry.status === undefined ? {} : { status: entry.status }),
  ...(entry.holdOpen === undefined ? {} : { holdOpen: entry.holdOpen }),
  ...(entry.error === undefined ? {} : { error: entry.error }),
  ...(entry.message === undefined ? {} : { message: entry.message }),
  ...(entry.errorName === undefined ? {} : { errorName: entry.errorName }),
});

/** Session NDJSON command chunks. */
export const command = (value: unknown): string => `${JSON.stringify(value)}\n`;
