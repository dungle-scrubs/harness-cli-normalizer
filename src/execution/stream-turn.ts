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
 *
 * The supervising policies - stall clock, signal escalation, stderr
 * classification, question detection at close - are the turn supervisor's
 * (RFC-02 change 5); this runner composes it and owns only what is
 * particular to one-shot turns: the wall-clock deadline, the exit
 * classification, and the identity-first event buffer.
 */
import {
  buildSpawnArgv,
  buildTurnEnv,
  type LaunchOptions,
  promptTextOf,
  stdinPromptOf,
  streamingGranularityOf,
  withPromptText,
} from "../interpretation/argv.js";
import { isValidEnvEntry } from "../interpretation/environment.js";
import { composeEscalatedPrompt, type QuestionMode } from "../interpretation/question.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { matcherOverridesOf } from "../knowledge/overrides.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, freshDecodeState, settleProvisionalError } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import {
  DROPPABLE_KINDS,
  type EscalationDetection,
  type ExitCause,
  type HarnessEvent,
} from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  blockedApprovalDetail,
  failureFromApprovalUnobserved,
  failureFromBlockedApproval,
  failureFromLimit,
  failureFromMuseIncompatibleSurface,
  failureFromRejected,
  failureFromStderrTail,
  failureFromTerminalError,
  failureFromTimeout,
  failureFromTransport,
  isLimitFailure,
  reduceFailures,
} from "./failure.js";
import { LineBuffer } from "./lines.js";
import { type MuseApprovalObserver, watchMuseApprovals } from "./muse-approvals.js";
import { streamNativeApprovalTurn } from "./native-approval-turn.js";
import { StderrTail, superviseTurn } from "./supervisor.js";
import { verifyNativeSettings } from "./verified-native-settings.js";

/** Fallback correlation when the host does not mint turn ids: monotonic per
 * process. Hosts that need cross-process uniqueness pass deps.turnId. */
let turnCounter = 0;

/** The grace allowed for pipes still held open (by a grandchild) after the
 * process itself exited. */
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
export const redactArgv = (
  argv: readonly string[],
  prompt?: string,
  viaStdin = false,
): string[] => {
  const promptIndex = prompt !== undefined ? argv.lastIndexOf(prompt) : -1;
  const promptLabel = prompt !== undefined ? `[prompt:${prompt.length}ch]` : "";
  const redacted = argv.map((token, index) => {
    if (index === promptIndex) return promptLabel;
    if (SECRETISH.test(token)) return "[redacted]";
    return token;
  });
  return viaStdin && prompt !== undefined
    ? [...redacted, `[stdin prompt:${prompt.length}ch]`]
    : redacted;
};

export interface TurnRunOptions extends LaunchOptions {
  readonly nativeApprovals?: boolean;
  /** Re-read and preserve this exact native settings source before spawning. */
  readonly nativeSettingsFingerprint?: string;
  /** Resume this session id instead of launching fresh - the turn spawns
   * with the descriptor's resume grammar, and identity decoding treats a
   * DIFFERENT announced id as a rotation anomaly. */
  readonly resume?: string;
  /** Resume the harness's most recent session without naming an id (RFC-06).
   * The plan threads this from the parsed flag; the spawn renders through
   * the resume-last builder and the turn env resolves at resume phase. */
  readonly resumeLast?: true;
  /** The resume-last pre-spawn lines (fixed warning, resolved-root
   * diagnostic, absent-directory warn), computed by the CLI layer and
   * passed in as plain data (ADR 0005: session input and protocol state
   * flow in). Execution only emits them, before any harness output,
   * spawn failures included; it never resolves roots or reads text. */
  readonly resumeLastNotices?: readonly string[];
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
  if (opts.nativeApprovals) {
    yield* streamNativeApprovalTurn(h, opts, { ...deps, turnId });
    return;
  }
  const log = deps.log ?? (() => {});

  // compose the preamble onto the prompt based on question mode.
  const questionMode: QuestionMode = opts.questions ?? "ask";
  const effective: TurnRunOptions = {
    ...opts,
    prompt: withPromptText(opts.prompt, composeEscalatedPrompt(promptTextOf(opts), questionMode)),
  };
  const promptText = promptTextOf(effective);
  const stdinPrompt = stdinPromptOf(h, effective);
  let asked = false;
  let escalationDetection: EscalationDetection = "none";

  // Validate env before building argv so an invalid env is a refusal, not a spawn
  if (opts.env !== undefined) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (!isValidEnvEntry(k, v)) {
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
          argv: redactArgv([], promptText),
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
    const verifiedNativeSettings = verifyNativeSettings(h, effective, deps.inspectNativeSettings);
    argv = buildSpawnArgv(h, { ...effective, verifiedNativeSettings });
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
        argvForLog = redactArgv([], promptText);
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
  const turnEnv = buildTurnEnv(
    h,
    effective,
    effective.resume === undefined && effective.resumeLast !== true ? "launch" : "resume",
  );
  const mergedEnv: Record<string, string> = { ...(opts.env ?? {}), ...turnEnv };

  const matcherOverrides = matcherOverridesOf.get(h);
  const envKeys = Object.keys(mergedEnv).length > 0 ? Object.keys(mergedEnv) : undefined;
  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv, promptText, stdinPrompt !== null),
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

  // RFC-06: the id-less most-recent path carries no id, so the F-23 gate
  // above never fires here. The pre-spawn lines arrive as plain option
  // data from the CLI layer; the runner only emits them, before any
  // harness output, like the F-23 text.
  const resumeLastGuardMessages: readonly string[] =
    effective.resumeLast === true ? (effective.resumeLastNotices ?? []) : [];

  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(argv, {
      stdin: stdinPrompt !== null ? "pipe" : h.stdin === "close-required" ? "close" : "inherit",
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
    for (const warning of resumeLastGuardMessages) yield { kind: "error", message: warning };
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
  // RFC-06: the resume-last guard rides the same early slot, before any
  // harness output, on every resume-last turn.
  for (const warning of resumeLastGuardMessages)
    void queue.push({ kind: "error", message: warning });
  const state = freshDecodeState(effective.resume ?? null, h.name);
  // RFC-06: the plan threads the resume-last discriminant here alongside
  // the null requested id, covering the first announce and the
  // model-attestation re-emit alike. Authority stays harness-minted by
  // the existing requestedId rule.
  if (effective.resumeLast === true) state.resumeLast = true;
  const stderrTail = new StderrTail();
  let killedByWatchdog = false;
  let killedByAbort = false;
  let exited = false;
  let exitCode: number | null = null;
  let pipesOpenAtExit = false;
  let cancelled = false;
  let terminalEventReached = false;

  // Issue #179: a pending native approval the headless stream omits
  // (muse exec) would hang the turn with no event until --timeout. When
  // the descriptor declares an observer, a helper watches the pending set
  // from the first announced identity and stops the turn promptly when
  // something pends - or when the pending set itself cannot be read.
  let approvalBlocked = false;
  let blockingFailure: FailureSummary | undefined;
  // Holder, not a bare let: the watcher is assigned from the stdout pump
  // closure and reaped in the finally below, and a narrowed union would
  // read as never at the reap site.
  const approval: { watch: MuseApprovalObserver | null; session: string | null } = {
    watch: null,
    session: null,
  };
  const stopForApproval = (failure: FailureSummary, event: string, detail: string): void => {
    // L3: once the watchdog killed the turn, a late approval stop must not
    // overwrite the timeout - the turn's verdict is already decided.
    if (approvalBlocked || exited || cancelled || killedByAbort || killedByWatchdog) return;
    approvalBlocked = true;
    blockingFailure = failure;
    void queue.push({ kind: "error", message: detail });
    void pushFailure(failure);
    log({ event, turnId, harness: h.name });
    sup.disarm();
    disarmDeadline();
    sup.escalate();
  };
  const startApprovalWatch = (sessionId: string): void => {
    if (h.approvalObserver !== "msp-list-pending") return;
    if (approval.watch !== null || approval.session === sessionId) return;
    if (approvalBlocked || exited || cancelled || killedByAbort) return;
    approval.session = sessionId;
    approval.watch = watchMuseApprovals(
      h.bin,
      {
        ...(effective.cwd !== undefined ? { cwd: effective.cwd } : {}),
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
      },
      { spawn: deps.spawn, clock: deps.clock, signal: deps.signal },
      sessionId,
      (subject, kind, sandboxEscalation) =>
        stopForApproval(
          failureFromBlockedApproval(h.name, subject, kind, sandboxEscalation),
          "approval_blocked",
          `${blockedApprovalDetail(h.name, subject, kind, sandboxEscalation)} - ending the turn`,
        ),
      () =>
        stopForApproval(
          failureFromApprovalUnobserved(h.name),
          "approval_unobserved",
          `${h.name} approval status could not be observed - hcn could not watch the pending approval set; ending the turn`,
        ),
      (info) =>
        stopForApproval(
          failureFromMuseIncompatibleSurface(h.name, h.verifiedAgainst, info.method, info.code),
          "approval_incompatible",
          `${h.name} MSP surface is incompatible with hcn - ending the turn`,
        ),
      // ADR 0009 / #241: muse's stdout carries no compaction signal at
      // all, so the event comes off the same MSP view this helper already
      // reads. `itemId` is the view's identity for deduping and is not
      // part of the reported event.
      ({ itemId: _itemId, ...found }) => {
        void queue.push({ kind: "compaction", ...found });
      },
    );
  };

  const failures: FailureSummary[] = [];
  const pushFailure = async (f: FailureSummary): Promise<void> => {
    // Suppress a failure identical in class and message to the previous one
    const prev = failures[failures.length - 1];
    if (prev !== undefined && prev.class === f.class && prev.message === f.message) return;
    failures.push(f);
    await queue.push({ kind: "failure", ...f });
  };

  // The wall-clock deadline is this runner's own: a session has none.
  let turnDeadline: number | null = null;
  let watchdogReason: "inactivity" | "turn-deadline" | null = null;
  const disarmDeadline = (): void => {
    if (turnDeadline !== null) deps.clock.clearTimeout(turnDeadline);
    turnDeadline = null;
  };

  const sup = superviseTurn(h, questionMode, {
    clock: deps.clock,
    stallMs: deps.stallMs,
    signal: (sig) => deps.signal(proc, sig),
    emit: async (event) => {
      // A wall read on stderr counts like one decoded from stdout.
      if (event.kind === "limit") state.limitSeen = true;
      await queue.push(event);
    },
    fail: pushFailure,
    tail: stderrTail,
    onStall: () => {
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
      disarmDeadline();
    },
    onQuestion: (options) => {
      log({ event: "question", turnId, harness: h.name, options });
    },
  });

  let abortHandler: (() => void) | null = null;
  if (opts.signal) {
    const onAbort = (): void => {
      if (killedByAbort) return;
      killedByAbort = true;
      sup.escalate();
    };
    if (opts.signal.aborted) {
      killedByAbort = true;
      sup.escalate();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      abortHandler = onAbort;
    }
  }

  // Arm both budgets
  sup.beginTurn();
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
      sup.disarm();
      sup.escalate();
    }, deps.turnTimeoutMs);
  }

  let pipeGrace: number | null = null;
  void proc.exited.then((code) => {
    exited = true;
    exitCode = code;
    // The process is gone: no signal, no pending escalation, no stall
    // clock - a fire after this point would flip a completed turn to
    // "stall".
    sup.settle();
    disarmDeadline();
    // Pipes held open past exit (a grandchild inherited the fd) must not
    // hang the turn forever - close out with the exit code in hand.
    if (cancelled) return;
    pipeGrace = deps.clock.setTimeout(() => {
      pipesOpenAtExit = true;
      proc.disposeOutput();
    }, PIPE_GRACE_MS);
  });

  if (stdinPrompt !== null) {
    let inputFailed = false;
    const failInput = (): void => {
      if (inputFailed || cancelled || exited) return;
      inputFailed = true;
      void pushFailure(failureFromTransport("native prompt stdin failed"));
      sup.escalate();
    };
    void proc.inputError?.then(failInput);
    try {
      if (!proc.stdin) throw new Error("native prompt requires stdin");
      proc.stdin.write(stdinPrompt);
      proc.stdin.end();
    } catch {
      failInput();
    }
  }

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    let identitySeen = false;
    const droppableBuffer: HarnessEvent[] = [];
    const BUFFER_CAP = 256;
    const flushDroppable = async (): Promise<void> => {
      for (const e of droppableBuffer) await queue.push(e);
      droppableBuffer.length = 0;
    };
    const handleEvent = async (event: HarnessEvent): Promise<void> => {
      // A caller-requested stop or HCN deadline owns the terminal verdict.
      // Harnesses may report their own cancellation as a structured task
      // error while shutting down, but that must not replace the known cause.
      const stoppingWithKnownCause =
        killedByAbort || (killedByWatchdog && watchdogReason === "turn-deadline");
      if (
        stoppingWithKnownCause &&
        (event.kind === "failure" || (event.kind === "error" && event.terminal === true))
      ) {
        return;
      }
      if (!identitySeen) {
        if (event.kind === "identity") {
          identitySeen = true;
          await queue.push(event);
          await flushDroppable();
          startApprovalWatch(event.sessionId);
          return;
        }
        if (DROPPABLE_KINDS.has(event.kind)) {
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
        if (event.terminal === true) {
          const failure = failureFromTerminalError(h, event.message);
          if (isLimitFailure(failure)) state.limitSeen = true;
          await pushFailure(failure);
        }
        return;
      }
      sup.noteEvent(event);
      await queue.push(event);
      if (event.kind === "identity") startApprovalWatch(event.sessionId);
    };
    for await (const chunk of proc.stdout) {
      if (cancelled) break;
      // Any output chunk rearms the inactivity budget, but not the wall-clock deadline
      sup.rearm();
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
    // The stream is over, so no successful assistant message can still
    // supersede a provisional terminal error (pi stopReason error): what
    // remains stashed is the turn's verdict now - the silent-empty-turn
    // shape. A superseded claim settles to nothing; its evidence already
    // streamed non-terminal.
    if (!cancelled) {
      for (const event of settleProvisionalError(state)) await handleEvent(event);
    }
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      if (cancelled) break;
      sup.rearm();
      for (const line of lines.push(chunk)) await sup.stderrLine(line);
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
      sup.escalate();
      await proc.exited;
      proc.disposeOutput();
    }
  };
  const pumpSettlements = Promise.all([
    observePump("stdout", pumpStdout()),
    observePump("stderr", pumpStderr()),
  ]);
  // issue #41: the turn closes after the pumps settle (the last message is
  // only last then); the supervisor detects the block and emits it.
  void Promise.all([proc.exited, pumpSettlements])
    .then(() => {
      const close = sup.close();
      escalationDetection = close.detection;
      asked = close.asked;
    })
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

    // Post-queue failure sources: the tail scan owns the transport,
    // unavailable, trust, native, silent precedence (failure.ts).
    if (
      !startupFailed &&
      !killedByAbort &&
      failures.length === 0 &&
      exitCode !== 0 &&
      exitCode !== null &&
      !killedByWatchdog &&
      !state.limitSeen
    ) {
      const f = failureFromStderrTail(h, exitCode, stderrTail.snapshot());
      failures.push(f);
      // Need to emit this failure before done, even though queue is closed
      yield { kind: "failure", ...f };
    }
    // A wall-clock deadline is HCN's authoritative reason for stopping the
    // turn. Some harnesses emit their own cancellation error while they are
    // shutting down, but that result does not replace the timeout cause.
    if (killedByWatchdog && !killedByAbort && watchdogReason === "turn-deadline") {
      const f = failureFromTimeout();
      failures.push(f);
      yield { kind: "failure", ...f };
    } else if (killedByWatchdog && !killedByAbort && failures.length === 0) {
      const f = failureFromTransport(`stalled: ${watchdogReason ?? "inactivity"}`);
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
    const reduced = killedByAbort
      ? undefined
      : killedByWatchdog && watchdogReason === "turn-deadline"
        ? failureFromTimeout()
        : (blockingFailure ?? reduceFailures(failures));
    // The approval stop kills a live process on purpose, so the signal
    // death it caused reports as "failed" with the typed failure, not
    // "killed" (which names external cancellation).
    if (approvalBlocked && !killedByAbort) cause = "failed";
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
      // Like the refusal path: hcn owns the process exit code, and a
      // deliberately stopped turn carries no harness signal number.
      exitCode: nativeReduced || approvalBlocked ? null : exitCode,
      cause,
      ...(reduced ? { failure: reduced } : {}),
      escalation: { mode: questionMode, detection: escalationDetection },
    };
  } finally {
    if (abortHandler !== null) opts.signal?.removeEventListener("abort", abortHandler);
    const abandoned = !terminalEventReached;
    cancelled = true;
    // Reap the approval observer with the child on every exit - clean,
    // failed, killed, or abandoned.
    const approvalCleanup = approval.watch?.close();
    queue.close();
    sup.disarm();
    disarmDeadline();
    if (abandoned) {
      log({ event: "abandoned", turnId, harness: h.name });
      if (!exited) sup.escalate();
    }
    proc.disposeOutput();
    const [settledExit] = await Promise.all([proc.exited, pumpSettlements, approvalCleanup]);
    exitCode = settledExit;
    if (pipeGrace !== null) deps.clock.clearTimeout(pipeGrace);
    pipeGrace = null;
    sup.settle();
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
