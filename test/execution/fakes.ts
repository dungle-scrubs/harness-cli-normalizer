/**
 * Deterministic fakes for the injected runtime primitives. The fake process
 * exposes push/close so tests script stdout/stderr chunk by chunk - torn
 * lines included; the fake clock advances only when told.
 */
import type {
  Clock,
  SignalName,
  SpawnedProcess,
  SpawnOptions,
  TimerHandle,
} from "../../src/execution/deps.js";

class Channel implements AsyncIterable<string> {
  private readonly chunks: string[] = [];
  private closed = false;
  private wake: (() => void) | null = null;

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.chunks.length > 0) {
        const chunk = this.chunks.shift();
        if (chunk !== undefined) yield chunk;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

export class FakeProcess implements SpawnedProcess {
  readonly stdout = new Channel();
  readonly stderr = new Channel();
  readonly exited: Promise<number | null>;
  readonly signals: SignalName[] = [];
  private exitResolve!: (code: number | null) => void;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /** Script helpers: emit lines, then exit. */
  emitLine(line: string): void {
    this.stdout.push(`${line}\n`);
  }
  emitChunk(chunk: string): void {
    this.stdout.push(chunk);
  }
  emitStderr(line: string): void {
    this.stderr.push(`${line}\n`);
  }
  exit(code: number | null): void {
    this.stdout.close();
    this.stderr.close();
    this.exitResolve(code);
  }
}

export class FakeClock implements Clock {
  private time = 0;
  private nextHandle = 1;
  private readonly timers = new Map<TimerHandle, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.time + ms, fn });
    return handle;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(handle);
        timer.fn();
      }
    }
  }
}

export interface FakeSpawnRecord {
  readonly argv: readonly string[];
  readonly opts: SpawnOptions;
  readonly proc: FakeProcess;
}

/** A spawner serving pre-created fake processes in order, recording calls. */
export const fakeSpawner = (procs: FakeProcess[]) => {
  const calls: FakeSpawnRecord[] = [];
  const spawn = (argv: readonly string[], opts: SpawnOptions): SpawnedProcess => {
    const proc = procs.shift();
    if (proc === undefined) throw new Error("fakeSpawner: no process scripted for this spawn");
    calls.push({ argv, opts, proc });
    return proc;
  };
  return { spawn, calls };
};

export const fakeSignal = () => {
  const sent: Array<{ proc: SpawnedProcess; sig: SignalName }> = [];
  return {
    signal: (proc: SpawnedProcess, sig: SignalName): void => {
      sent.push({ proc, sig });
      (proc as FakeProcess).exit(null);
    },
    sent,
  };
};
