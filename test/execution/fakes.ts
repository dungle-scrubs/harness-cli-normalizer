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
  readonly stdinLines: string[] = [];
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  /** Set by the spawner from opts.stdin - only "pipe" opens a writable. */
  stdinPiped = true;
  private readonly exitOnStdinEnd: boolean;
  private readonly stdinPipe = {
    write: (data: string): void => {
      if (this.stdinEnded) throw new Error("write after end");
      this.stdinWrites.push(data);
      for (const line of data.split("\n")) {
        if (line.trim() !== "") this.stdinLines.push(line);
      }
    },
    end: (): void => {
      this.stdinEnded = true;
      // Opt-in: a cooperative harness exits cleanly on stdin EOF (A-001);
      // the default models a child that keeps running, so close-grace
      // escalation paths stay expressible.
      if (this.exitOnStdinEnd) this.exit(0);
    },
  };
  get stdin(): SpawnedProcess["stdin"] {
    return this.stdinPiped ? this.stdinPipe : undefined;
  }
  private exitResolve!: (code: number | null) => void;

  constructor(options: { exitOnStdinEnd?: boolean } = {}) {
    this.exitOnStdinEnd = options.exitOnStdinEnd ?? true;
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
  /** Exit while a grandchild keeps the pipes open (the pipes-open case). */
  exitWithoutClosing(code: number | null): void {
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
    // The fake honors the requested stdin mode - it must not hand a
    // writable to a spawn that never asked for a pipe.
    proc.stdinPiped = opts.stdin === "pipe";
    calls.push({ argv, opts, proc });
    return proc;
  };
  return { spawn, calls };
};

/** Records signals; by default a SIGTERM makes the fake process die (the
 * cooperative child). Pass {autoExit: false} to model a wedged child that
 * ignores SIGTERM, so escalation paths are expressible. */
export const fakeSignal = (options: { autoExit?: boolean } = {}) => {
  const autoExit = options.autoExit ?? true;
  const sent: Array<{ proc: SpawnedProcess; sig: SignalName }> = [];
  return {
    signal: (proc: SpawnedProcess, sig: SignalName): void => {
      sent.push({ proc, sig });
      if (autoExit || sig === "SIGKILL") (proc as FakeProcess).exit(null);
    },
    sent,
  };
};
