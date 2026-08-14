/**
 * streamTurn: the spawn-per-turn headless runner. Spawn, drain both stdio
 * streams concurrently, decode typed HarnessEvents, watchdog stalls (only
 * for none-granularity invocations - a structured stream proves its own
 * liveness), classify the exit, always end with `done` (spawn failures
 * included). Runtime primitives are injected (D-005); structured boundary
 * events (spawn/exit/stall, argv redacted by POSITION) are always-on
 * evidence, not diagnostics. An abandoned turn (consumer breaks early)
 * closes backpressure, disposes output, stops the child, and awaits both
 * pumps before it returns.
 */
import {
  buildLaunchArgv,
  buildResumeArgv,
  type LaunchOptions,
  streamingGranularityOf,
} from "../interpretation/argv.js";
import { stdinPolicyOf } from "../interpretation/dimensions.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { matcherOverridesOf } from "../knowledge/overrides.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { ExitCause, HarnessEvent } from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  failureFromAuth,
  failureFromLimit,
  failureFromRejected,
  failureFromTransport,
  reduceFailures,
} from "./failure.js";
import { LineBuffer } from "./lines.js";

/** Fallback correlation when the host does not mint turn ids: monotonic per
 * process. Hosts that need cross-process uniqueness pass deps.turnId. */
let turnCounter = 0;

/** SIGTERM -> SIGKILL escalation budget for a child that ignores the first
 * signal, and the grace allowed for pipes still held open (by a grandchild)
 * after the process itself exited. */
export const KILL_GRACE_MS = 5_000;
export const PIPE_GRACE_MS = 2_000;

const OUTPUT_STREAMS = ["stdout", "stderr"] as const;

const pumpFailureMessage = (stream: (typeof OUTPUT_STREAMS)[number], cause: unknown): string =>
  `${stream} pump failed: ${cause instanceof Error ? cause.message : String(cause)}`;

/** Stray secret-shaped tokens are masked; identifiers (session UUIDs, model
 * ids, paths) log verbatim - they are what the log exists to correlate. */
const SECRETISH = /(sk-[A-Za-z0-9_-]{8,}|(?:token|key|secret|password)=\S+)/i;

/** Redact by POSITION, not shape: the prompt is a known argv slot and is
 * masked wholesale (content never reaches a log line - v1 D-005); every
 * other token is kept unless it is secret-shaped. Only the prompt's
 * positional slot is masked, so a one-word prompt that equals a flag
 * value does not cause that flag value to be masked. */
export const redactArgv = (argv: readonly string[], prompt?: string): string[] => {
  const promptIndex = prompt !== undefined ? argv.lastIndexOf(prompt) : -1;
  const promptLabel = prompt !== undefined ? `[prompt:${prompt.length}ch]` : "";
  return argv.map((token, index) => {
    if (index === promptIndex) return promptLabel;
    if (SECRETISH.test(token)) return "[redacted]";
    return token;
  });
};

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
  /** Per-call environment, merged over parent; "" deletes. */
  readonly env?: Readonly<Record<string, string>>;
}

export async function* streamTurn(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const turnId = deps.turnId ?? `turn-${++turnCounter}`;
  const log = deps.log ?? (() => {});

  // Validate env before building argv so an invalid env is a refusal, not a spawn
  if (opts.env !== undefined) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k.includes("\0") || v.includes("\0")) {
        const refusal = new ArgvRefusalError({
          issue: "invalid-env",
          harness: h.name,
          supported: ["env keys must match /^[A-Za-z_][A-Za-z0-9_]*$/ and no NUL"],
          detail: k,
        });
        const failure = failureFromRejected({
          issue: refusal.issue,
          option: undefined,
          supported: refusal.supported,
          detail: k,
        });
        log({
          event: "rejected",
          turnId,
          harness: h.name,
          issue: refusal.issue,
          supported: refusal.supported,
          argv: redactArgv([], opts.prompt),
        });
        yield { kind: "failure", ...failure };
        yield { kind: "done", exitCode: null, cause: "failed", failure };
        return;
      }
    }
  }

  let argv: string[];
  let granularity: import("../knowledge/descriptor.js").StreamingGranularity;
  try {
    argv =
      opts.resume === undefined
        ? buildLaunchArgv(h, opts)
        : buildResumeArgv(h, { ...opts, sessionId: opts.resume });
    granularity = streamingGranularityOf(h, argv);
  } catch (e) {
    if (e instanceof ArgvRefusalError) {
      const failure = failureFromRejected({
        issue: e.issue,
        option: e.option,
        facet: e.facet,
        supported: e.supported,
        detail: e.message,
      });
      // No process spawned on a refusal - log rejected instead of spawn
      let argvForLog: string[] = [];
      try {
        argvForLog = redactArgv([], opts.prompt);
      } catch {}
      log({
        event: "rejected",
        turnId,
        harness: h.name,
        issue: e.issue,
        option: e.option,
        facet: e.facet,
        supported: e.supported,
        argv: argvForLog,
      });
      yield { kind: "failure", ...failure };
      yield { kind: "done", exitCode: null, cause: "failed", failure };
      return;
    }
    throw e;
  }

  const matcherOverrides = matcherOverridesOf.get(h);
  const envKeys = opts.env ? Object.keys(opts.env) : undefined;
  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv, opts.prompt),
    granularity,
    ...(matcherOverrides ? { matcherOverrides } : {}),
    ...(envKeys?.length ? { envKeys } : {}),
  });

  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(argv, {
      stdin: stdinPolicyOf(h) === "close-required" ? "close" : "inherit",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
  } catch (cause) {
    // Spawn failure is a transport failure, not merely a crash
    const message = cause instanceof Error ? cause.message : String(cause);
    const failure = failureFromTransport(`spawn failed: ${message}`);
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode: 127,
      cause: "crash",
      spawnError: message,
    });
    yield { kind: "error", message: `spawn failed: ${message}` };
    yield { kind: "failure", ...failure };
    yield { kind: "done", exitCode: 127, cause: "failed", failure };
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
  let terminalEventReached = false;

  const safeSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
    if (!exited) deps.signal(proc, sig);
  };
  let escalationTimer: number | null = null;
  const escalate = (): void => {
    if (exited || escalationTimer !== null) return;
    safeSignal("SIGTERM");
    escalationTimer = deps.clock.setTimeout(() => {
      escalationTimer = null;
      safeSignal("SIGKILL");
    }, KILL_GRACE_MS);
  };

  const failures: FailureSummary[] = [];
  const pushFailure = async (f: FailureSummary): Promise<void> => {
    failures.push(f);
    await queue.push({ kind: "failure", ...f });
  };

  let watchdog: number | null = null;
  let turnDeadline: number | null = null;
  let watchdogReason: "inactivity" | "turn-deadline" | null = null;
  const disarm = (): void => {
    if (watchdog !== null) deps.clock.clearTimeout(watchdog);
    watchdog = null;
    if (turnDeadline !== null) deps.clock.clearTimeout(turnDeadline);
    turnDeadline = null;
  };
  const rearm = (): void => {
    if (deps.stallMs === undefined) return;
    if (watchdog !== null) deps.clock.clearTimeout(watchdog);
    watchdog = deps.clock.setTimeout(() => {
      killedByWatchdog = true;
      watchdogReason = "inactivity";
      log({
        event: "stall",
        turnId,
        harness: h.name,
        reason: "inactivity",
        budgetMs: deps.stallMs,
      });
      // Disarm the other budget
      if (turnDeadline !== null) {
        deps.clock.clearTimeout(turnDeadline);
        turnDeadline = null;
      }
      escalate();
    }, deps.stallMs);
  };
  // Arm both budgets
  rearm();
  if (deps.turnTimeoutMs !== undefined) {
    turnDeadline = deps.clock.setTimeout(() => {
      killedByWatchdog = true;
      watchdogReason = "turn-deadline";
      log({
        event: "stall",
        turnId,
        harness: h.name,
        reason: "turn-deadline",
        budgetMs: deps.turnTimeoutMs,
      });
      if (watchdog !== null) {
        deps.clock.clearTimeout(watchdog);
        watchdog = null;
      }
      escalate();
    }, deps.turnTimeoutMs);
  }

  let pipeGrace: number | null = null;
  void proc.exited.then((code) => {
    exited = true;
    exitCode = code;
    if (escalationTimer !== null) deps.clock.clearTimeout(escalationTimer);
    escalationTimer = null;
    // The process is gone: the watchdog has nothing left to kill, and a
    // fire after this point would flip a completed turn to "stall".
    disarm();
    // Pipes held open past exit (a grandchild inherited the fd) must not
    // hang the turn forever - close out with the exit code in hand.
    if (cancelled) return;
    pipeGrace = deps.clock.setTimeout(() => {
      pipesOpenAtExit = true;
      proc.disposeOutput();
    }, PIPE_GRACE_MS);
  });

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stdout) {
      if (cancelled) break;
      // Any output chunk rearms the inactivity budget, but not the wall-clock deadline
      if (deps.stallMs !== undefined) rearm();
      for (const line of lines.push(chunk)) {
        for (const event of decodeLine(h, line, state, opts.model ?? "")) {
          if ((event as unknown as { kind: string }).kind === "failure") {
            // Directly from decode's rate_limit_event handling - track for reduction
            failures.push(event as unknown as FailureSummary);
          }
          await queue.push(event);
        }
      }
    }
    const rest = lines.flush();
    if (rest !== null && !cancelled) {
      for (const event of decodeLine(h, rest, state, opts.model ?? "")) {
        if ((event as unknown as { kind: string }).kind === "failure") {
          failures.push(event as unknown as FailureSummary);
        }
        await queue.push(event);
      }
    }
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      if (cancelled) break;
      if (deps.stallMs !== undefined) rearm();
      for (const line of lines.push(chunk)) {
        const limit = detectLimitInLine(h, line);
        if (limit !== null) {
          state.limitSeen = true;
          const failure = failureFromLimit(limit);
          // Emit both limit (for 0.1.3 compat) and failure
          await queue.push({
            kind: "limit",
            code: limit,
            message: `limit wall detected (${limit})`,
          });
          await pushFailure(failure);
          continue;
        }
        const auth = detectAuthFailureInLine(h, line);
        if (auth !== null) {
          const failure = failureFromAuth(auth);
          await pushFailure(failure);
          // Emit error alongside failure for 0.1.3 compat
          await queue.push({ kind: "error", message: `auth wall: ${auth}` });
          continue;
        }
        stderrTail.push(line);
      }
    }
  };

  const observePump = async (
    stream: (typeof OUTPUT_STREAMS)[number],
    pump: Promise<void>,
  ): Promise<void> => {
    try {
      await pump;
    } catch (cause) {
      log({
        event: "output_pump_failed",
        turnId,
        harness: h.name,
        stream,
        issue: "read-failed",
      });
      await queue.push({ kind: "error", message: pumpFailureMessage(stream, cause) });
      await pushFailure(failureFromTransport(pumpFailureMessage(stream, cause)));
      escalate();
      await proc.exited;
      proc.disposeOutput();
    }
  };
  const pumpSettlements = Promise.all([
    observePump("stdout", pumpStdout()),
    observePump("stderr", pumpStderr()),
  ]);
  void Promise.all([proc.exited, pumpSettlements]).then(() => queue.close());

  try {
    for await (const event of queue) yield event;

    // Post-queue failure sources: nonzero exit with no other failure is transport
    if (
      failures.length === 0 &&
      exitCode !== 0 &&
      exitCode !== null &&
      !killedByWatchdog &&
      !state.limitSeen
    ) {
      const f = failureFromTransport(`nonzero exit ${exitCode}`);
      failures.push(f);
      // Need to emit this failure before done, even though queue is closed
      yield { kind: "failure", ...f };
    }
    // Stall watchdog also implies a transport failure if not already present
    if (killedByWatchdog && failures.length === 0) {
      const f = failureFromTransport(`stalled: ${watchdogReason ?? "inactivity"}`);
      failures.push(f);
      yield { kind: "failure", ...f };
    }

    let cause: ExitCause = state.limitSeen
      ? "limit"
      : killedByWatchdog && exitCode !== 0
        ? "stall"
        : exitCode === 0
          ? "clean"
          : exitCode === null
            ? "killed"
            : "crash";
    const reduced = reduceFailures(failures);
    if (reduced && cause === "clean") cause = "failed";
    const tail = stderrTail.snapshot();
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode,
      cause,
      ...(pipesOpenAtExit ? { pipesOpenAtExit } : {}),
      ...(cause === "crash" || cause === "stall" || cause === "killed" || cause === "failed"
        ? { stderrTail: tail }
        : {}),
      ...(reduced ? { failure: reduced } : {}),
    });
    // A failure with captured stderr surfaces as a stream-level error, not
    // only in the exit log - so a crash from the real adapter's async spawn
    // failure carries the same error-event signal as the sync-throw path.
    if ((cause === "crash" || cause === "killed") && tail.length > 0) {
      yield { kind: "error", message: tail.join("\n").slice(0, 4096) };
    }
    terminalEventReached = true;
    yield { kind: "done", exitCode, cause, ...(reduced ? { failure: reduced } : {}) };
  } finally {
    const abandoned = !terminalEventReached;
    cancelled = true;
    queue.close();
    disarm();
    if (abandoned) {
      log({ event: "abandoned", turnId, harness: h.name });
      if (!exited) escalate();
    }
    proc.disposeOutput();
    const [settledExit] = await Promise.all([proc.exited, pumpSettlements]);
    exitCode = settledExit;
    if (pipeGrace !== null) deps.clock.clearTimeout(pipeGrace);
    pipeGrace = null;
    if (escalationTimer !== null) deps.clock.clearTimeout(escalationTimer);
    escalationTimer = null;
    if (abandoned) {
      log({
        event: "abandonment_settled",
        turnId,
        harness: h.name,
        exitCode,
        outputDisposed: true,
      });
    }
  }
}
