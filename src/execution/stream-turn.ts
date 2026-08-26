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
  buildTurnEnv,
  type LaunchOptions,
  streamingGranularityOf,
} from "../interpretation/argv.js";
import { stdinPolicyOf } from "../interpretation/dimensions.js";
import {
  detectAuthFailureInLine,
  detectLimitInLine,
  detectTransportInLine,
  detectUnavailableInLine,
} from "../interpretation/limits.js";
import {
  composeEscalatedPrompt,
  detectQuestionBlock,
  type QuestionMode,
} from "../interpretation/question.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { matcherOverridesOf } from "../knowledge/overrides.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { EscalationDetection, ExitCause, HarnessEvent } from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  failureFromAuth,
  failureFromLimit,
  failureFromNative,
  failureFromRejected,
  failureFromTask,
  failureFromTerminalError,
  failureFromTimeout,
  failureFromTransport,
  failureFromUnavailable,
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
  /** D6 passthrough: raw harness tokens appended verbatim after the
   * normalized argv. Wrong-harness flags here fail in the harness itself
   * and surface as native errors - hcn never validates them. */
  readonly passthrough?: readonly string[];
  /** question mode: which preamble to inject (ask/assume/none).
   * Behavior instruction - never a harness flag. Defaults to "ask". */
  readonly questions?: QuestionMode;
  /** F-05: caller-requested stop. When aborted, the runner escalates
   * SIGTERM then SIGKILL and classifies the exit as killed with no
   * transport failure for the kill itself. */
  readonly signal?: AbortSignal;
}

export async function* streamTurn(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const turnId = deps.turnId ?? `turn-${++turnCounter}`;
  const log = deps.log ?? (() => {});

  // compose the preamble onto the prompt based on question mode.
  const questionMode: QuestionMode = opts.questions ?? "ask";
  const effective: TurnRunOptions = {
    ...opts,
    prompt: composeEscalatedPrompt(opts.prompt, questionMode),
  };
  // The turn's last assistant message - where the protocol says the
  // hcn-question block lives. Tracked only when detection is armed.
  let lastAssistantText: string | null = null;
  let asked = false;
  let escalationDetection: EscalationDetection = "none";

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
          argv: redactArgv([], effective.prompt),
        });
        yield { kind: "failure", ...failure };
        yield {
          kind: "done",
          exitCode: null,
          cause: "failed",
          failure,
          escalation: { mode: questionMode, detection: "none" },
        };
        return;
      }
    }
  }

  let argv: string[];
  let granularity: import("../knowledge/descriptor.js").StreamingGranularity;
  try {
    argv =
      effective.resume === undefined
        ? buildLaunchArgv(h, effective)
        : buildResumeArgv(h, { ...effective, sessionId: effective.resume });
    if (effective.passthrough !== undefined && effective.passthrough.length > 0) {
      argv = [...argv, "--", ...effective.passthrough];
    }
    // issue #38: claude/codex render the skills allowlist as complement-off
    // tokens at the argv tail (claude: settings JSON; codex: -c skills.config).
    const skillTokens = (opts as unknown as { __skillTokens?: string[] }).__skillTokens;
    if (skillTokens !== undefined && skillTokens.length > 0) {
      argv = [...argv, ...skillTokens];
    }
    granularity = streamingGranularityOf(h, argv);
  } catch (e) {
    if (e instanceof ArgvRefusalError) {
      const failure = failureFromRejected({
        issue: e.issue,
        option: e.option,
        facet: e.facet,
        supported: e.supported,
        supportedBy: e.supportedBy,
        hint: e.hint,
        detail: e.message,
      });
      // No process spawned on a refusal - log rejected instead of spawn
      let argvForLog: string[] = [];
      try {
        argvForLog = redactArgv([], effective.prompt);
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
      yield {
        kind: "done",
        exitCode: null,
        cause: "failed",
        failure,
        escalation: { mode: questionMode, detection: "none" },
      };
      return;
    }
    throw e;
  }

  // Descriptor-derived spawn env (claude's memory disable) merged OVER the
  // caller's per-call env: an explicit normalized option beats a raw
  // contradicting variable. Dropped keys ("" values) stay meaningful - only
  // the caller's side can delete, the descriptor side only sets.
  const turnEnv = buildTurnEnv(h, effective, effective.resume === undefined ? "launch" : "resume");
  const mergedEnv: Record<string, string> = { ...(opts.env ?? {}), ...turnEnv };

  const matcherOverrides = matcherOverridesOf.get(h);
  const envKeys = Object.keys(mergedEnv).length > 0 ? Object.keys(mergedEnv) : undefined;
  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv, effective.prompt),
    granularity,
    ...(matcherOverrides ? { matcherOverrides } : {}),
    ...(envKeys?.length ? { envKeys } : {}),
  });

  // F-23: create-on-missing resume warns before spawn - the harness will
  // accept any id and silently start a blank session, so the consumer
  // must verify the id exists.
  const resumeOnMissingCreate = effective.resume !== undefined && h.resume.onMissing === "create";
  const resumeCreateWarning = resumeOnMissingCreate
    ? `${h.name} creates a new session when ${effective.resume} is unknown; verify the id exists`
    : null;

  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(argv, {
      stdin: stdinPolicyOf(h) === "close-required" ? "close" : "inherit",
      ...(effective.cwd !== undefined ? { cwd: effective.cwd } : {}),
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
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
    if (resumeCreateWarning !== null) yield { kind: "error", message: resumeCreateWarning };
    yield { kind: "error", message: `spawn failed: ${message}` };
    yield { kind: "failure", ...failure };
    yield {
      kind: "done",
      exitCode: 127,
      cause: "failed",
      failure,
      escalation: { mode: questionMode, detection: "none" },
    };
    return;
  }

  const queue = new AsyncChannel<HarnessEvent>();
  // F-23 warning is an early stream event, before any harness output
  if (resumeCreateWarning !== null)
    void queue.push({ kind: "error", message: resumeCreateWarning });
  const state = freshDecodeState(effective.resume ?? null);
  const stderrTail = new StderrTail();
  let killedByWatchdog = false;
  let killedByAbort = false;
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
  let abortHandler: (() => void) | null = null;
  if (opts.signal) {
    const onAbort = (): void => {
      if (killedByAbort) return;
      killedByAbort = true;
      escalate();
    };
    if (opts.signal.aborted) {
      killedByAbort = true;
      escalate();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      abortHandler = onAbort;
    }
  }

  const failures: FailureSummary[] = [];
  const pushFailure = async (f: FailureSummary): Promise<void> => {
    // Suppress a failure identical in class and message to the previous one
    const prev = failures[failures.length - 1];
    if (prev !== undefined && prev.class === f.class && prev.message === f.message) return;
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
    let identitySeen = false;
    const droppableBuffer: HarnessEvent[] = [];
    const BUFFER_CAP = 256;
    const isDroppable = (kind: string): boolean =>
      kind === "progress" || kind === "token" || kind === "context";
    const flushDroppable = async (): Promise<void> => {
      for (const e of droppableBuffer) await queue.push(e);
      droppableBuffer.length = 0;
    };
    const handleEvent = async (event: HarnessEvent): Promise<void> => {
      if (!identitySeen) {
        if (event.kind === "identity") {
          identitySeen = true;
          await queue.push(event);
          await flushDroppable();
          return;
        }
        if (isDroppable(event.kind)) {
          if (droppableBuffer.length >= BUFFER_CAP) droppableBuffer.shift();
          droppableBuffer.push(event);
          return;
        }
        // Lossless events other than identity flush the buffer before themselves
        await flushDroppable();
      }
      if (event.kind === "failure") {
        const { kind: _kind, ...summary } = event;
        await pushFailure(summary);
        return;
      }
      if (event.kind === "limit") {
        // A wall decoded from stdout counts like one read on stderr: the
        // turn's done must carry it, not only the limit event.
        await queue.push(event);
        await pushFailure(failureFromLimit(event.code));
        return;
      }
      if (event.kind === "error") {
        await queue.push(event);
        if (event.terminal === true) await pushFailure(failureFromTerminalError(h, event.message));
        return;
      }
      if (questionMode === "ask" && event.kind === "message" && event.role === "assistant") {
        lastAssistantText = event.text;
      }
      await queue.push(event);
    };
    for await (const chunk of proc.stdout) {
      if (cancelled) break;
      // Any output chunk rearms the inactivity budget, but not the wall-clock deadline
      if (deps.stallMs !== undefined) rearm();
      for (const line of lines.push(chunk)) {
        for (const event of decodeLine(h, line, state, opts.model ?? "", granularity)) {
          await handleEvent(event);
        }
      }
    }
    const rest = lines.flush();
    if (rest !== null && !cancelled) {
      for (const event of decodeLine(h, rest, state, opts.model ?? "", granularity)) {
        await handleEvent(event);
      }
    }
    // Flush at exit if no identity ever arrived
    if (!identitySeen && droppableBuffer.length > 0) {
      await flushDroppable();
    }
  };

  /** issue #41: scan the last assistant message for the hcn-question
   * block. Structured-first - the block's fields become the event; no
   * prose parsing. Runs after the pumps settle (the last message is only
   * last then) and only when detection is armed (questions ask).
   * A malformed block surfaces as an error event, never a silent
   * no-op. */
  const emitQuestionIfAsked = async (): Promise<void> => {
    if (questionMode !== "ask" || lastAssistantText === null) {
      escalationDetection = "none";
      return;
    }
    const detection = detectQuestionBlock(lastAssistantText);
    if (detection === null) {
      escalationDetection = "none";
      return;
    }
    if ("malformed" in detection) {
      escalationDetection = "malformed";
      await queue.push({ kind: "error", message: detection.malformed });
      await pushFailure(failureFromTask(`malformed hcn-question block: ${detection.malformed}`));
      return;
    }
    escalationDetection = "block";
    log({
      event: "question",
      turnId,
      harness: h.name,
      options: detection.block.options.length,
    });
    asked = true;
    await queue.push({
      kind: "question",
      question: detection.block.question,
      options: detection.block.options,
      ...(detection.block.recommended !== undefined
        ? { recommended: detection.block.recommended }
        : {}),
    });
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
  void Promise.all([proc.exited, pumpSettlements])
    .then(() => emitQuestionIfAsked())
    .then(() => queue.close());

  try {
    for await (const event of queue) yield event;

    // F-04: a harness binary that is not installed surfaces as an
    // async ENOENT. The adapter records it in startupError and resolves
    // exited with 127 while appending `spawn failed:` to stderr. Treat
    // it like the synchronous-throw branch: transport failure, retryable,
    // done cause failed with the real exit code.
    const startupMessage = proc.startupError?.() ?? null;
    let startupFailed = false;
    if (startupMessage !== null && failures.length === 0) {
      const f = failureFromTransport(`spawn failed: ${startupMessage}`);
      failures.push(f);
      startupFailed = true;
      // The stderr pump appends the spawn line to the tail but does not
      // emit an error event for it; emit the error here to match the sync
      // branch, and suppress the later tail-error path for this case.
      yield { kind: "error", message: `spawn failed: ${startupMessage}` };
      yield { kind: "failure", ...f };
    }

    // Post-queue failure sources. Nonzero exit with no other failure and a
    // non-empty stderr tail is a NATIVE failure (D6): the harness rejected
    // its own arguments or crashed on them - verbatim stderr, native exit
    // code as data, hcn exit 1. Without a stderr tail it stays transport
    // (a silent nonzero exit reads as an environment problem, not a
    // harness judgment).
    if (
      !startupFailed &&
      !killedByAbort &&
      failures.length === 0 &&
      exitCode !== 0 &&
      exitCode !== null &&
      !killedByWatchdog &&
      !state.limitSeen
    ) {
      const tailForNative = stderrTail.snapshot();
      const transportLine = tailForNative.find((line) => detectTransportInLine(line));
      const unavailableLine = tailForNative.find((line) => detectUnavailableInLine(line));
      const f =
        transportLine !== undefined
          ? failureFromTransport(transportLine)
          : unavailableLine !== undefined
            ? failureFromUnavailable(unavailableLine)
            : tailForNative.length > 0
              ? failureFromNative(exitCode, tailForNative)
              : failureFromTransport(`nonzero exit ${exitCode}`);
      failures.push(f);
      // Need to emit this failure before done, even though queue is closed
      yield { kind: "failure", ...f };
    }
    // Stall watchdog also implies a transport failure if not already present
    if (killedByWatchdog && !killedByAbort && failures.length === 0) {
      // D11: a wall-clock deadline kill is a timeout, not a stall - the
      // run was not necessarily silent, it simply outlived its budget.
      const f =
        watchdogReason === "turn-deadline"
          ? failureFromTimeout()
          : failureFromTransport(`stalled: ${watchdogReason ?? "inactivity"}`);
      failures.push(f);
      yield { kind: "failure", ...f };
    }

    let cause: ExitCause = state.limitSeen
      ? "limit"
      : killedByAbort
        ? "killed"
        : killedByWatchdog && exitCode !== 0
          ? watchdogReason === "turn-deadline"
            ? "killed" // D11: the run was killed on budget, not stalled
            : "stall"
          : exitCode === 0
            ? asked
              ? "awaiting-input" // issue #41: asking SUCCEEDED the turn
              : "clean"
            : exitCode === null
              ? "killed"
              : startupFailed
                ? "failed"
                : "crash";
    const reduced = reduceFailures(failures);
    if (reduced && cause === "clean") cause = "failed";
    // A classified failure other than native on a nonzero exit is a failed
    // turn, not a crash: the failure taxonomy already captured the reason.
    // Crash stays for unclassified exits and native failures.
    if (reduced && reduced.class !== "native" && cause === "crash") {
      cause = "failed";
    }
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
    // F-04: the startupError path already emitted the spawn error; do not
    // duplicate it via the tail.
    if (!startupFailed && (cause === "crash" || cause === "killed") && tail.length > 0) {
      yield { kind: "error", message: tail.join("\n").slice(0, 4096) };
    }
    terminalEventReached = true;
    // D6: when the failure is native, the harness's own exit convention is
    // DATA (nativeExitCode on the failure), not the done event's contract -
    // hcn owns the process exit code (1 for any native failure) because
    // harness conventions collide with hcn's (codex usage errors exit 2,
    // which hcn reserves for refusals).
    const nativeReduced = reduced?.class === "native";
    yield {
      kind: "done",
      exitCode: nativeReduced ? null : exitCode,
      cause,
      ...(reduced ? { failure: reduced } : {}),
      escalation: { mode: questionMode, detection: escalationDetection },
    };
  } finally {
    if (abortHandler !== null) opts.signal?.removeEventListener("abort", abortHandler);
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
