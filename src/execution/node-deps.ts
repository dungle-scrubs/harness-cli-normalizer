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
  child.on("error", (err) => {
    spawnError = err;
  });
  // The spawn error rides the stderr stream so the runner's tail (and the
  // crash exit log) carry the explanation, matching the sync-throw path.
  const stderrWithError = async function* (): AsyncIterable<string | Uint8Array> {
    if (child.stderr !== null) yield* child.stderr as AsyncIterable<Uint8Array>;
    if (spawnError !== null) yield `spawn failed: ${(spawnError as Error).message}\n`;
  };
  const proc: SpawnedProcess = {
    stdout: (child.stdout ?? emptyStream()) as AsyncIterable<Uint8Array>,
    stderr: stderrWithError(),
    exited: new Promise((resolve) => {
      // 'exit' fires when the PROCESS dies even while a grandchild holds
      // the stdio pipes open ('close' would wait for them) - the runners'
      // pipe-grace handling depends on learning about the exit promptly.
      child.on("exit", (code) => resolve(code));
      // Node reports an unspawnable binary (ENOENT) as an async 'error'
      // event, not a synchronous throw - map it to the spawn-failure exit
      // code so the runner classifies crash, never "killed".
      child.on("error", () => resolve(127));
    }),
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
