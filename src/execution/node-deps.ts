/**
 * The real runtime adapter for RunnerDeps: node:child_process spawn (Bun
 * implements the same module, so this is the Node AND Bun adapter), wall
 * clock, and process signalling. This is the ONE module where the injected
 * primitives touch the operating system - everything above it stays pure
 * and fake-driven. Kills go to the exact child handle this adapter
 * spawned, never to a pid pattern.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Clock, RunnerDeps, SpawnedProcess, SpawnOptions } from "./deps.js";

const children = new WeakMap<SpawnedProcess, ChildProcess>();

const emptyStream = async function* (): AsyncIterable<Uint8Array> {};

const realSpawn = (argv: readonly string[], opts: SpawnOptions): SpawnedProcess => {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new Error("empty argv");
  const child = nodeSpawn(bin, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdio: [
      opts.stdin === "pipe" ? "pipe" : opts.stdin === "close" ? "ignore" : "inherit",
      "pipe",
      "pipe",
    ],
  });
  let spawnError: Error | null = null;
  // exited resolves via 'exit' (process died - fires even while a grandchild
  // holds the pipes open, unlike 'close') or 'error' (ENOENT etc., which
  // node reports async, not as a sync throw -> map to 127 crash). The error
  // handler is registered FIRST so spawnError is set before exited resolves.
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(127);
    });
    child.on("exit", (code) => resolve(code));
  });
  // The spawn error rides the stderr stream so the runner's tail (and the
  // crash exit log) carry the explanation, matching the sync-throw path.
  // Awaiting `exited` first closes the race where the empty stderr pipe ends
  // before node's async 'error' event has fired.
  const stderrWithError = async function* (): AsyncIterable<string | Uint8Array> {
    try {
      if (child.stderr !== null) yield* child.stderr as AsyncIterable<Uint8Array>;
    } catch (cause) {
      // A failed spawn closes the stderr pipe prematurely
      // (ERR_STREAM_PREMATURE_CLOSE); that is not fatal - the spawn error
      // below is the signal that matters. Any OTHER read error is genuine
      // and propagates (the tail captured so far is already preserved).
      if ((cause as NodeJS.ErrnoException)?.code !== "ERR_STREAM_PREMATURE_CLOSE") throw cause;
    }
    await exited;
    if (spawnError !== null) yield `spawn failed: ${(spawnError as Error).message}\n`;
  };
  const proc: SpawnedProcess = {
    stdout: (child.stdout ?? emptyStream()) as AsyncIterable<Uint8Array>,
    stderr: stderrWithError(),
    exited,
    disposeOutput: (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    ...(opts.stdin === "pipe" && child.stdin !== null
      ? {
          stdin: {
            write: (data: string): void => {
              child.stdin?.write(data);
            },
            end: (): void => {
              child.stdin?.end();
            },
          },
        }
      : {}),
  };
  children.set(proc, child);
  return proc;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

export const nodeRunnerDeps = (extra?: Partial<RunnerDeps>): RunnerDeps => ({
  spawn: realSpawn,
  clock: realClock,
  signal: (proc, sig) => {
    children.get(proc)?.kill(sig);
  },
  ...extra,
});
