/**
 * streamTurn: the spawn-per-turn headless runner. Spawn, drain both stdio
 * streams concurrently, decode typed HarnessEvents, watchdog stalls (only
 * for none-granularity invocations - a structured stream proves its own
 * liveness), classify the exit, always end with `done`. Runtime primitives
 * are injected (D-005); structured boundary events (spawn/exit/stall, argv
 * redacted) are always-on evidence, not diagnostics.
 */
import {
  buildLaunchArgv,
  type LaunchOptions,
  streamingGranularityOf,
} from "../interpretation/argv.js";
import { stdinPolicyOf } from "../interpretation/dimensions.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { decodeLine, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SignalName } from "./deps.js";
import type { ExitCause, HarnessEvent } from "./events.js";
import { LineBuffer } from "./lines.js";

/** Deterministic turn correlation: monotonic per process, no wall clock. */
let turnCounter = 0;

/** Secret-shaped argv tokens never reach a log line: long token-ish runs,
 * key=value secrets, and anything over the prompt budget is masked. */
const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9+/_-]{32,}|(?:token|key|secret)=\S+)/i;

export const redactArgv = (argv: readonly string[]): string[] =>
  argv.map((token) => {
    if (SECRETISH.test(token)) return "[redacted]";
    if (token.length > 64) return `${token.slice(0, 61)}...`;
    return token;
  });

class EventQueue {
  private readonly items: HarnessEvent[] = [];
  private closed = false;
  private wake: (() => void) | null = null;

  push(event: HarnessEvent): void {
    this.items.push(event);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async next(): Promise<HarnessEvent | null> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) return item;
      if (this.closed) return null;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

export async function* streamTurn(
  h: HarnessDescriptor,
  opts: LaunchOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const turnId = `turn-${++turnCounter}`;
  const argv = buildLaunchArgv(h, opts);
  const granularity = streamingGranularityOf(h, argv);
  const log = deps.log ?? (() => {});

  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv),
    granularity,
  });

  const proc = deps.spawn(argv, {
    stdin: stdinPolicyOf(h) === "close-required" ? "close" : "inherit",
  });

  const queue = new EventQueue();
  const state = freshDecodeState();
  let killedByWatchdog = false;

  // Stall watchdog: only a none-granularity invocation needs one - the v1
  // scar was arming it for streams whose events prove liveness.
  let watchdog: number | null = null;
  const disarm = (): void => {
    if (watchdog !== null) deps.clock.clearTimeout(watchdog);
    watchdog = null;
  };
  const rearm = (): void => {
    if (granularity !== "none" || deps.stallMs === undefined) return;
    disarm();
    watchdog = deps.clock.setTimeout(() => {
      killedByWatchdog = true;
      log({ event: "stall", turnId, harness: h.name, stallMs: deps.stallMs });
      deps.signal(proc, "SIGTERM" satisfies SignalName);
    }, deps.stallMs);
  };
  rearm();

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stdout) {
      rearm();
      for (const line of lines.push(chunk)) {
        for (const event of decodeLine(h, line, state, opts.model ?? "")) queue.push(event);
      }
    }
    const rest = lines.flush();
    if (rest !== null) {
      for (const event of decodeLine(h, rest, state, opts.model ?? "")) queue.push(event);
    }
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      rearm();
      for (const line of lines.push(chunk)) {
        const limit = detectLimitInLine(h, line);
        if (limit !== null) {
          state.limitSeen = true;
          queue.push({ kind: "limit", code: limit, message: `limit wall detected (${limit})` });
          continue;
        }
        const auth = detectAuthFailureInLine(h, line);
        if (auth !== null) queue.push({ kind: "error", message: `auth wall: ${auth}` });
      }
    }
  };

  const run = (async (): Promise<{ exitCode: number | null }> => {
    const [exitCode] = await Promise.all([proc.exited, pumpStdout(), pumpStderr()]);
    return { exitCode };
  })();

  void run.then(
    () => queue.close(),
    () => queue.close(),
  );

  while (true) {
    const event = await queue.next();
    if (event === null) break;
    yield event;
  }

  const { exitCode } = await run;
  disarm();

  const cause: ExitCause = state.limitSeen
    ? "limit"
    : killedByWatchdog
      ? "stall"
      : exitCode === 0
        ? "clean"
        : exitCode === null
          ? "killed"
          : "crash";
  log({ event: "exit", turnId, harness: h.name, exitCode, cause });
  yield { kind: "done", exitCode, cause };
}
