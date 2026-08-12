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
  let outputDisposed = false;
  let spawnError: Error | null = null;
  const spawnOutcome = new Promise<"spawned" | "failed">((resolve) => {
    child.once("spawn", () => resolve("spawned"));
    child.once("error", () => resolve("failed"));
  });
  // exited resolves via 'exit' (process died - fires even while a grandchild
  // holds the pipes open, unlike 'close') or 'error' (ENOENT etc., which
  // node reports async, not as a sync throw -> map to 127 crash). The error
  // handler sets spawnError before it resolves exited.
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(127);
    });
    child.on("exit", (code) => resolve(code));
  });
  // The spawn error rides the stderr stream so the runner's tail (and the
  // crash exit log) carry the explanation, matching the sync-throw path.
  // outputStream waits only for the spawn/error outcome when it sees a
  // premature close, so a genuine read failure on a live child propagates
  // immediately while an async ENOENT remains the single spawn-error signal.
  const outputStream = async function* (
    source: AsyncIterable<Uint8Array>,
  ): AsyncIterable<Uint8Array> {
    try {
      yield* source;
    } catch (cause) {
      if (outputDisposed) return;
      if (
        (cause as NodeJS.ErrnoException)?.code === "ERR_STREAM_PREMATURE_CLOSE" &&
        (await spawnOutcome) === "failed"
      ) {
        return;
      }
      throw cause;
    }
  };
  const stderrWithError = async function* (): AsyncIterable<string | Uint8Array> {
    if (child.stderr !== null) yield* outputStream(child.stderr as AsyncIterable<Uint8Array>);
    await exited;
    if (spawnError !== null) yield `spawn failed: ${(spawnError as Error).message}\n`;
  };
  const proc: SpawnedProcess = {
    stdout:
      child.stdout === null
        ? emptyStream()
        : outputStream(child.stdout as AsyncIterable<Uint8Array>),
    stderr: stderrWithError(),
    exited,
    disposeOutput: (): void => {
      outputDisposed = true;
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
