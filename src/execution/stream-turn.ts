/**
 * streamTurn: the spawn-per-turn headless runner. Spawn, drain both stdio
 * streams concurrently, decode typed HarnessEvents, watchdog stalls (only
 * for none-granularity invocations - a structured stream proves its own
 * liveness), classify the exit, always end with `done` (spawn failures
 * included). Runtime primitives are injected (D-005); structured boundary
 * events (spawn/exit/stall, argv redacted by POSITION) are always-on
 * evidence, not diagnostics. An abandoned turn (consumer breaks early)
 * cleans up after itself: pumps stop, SIGTERM, SIGKILL after grace - the
 * child is never left running with nobody draining its stdout.
 */
import {
  buildLaunchArgv,
  buildResumeArgv,
  type LaunchOptions,
  streamingGranularityOf,
} from "../interpretation/argv.js";
import { stdinPolicyOf } from "../interpretation/dimensions.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { ExitCause, HarnessEvent } from "./events.js";
import { LineBuffer } from "./lines.js";

/** Fallback correlation when the host does not mint turn ids: monotonic per
 * process. Hosts that need cross-process uniqueness pass deps.turnId. */
let turnCounter = 0;

/** SIGTERM -> SIGKILL escalation budget for a child that ignores the first
 * signal, and the grace allowed for pipes still held open (by a grandchild)
 * after the process itself exited. */
export const KILL_GRACE_MS = 5_000;
export const PIPE_GRACE_MS = 2_000;

/** Stray secret-shaped tokens are masked; identifiers (session UUIDs, model
 * ids, paths) log verbatim - they are what the log exists to correlate. */
const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|(?:token|key|secret|password)=\S+)/i;

/** Redact by POSITION, not shape: the prompt is a known argv slot and is
 * masked wholesale (content never reaches a log line - v1 D-005); every
 * other token is kept unless it is secret-shaped. */
export const redactArgv = (argv: readonly string[], prompt?: string): string[] =>
  argv.map((token) => {
    if (prompt !== undefined && token === prompt) return `[prompt:${prompt.length}ch]`;
    if (SECRETISH.test(token)) return "[redacted]";
    return token;
  });

/** Bounded tail of unmatched stderr - the crash context a nonzero exit is
 * explained by (v1 kept the turn's output slice for exactly this). Shared
 * with the session runner. */
export class StderrTail {
  private readonly lines: string[] = [];
  private bytes = 0;
  push(line: string): void {
    this.lines.push(line);
    this.bytes += line.length;
    while (this.lines.length > 20 || (this.bytes > 4096 && this.lines.length > 1)) {
      const dropped = this.lines.shift();
      this.bytes -= dropped?.length ?? 0;
    }
  }
  snapshot(): readonly string[] {
    return [...this.lines];
  }
}

export interface TurnRunOptions extends LaunchOptions {
  /** Resume this session id instead of launching fresh - the turn spawns
   * with the descriptor's resume grammar, and identity decoding treats a
   * DIFFERENT announced id as a rotation anomaly. */
  readonly resume?: string;
  /** Working directory for the spawned harness. */
  readonly cwd?: string;
}

export async function* streamTurn(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const turnId = deps.turnId ?? `turn-${++turnCounter}`;
  const log = deps.log ?? (() => {});
  const argv =
    opts.resume === undefined
      ? buildLaunchArgv(h, opts)
      : buildResumeArgv(h, { ...opts, sessionId: opts.resume });
  const granularity = streamingGranularityOf(h, argv);

  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv, opts.prompt),
    granularity,
  });

  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(argv, {
      stdin: stdinPolicyOf(h) === "close-required" ? "close" : "inherit",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  } catch (cause) {
    // A spawn that cannot start still honors the contract: error, done,
    // and a closed exit log - never a throw out of the first next().
    const message = cause instanceof Error ? cause.message : String(cause);
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode: 127,
      cause: "crash",
      spawnError: message,
    });
    yield { kind: "error", message: `spawn failed: ${message}` };
    yield { kind: "done", exitCode: 127, cause: "crash" };
    return;
  }

  const queue = new AsyncChannel<HarnessEvent>();
  const state = freshDecodeState(opts.resume ?? null);
  const stderrTail = new StderrTail();
  let killedByWatchdog = false;
  let exited = false;
  let exitCode: number | null = null;
  let pipesOpenAtExit = false;
  let cancelled = false;

  const safeSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
    if (!exited) deps.signal(proc, sig);
  };
  const escalate = (): void => {
    safeSignal("SIGTERM");
    deps.clock.setTimeout(() => safeSignal("SIGKILL"), KILL_GRACE_MS);
  };

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
      escalate();
    }, deps.stallMs);
  };
  rearm();

  let pipeGrace: number | null = null;
  void proc.exited.then((code) => {
    exited = true;
    exitCode = code;
    // The process is gone: the watchdog has nothing left to kill, and a
    // fire after this point would flip a completed turn to "stall".
    disarm();
    // Pipes held open past exit (a grandchild inherited the fd) must not
    // hang the turn forever - close out with the exit code in hand.
    pipeGrace = deps.clock.setTimeout(() => {
      pipesOpenAtExit = true;
      queue.close();
    }, PIPE_GRACE_MS);
  });

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stdout) {
      if (cancelled) break;
      rearm();
      for (const line of lines.push(chunk)) {
        for (const event of decodeLine(h, line, state, opts.model ?? "")) {
          await queue.push(event);
        }
      }
    }
    const rest = lines.flush();
    if (rest !== null && !cancelled) {
      for (const event of decodeLine(h, rest, state, opts.model ?? "")) await queue.push(event);
    }
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      if (cancelled) break;
      rearm();
      for (const line of lines.push(chunk)) {
        const limit = detectLimitInLine(h, line);
        if (limit !== null) {
          state.limitSeen = true;
          await queue.push({
            kind: "limit",
            code: limit,
            message: `limit wall detected (${limit})`,
          });
          continue;
        }
        const auth = detectAuthFailureInLine(h, line);
        if (auth !== null) {
          await queue.push({ kind: "error", message: `auth wall: ${auth}` });
          continue;
        }
        stderrTail.push(line);
      }
    }
  };

  void Promise.allSettled([proc.exited, pumpStdout(), pumpStderr()]).then(() => queue.close());

  try {
    for await (const event of queue) yield event;

    const cause: ExitCause = state.limitSeen
      ? "limit"
      : killedByWatchdog && exitCode !== 0
        ? "stall"
        : exitCode === 0
          ? "clean"
          : exitCode === null
            ? "killed"
            : "crash";
    const tail = stderrTail.snapshot();
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode,
      cause,
      ...(pipesOpenAtExit ? { pipesOpenAtExit } : {}),
      ...(cause === "crash" || cause === "stall" || cause === "killed" ? { stderrTail: tail } : {}),
    });
    // A failure with captured stderr surfaces as a stream-level error, not
    // only in the exit log - so a crash from the real adapter's async spawn
    // failure carries the same error-event signal as the sync-throw path.
    if ((cause === "crash" || cause === "killed") && tail.length > 0) {
      yield { kind: "error", message: tail.join("\n").slice(0, 4096) };
    }
    yield { kind: "done", exitCode, cause };
  } finally {
    cancelled = true;
    queue.close();
    disarm();
    if (pipeGrace !== null) deps.clock.clearTimeout(pipeGrace);
    if (!exited) {
      // Abandoned mid-turn: never leave the child running with nobody
      // draining its stdout - and never RETURN until it is actually gone,
      // or an immediate resume of the same session races a live writer.
      log({ event: "abandoned", turnId, harness: h.name });
      escalate();
      await proc.exited; // bounded: SIGKILL after KILL_GRACE_MS cannot be ignored
    }
  }
}
