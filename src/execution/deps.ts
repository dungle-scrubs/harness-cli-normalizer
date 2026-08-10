/**
 * Injected runtime primitives (D-005): the execution layer never imports
 * child_process, never calls process.kill, and never reads a wall clock -
 * spawn, clock, and signalling arrive as data so Node/Bun is a real
 * portability boundary and tests run against fakes deterministically.
 */

export interface SpawnedProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  /** Resolves with the exit code, or null when the process died to a
   * signal without one. */
  readonly exited: Promise<number | null>;
  /** Present when the spawner opened a writable stdin (session mode needs
   * it; one-shot turns close or inherit stdin instead). */
  readonly stdin?: {
    write(data: string): void;
    end(): void;
  };
}

export interface SpawnOptions {
  readonly cwd?: string;
  /** `pipe` opens a writable stdin (sessions require it); `inherit` hands
   * the child the parent's fd 0; `close` gives it nothing (pi's rule). */
  readonly stdin: "inherit" | "close" | "pipe";
}

export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type SignalName = "SIGTERM" | "SIGKILL";

/** One structured line per boundary transition - spawn, exit, stall,
 * redacted argv. Always-on baseline evidence; the host decides where it
 * goes. */
export type BoundaryLog = (event: Record<string, unknown>) => void;

export interface RunnerDeps {
  readonly spawn: (argv: readonly string[], opts: SpawnOptions) => SpawnedProcess;
  readonly clock: Clock;
  readonly signal: (proc: SpawnedProcess, sig: SignalName) => void;
  /** Stall watchdog budget; armed ONLY for none-granularity invocations. */
  readonly stallMs?: number;
  readonly log?: BoundaryLog;
  /** Host-minted correlation id; without it the runner falls back to a
   * per-process monotonic counter (collides across processes). */
  readonly turnId?: string;
}
