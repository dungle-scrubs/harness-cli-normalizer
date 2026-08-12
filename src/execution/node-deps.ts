/**
 * The real runtime adapter for RunnerDeps: node:child_process spawn (Bun
 * implements the same module, so this is the Node AND Bun adapter), wall
 * clock, and process signalling. This is the ONE module where the injected
 * primitives touch the operating system - everything above it stays pure
 * and fake-driven. Kills go to the exact child handle this adapter
 * spawned, never to a pid pattern.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Clock, RunnerDeps, SpawnedProcess, SpawnOptions } from "./deps.js";

const children = new WeakMap<SpawnedProcess, ChildProcess>();

const emptyStream = async function* (): AsyncIterable<Uint8Array> {};

type SpawnOutcome = "spawned" | "failed";

/** Normalize only errors created by this adapter's own terminal operations.
 * Identity comparison keeps an unrelated read failure visible even when it
 * settles after output disposal has started. */
const normalizeOutputStream = async function* (
  source: AsyncIterable<Uint8Array>,
  disposalCause: Error,
  spawnOutcome: Promise<SpawnOutcome>,
): AsyncIterable<Uint8Array> {
  try {
    yield* source;
  } catch (cause) {
    if (cause === disposalCause) return;
    if (
      (cause as NodeJS.ErrnoException)?.code === "ERR_STREAM_PREMATURE_CLOSE" &&
      (await spawnOutcome) === "failed"
    ) {
      return;
    }
    throw cause;
  }
};

/** Request terminal disposal without discarding chunks already buffered by
 * the runtime. Once the consumer reaches the first pending read, destruction
 * settles that read with this adapter's unique disposal cause. */
export const disposableOutputStream = (
  source: Readable,
  disposalCause: Error,
  spawnOutcome: Promise<SpawnOutcome>,
): { readonly stream: AsyncIterable<Uint8Array>; dispose(): void } => {
  let disposalRequested = false;
  let readPending = false;

  const destroyPendingRead = (): void => {
    if (disposalRequested && readPending && source.readableLength === 0 && !source.destroyed) {
      source.destroy(disposalCause);
    }
  };
  const drainBeforeDisposal = async function* (): AsyncIterable<Uint8Array> {
    const iterator = source[Symbol.asyncIterator]();
    while (true) {
      readPending = true;
      if (disposalRequested && source.readableLength === 0 && !source.destroyed) {
        source.destroy(disposalCause);
      }
      let next: IteratorResult<unknown>;
      try {
        next = await iterator.next();
      } finally {
        readPending = false;
      }
      if (next.done) return;
      yield next.value as Uint8Array;
    }
  };

  return {
    stream: normalizeOutputStream(drainBeforeDisposal(), disposalCause, spawnOutcome),
    dispose: (): void => {
      if (disposalRequested) return;
      disposalRequested = true;
      destroyPendingRead();
    },
  };
};

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
  const stdoutDisposalCause = new Error("stdout disposed by runner");
  const stderrDisposalCause = new Error("stderr disposed by runner");
  let spawnError: Error | null = null;
  const spawnOutcome = new Promise<SpawnOutcome>((resolve) => {
    child.once("spawn", () => resolve("spawned"));
    child.once("error", () => resolve("failed"));
  });
  const stdoutOutput =
    child.stdout === null
      ? null
      : disposableOutputStream(child.stdout, stdoutDisposalCause, spawnOutcome);
  const stderrOutput =
    child.stderr === null
      ? null
      : disposableOutputStream(child.stderr, stderrDisposalCause, spawnOutcome);
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
  // normalizeOutputStream waits only for the spawn/error outcome when it sees a
  // premature close, so a genuine read failure on a live child propagates
  // immediately while an async ENOENT remains the single spawn-error signal.
  const stderrWithError = async function* (): AsyncIterable<string | Uint8Array> {
    if (stderrOutput !== null) yield* stderrOutput.stream;
    await exited;
    if (spawnError !== null) yield `spawn failed: ${(spawnError as Error).message}\n`;
  };
  const proc: SpawnedProcess = {
    stdout: stdoutOutput === null ? emptyStream() : stdoutOutput.stream,
    stderr: stderrWithError(),
    exited,
    disposeOutput: (): void => {
      if (outputDisposed) return;
      outputDisposed = true;
      stdoutOutput?.dispose();
      stderrOutput?.dispose();
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
