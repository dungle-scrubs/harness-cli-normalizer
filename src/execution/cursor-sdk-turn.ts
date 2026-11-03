/**
 * streamCursorSdkTurn: the one-shot headless runner for an SDK-backed
 * harness (issue #440). The SDK agent loop must never load inside the hcn
 * process - a timeout that cannot kill the loop is not a timeout - so the
 * turn spawns the private worker through the injected primitives and
 * supervises it exactly the way the CLI runner supervises a native child:
 * the same turn supervisor (stall clock, signal escalation, stderr
 * classification, question detection at close), the same line buffering
 * and failure taxonomy. What is particular to this runner: the prompt and
 * the open request travel on stdin instead of argv, the worker's private
 * terminal record (never an assistant-text heuristic) ends the turn, and
 * a caller abort first asks the worker for native cancellation and only
 * escalates signals after a bounded grace, so the cancellation receipt
 * that reaches the caller is the SDK's own.
 */
import {
  buildSpawnArgv,
  buildTurnEnv,
  type LaunchOptions,
  promptTextOf,
} from "../interpretation/argv.js";
import {
  cursorSdkAccessRestriction,
  cursorSdkTurnEndOf,
  cursorSdkWireKindOf,
  encodeCursorSdkAbort,
  encodeCursorSdkOpen,
  encodeCursorSdkPrompt,
} from "../interpretation/cursor-sdk.js";
import { isValidEnvEntry } from "../interpretation/environment.js";
import { composeEscalatedPrompt, type QuestionMode } from "../interpretation/question.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { IDENTITY_PROBE_ID, SEND_ID_PREFIX } from "../interpretation/session-input.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { matcherOverridesOf } from "../knowledge/overrides.js";
import { AsyncChannel } from "./channel.js";
import { failureFromCursorSdkRecord } from "./cursor-sdk-failure.js";
import { decodeLine, decodeParsed, freshDecodeState, settleProvisionalError } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import type { EscalationDetection, ExitCause, HarnessEvent } from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  DIAGNOSTIC_MAX,
  failureFromLimit,
  failureFromLineOverflow,
  failureFromNative,
  failureFromNativeRejection,
  failureFromRejected,
  failureFromStderrTail,
  failureFromTerminalError,
  failureFromTimeout,
  failureFromTransport,
  isLimitFailure,
  redactBounded,
  reduceFailures,
} from "./failure.js";
import { LineBuffer, RUN_LINE_MAX } from "./lines.js";
import { redactArgv } from "./stream-turn.js";
import { CLOSE_GRACE_MS, PIPE_GRACE_MS, StderrTail, superviseTurn } from "./supervisor.js";

/** How long a caller abort waits for the worker's native cancellation
 * (Run.cancel + the cancelled turn end) before escalating SIGTERM. */
export const ABORT_CANCEL_GRACE_MS = 5_000;

/** The single correlated send id a one-shot turn writes. */
const RUN_SEND_ID = `${SEND_ID_PREFIX}1`;

export interface SdkTurnOptions extends LaunchOptions {
  readonly resume?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly questions?: QuestionMode;
  readonly signal?: AbortSignal;
}

let sdkTurnCounter = 0;

export async function* streamCursorSdkTurn(
  h: HarnessDescriptor,
  opts: SdkTurnOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const turnId = deps.turnId ?? `turn-${++sdkTurnCounter}`;
  const log = deps.log ?? (() => {});
  const questionMode: QuestionMode = opts.questions ?? "ask";
  const promptText = composeEscalatedPrompt(promptTextOf(opts), questionMode);
  let escalationDetection: EscalationDetection = "none";
  let asked = false;

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
          argv: [],
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

  let argv: readonly string[];
  try {
    argv = buildSpawnArgv(h, { ...opts, prompt: promptText });
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
      log({ event: "rejected", turnId, harness: h.name, issue: e.issue, argv: [] });
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

  if (opts.signal?.aborted) {
    log({ event: "exit", turnId, harness: h.name, exitCode: null, cause: "killed" });
    yield {
      kind: "done",
      exitCode: null,
      cause: "killed",
      escalation: { mode: questionMode, detection: "none" },
    };
    return;
  }

  const turnEnv = buildTurnEnv(h, opts, opts.resume === undefined ? "launch" : "resume");
  const mergedEnv: Record<string, string> = { ...(opts.env ?? {}), ...turnEnv };
  const envKeys = Object.keys(mergedEnv).length > 0 ? Object.keys(mergedEnv) : undefined;
  log({
    event: "spawn",
    turnId,
    harness: h.name,
    argv: redactArgv(argv),
    granularity: "token",
    backend: "cursor-sdk",
    ...(matcherOverridesOf.get(h) ? { matcherOverrides: matcherOverridesOf.get(h) } : {}),
    ...(envKeys?.length ? { envKeys } : {}),
  });

  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(argv, {
      stdin: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
    });
  } catch (cause) {
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
    yield {
      kind: "done",
      exitCode: 127,
      cause: "failed",
      failure,
      escalation: { mode: questionMode, detection: "none" },
    };
    return;
  }
  const stdin = proc.stdin;
  if (stdin === undefined) {
    deps.signal(proc, "SIGTERM");
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode: 127,
      cause: "crash",
      spawnError: "no stdin pipe",
    });
    const failure = failureFromTransport(
      "spawn failed: spawner opened no stdin pipe for the SDK worker",
    );
    yield {
      kind: "error",
      message: "spawn failed: spawner opened no stdin pipe for the SDK worker",
    };
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
  const state = freshDecodeState(opts.resume ?? null, h.name);
  const stderrTail = new StderrTail();
  const failures: FailureSummary[] = [];
  const pushFailure = async (f: FailureSummary): Promise<void> => {
    const prev = failures[failures.length - 1];
    if (prev !== undefined && prev.class === f.class && prev.message === f.message) return;
    failures.push(f);
    await queue.push({ kind: "failure", ...f });
  };

  let killedByWatchdog = false;
  let watchdogReason: "inactivity" | "turn-deadline" | null = null;
  let killedByAbort = false;
  let abortCancelRequested = false;
  let exited = false;
  let exitCode: number | null = null;
  // Held on a const object: the stdout pump assigns it from a closure, and
  // a bare let would narrow to its initializer at every later read.
  const terminal = { ended: null as ReturnType<typeof cursorSdkTurnEndOf> };
  // The worker's open-failed record: the run is over before it began, and
  // stdin must close so the worker exits.
  let startupRefused = false;
  let denialCount = 0;

  const sup = superviseTurn(h, questionMode, {
    clock: deps.clock,
    stallMs: deps.stallMs,
    signal: (sig) => deps.signal(proc, sig),
    emit: async (event) => {
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
    },
    onQuestion: (options) => {
      log({ event: "question", turnId, harness: h.name, options });
    },
  });

  let turnDeadline: number | null = null;
  let abortGrace: number | null = null;
  let closeGrace: number | null = null;
  let pipeGrace: number | null = null;
  const disarmDeadline = (): void => {
    if (turnDeadline !== null) deps.clock.clearTimeout(turnDeadline);
    turnDeadline = null;
  };
  const disarmAbortGrace = (): void => {
    if (abortGrace !== null) deps.clock.clearTimeout(abortGrace);
    abortGrace = null;
  };

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

  let abortHandler: (() => void) | null = null;
  const requestNativeCancel = (): void => {
    if (abortCancelRequested) return;
    abortCancelRequested = true;
    try {
      // Ask the worker to cancel the SDK run natively first: the receipt
      // the caller gets is then the SDK's own cancellation, not a signal
      // death. The grace timer below still bounds the wait.
      stdin.write(encodeCursorSdkAbort("hcn-interrupt:abort"));
    } catch {
      // stdin gone; the exit path owns the rest.
    }
    disarmAbortGrace();
    abortGrace = deps.clock.setTimeout(() => {
      abortGrace = null;
      sup.escalate();
    }, ABORT_CANCEL_GRACE_MS);
  };
  void proc.exited.then((code) => {
    exited = true;
    exitCode = code;
    sup.settle();
    disarmDeadline();
    disarmAbortGrace();
    if (closeGrace !== null) deps.clock.clearTimeout(closeGrace);
    closeGrace = null;
    pipeGrace = deps.clock.setTimeout(() => {
      queue.releaseBackpressure();
      proc.disposeOutput();
    }, PIPE_GRACE_MS);
  });

  // The open request and the one prompt ride stdin; the worker cannot read
  // the prompt before the open settles, so both lines are written at once.
  const restriction = cursorSdkAccessRestriction({
    access: opts.access,
    autonomy: opts.autonomy,
  });
  const openLine = encodeCursorSdkOpen({
    id: IDENTITY_PROBE_ID,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(restriction.tools === undefined ? {} : { tools: restriction.tools }),
    ...(restriction.disallowedTools === undefined
      ? {}
      : { disallowedTools: restriction.disallowedTools }),
    ...(restriction.sandbox === undefined ? {} : { sandbox: restriction.sandbox }),
  });
  const promptLine = encodeCursorSdkPrompt(RUN_SEND_ID, promptText);
  try {
    stdin.write(`${openLine}${promptLine}`);
  } catch (cause) {
    const failure = failureFromTransport(
      `SDK worker stdin failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    await queue.push({ kind: "error", message: failure.message });
    await pushFailure(failure);
    sup.escalate();
  }

  if (opts.signal) {
    const onAbort = (): void => {
      if (killedByAbort) return;
      killedByAbort = true;
      requestNativeCancel();
    };
    if (opts.signal.aborted) onAbort();
    else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      abortHandler = onAbort;
    }
  }

  const pumpStdout = async (): Promise<void> => {
    const overflows: FailureSummary[] = [];
    const lines = new LineBuffer(RUN_LINE_MAX, (overflow) =>
      overflows.push(failureFromLineOverflow("stdout", overflow)),
    );
    const handleLine = async (line: string): Promise<void> => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        if (cursorSdkWireKindOf(parsed) === "send-cancelled") {
          killedByAbort = true;
          startupRefused = true;
          return;
        }
        if (startupRefused && cursorSdkWireKindOf(parsed) === "send-failed") return;
        const structuredFailure = failureFromCursorSdkRecord(h, parsed, deps.clock);
        const ended = cursorSdkTurnEndOf(parsed);
        if (ended !== null) terminal.ended = ended;
        // An open failure is a startup failure: no work ran, so no work
        // verdict (task) can be right - the native-rejection classifier
        // keeps unknown messages native the way a CLI exit did (issue
        // #425's cursor scenario now rides the SDK worker's message).
        if (
          cursorSdkWireKindOf(parsed) === "open-failed" ||
          cursorSdkWireKindOf(parsed) === "send-failed"
        ) {
          startupRefused = true;
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "", "token")) {
            await handleEvent(event, "rejection", structuredFailure);
          }
          return;
        }
        for (const event of decodeParsed(h, parsed, state, opts.model ?? "", "token")) {
          await handleEvent(event, "terminal", structuredFailure);
        }
        return;
      }
      for (const event of decodeLine(h, line, state, opts.model ?? "", "token")) {
        await handleEvent(event);
      }
    };
    const handleEvent = async (
      event: HarnessEvent,
      failureMode: "terminal" | "rejection" = "terminal",
      structuredFailure: FailureSummary | null = null,
    ): Promise<void> => {
      // A caller-requested stop or hcn's deadline owns the terminal
      // verdict: the worker may report its own error while shutting down,
      // and that must not overwrite the known cause (the CLI runner's
      // policy, mirrored here).
      const stoppingWithKnownCause =
        killedByAbort || (killedByWatchdog && watchdogReason === "turn-deadline");
      if (
        stoppingWithKnownCause &&
        (event.kind === "failure" || (event.kind === "error" && event.terminal === true))
      ) {
        return;
      }
      if (event.kind === "error" && event.denial !== undefined) denialCount++;
      if (event.kind === "failure") {
        const { kind: _kind, ...summary } = event;
        await pushFailure(summary);
        return;
      }
      if (event.kind === "limit") {
        // A wall decoded from stdout counts like one read on stderr: the
        // turn's done must carry it, not only the limit event (the CLI
        // runner's dedupe applies - an identical consecutive failure is
        // dropped).
        state.limitSeen = true;
        await queue.push(event);
        await pushFailure(failureFromLimit(event.code));
        return;
      }
      if (event.kind === "error" && event.terminal === true) {
        await queue.push(event);
        const failure =
          structuredFailure ??
          (failureMode === "rejection"
            ? failureFromNativeRejection(h, event.message, deps.clock)
            : failureFromTerminalError(h, event.message, deps.clock));
        if (isLimitFailure(failure)) state.limitSeen = true;
        await pushFailure(failure);
        return;
      }
      sup.noteEvent(event);
      await queue.push(event);
    };
    for await (const chunk of proc.stdout) {
      sup.rearm();
      for (const line of lines.push(chunk as string | Uint8Array)) await handleLine(line);
      for (const overflow of overflows.splice(0)) await pushFailure(overflow);
      if (terminal.ended !== null || startupRefused) {
        // The turn is over natively, or the agent never opened and nothing
        // more can happen: end stdin so the worker disposes, exits, and
        // the done - and the exit - stay bounded.
        try {
          stdin.end();
          if (!exited && closeGrace === null) {
            closeGrace = deps.clock.setTimeout(() => sup.escalate(), CLOSE_GRACE_MS);
          }
        } catch {
          sup.escalate();
        }
      }
    }
    const rest = lines.flush();
    if (rest !== null && terminal.ended === null) await handleLine(rest);
    for (const overflow of overflows.splice(0)) await pushFailure(overflow);
    // A provisional terminal error nothing superseded settles here, the
    // same way the CLI runner settles it.
    for (const event of settleProvisionalError(state)) {
      await queue.push(event);
      await pushFailure(failureFromTerminalError(h, event.message, deps.clock));
    }
  };

  const pumpStderr = async (): Promise<void> => {
    const overflows: FailureSummary[] = [];
    const lines = new LineBuffer(RUN_LINE_MAX, (overflow) =>
      overflows.push(failureFromLineOverflow("stderr", overflow)),
    );
    for await (const chunk of proc.stderr) {
      sup.rearm();
      for (const line of lines.push(chunk as string | Uint8Array)) await sup.stderrLine(line);
    }
    lines.flush();
    for (const overflow of overflows.splice(0)) await pushFailure(overflow);
  };

  const observePump = async (stream: "stdout" | "stderr", pump: Promise<void>): Promise<void> => {
    try {
      await pump;
    } catch (cause) {
      const message = `${stream} pump failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await queue.push({ kind: "error", message });
      await pushFailure(failureFromTransport(message));
      sup.escalate();
      await proc.exited;
      proc.disposeOutput();
    }
  };
  const pumpSettlements = Promise.all([
    observePump("stdout", pumpStdout()),
    observePump("stderr", pumpStderr()),
  ]);
  void Promise.all([proc.exited, pumpSettlements])
    .then(() => {
      const close = sup.close();
      escalationDetection = close.detection;
      asked = close.asked;
    })
    .then(() => queue.close());

  try {
    for await (const event of queue) {
      yield event;
    }

    const startupMessage = proc.startupError?.() ?? null;
    let startupFailed = false;
    if (startupMessage !== null && failures.length === 0) {
      const f = failureFromTransport(`spawn failed: ${startupMessage}`);
      failures.push(f);
      startupFailed = true;
      yield { kind: "error", message: `spawn failed: ${startupMessage}` };
      yield { kind: "failure", ...f };
    }

    const credential =
      startupFailed || killedByAbort || killedByWatchdog
        ? null
        : sup.credentialAccessFailure(exitCode);
    if (credential !== null) {
      failures.push(credential);
      yield { kind: "failure", ...credential };
    }

    let cause: ExitCause;
    // A limit wall owns the verdict with the same precedence the CLI
    // runner gives it: the turn stopped on the provider's budget, ahead
    // of abort, deadline and exit-code classification.
    if (state.limitSeen) {
      cause = "limit";
    } else if (killedByAbort) {
      cause = "killed";
    } else if (killedByWatchdog && watchdogReason === "turn-deadline") {
      cause = "killed";
      if (failures.length === 0) {
        const f = failureFromTimeout();
        failures.push(f);
        yield { kind: "failure", ...f };
      }
    } else if (killedByWatchdog) {
      cause = "stall";
      if (failures.length === 0) {
        const f = failureFromTransport(`stalled: ${watchdogReason ?? "inactivity"}`);
        failures.push(f);
        yield { kind: "failure", ...f };
      }
    } else if (terminal.ended !== null && terminal.ended.status === "cancelled") {
      cause = "killed";
    } else if (terminal.ended !== null && terminal.ended.status === "error") {
      cause = "failed";
    } else if (terminal.ended !== null && exitCode === 0) {
      cause = asked ? "awaiting-input" : "clean";
    } else if (exitCode === 0) {
      // Exit 0 with no terminal record mirrors the CLI runner: whatever
      // failures were observed decide, and silence alone is clean (the
      // credential-observation rule discards exit-0 diagnostics the same
      // way). A worker bug that exits 0 silently reports as the CLI's
      // empty-turn shape did.
      cause =
        reduceFailures(failures) !== undefined ? "failed" : asked ? "awaiting-input" : "clean";
    } else if (exitCode === null) {
      cause = "killed";
    } else {
      cause = "crash";
    }
    // Post-queue failure sources mirror the CLI runner's: the tail scan
    // owns the transport/unavailable/trust/native precedence when the
    // worker died without classifying itself. A native terminal record
    // that survived a nonzero exit keeps its native failure (the run
    // finished; the process after it crashed).
    const completion =
      state.nativeTerminalSeen && failures.length === 0
        ? "native-terminal"
        : state.messageDelivered
          ? "message-delivered"
          : undefined;
    if (
      !startupFailed &&
      failures.length === 0 &&
      exitCode !== 0 &&
      exitCode !== null &&
      !killedByWatchdog &&
      !killedByAbort &&
      !state.limitSeen
    ) {
      const f =
        completion === "native-terminal"
          ? failureFromNative(exitCode, stderrTail.snapshot())
          : failureFromStderrTail(h, exitCode, stderrTail.snapshot());
      failures.push(f);
      yield { kind: "failure", ...f };
    }
    const reduced = killedByAbort
      ? undefined
      : killedByWatchdog && watchdogReason === "turn-deadline"
        ? failureFromTimeout()
        : (reduceFailures(failures) ?? undefined);
    if (reduced !== undefined && cause === "clean") cause = "failed";
    if (reduced !== undefined && reduced.class !== "native" && cause === "crash") cause = "failed";
    const tail = stderrTail.snapshot();
    log({
      event: "exit",
      turnId,
      harness: h.name,
      exitCode,
      cause,
      backend: "cursor-sdk",
      ...(terminal.ended !== null ? { runStatus: terminal.ended.status } : {}),
      ...(cause === "crash" || cause === "stall" || cause === "killed" || cause === "failed"
        ? { stderrTail: tail }
        : {}),
      ...(reduced !== undefined ? { failure: reduced } : {}),
    });
    if ((cause === "crash" || cause === "killed") && tail.length > 0) {
      yield { kind: "error", message: redactBounded(tail.join("\n"), DIAGNOSTIC_MAX) };
    }
    yield {
      kind: "done",
      exitCode,
      cause,
      ...(denialCount > 0 ? { denialCount } : {}),
      ...(reduced !== undefined ? { failure: reduced } : {}),
      ...(exitCode !== null && exitCode !== 0 && !killedByAbort && !killedByWatchdog && completion
        ? { completion }
        : {}),
      escalation: { mode: questionMode, detection: escalationDetection },
    };
  } finally {
    if (abortHandler !== null) opts.signal?.removeEventListener("abort", abortHandler);
    disarmDeadline();
    disarmAbortGrace();
    try {
      stdin.end();
    } catch {
      // already gone
    }
    queue.releaseBackpressure();
    sup.disarm();
    if (!exited) {
      const grace = deps.clock.setTimeout(() => sup.escalate(), CLOSE_GRACE_MS);
      await proc.exited;
      deps.clock.clearTimeout(grace);
    }
    proc.disposeOutput();
    await Promise.all([proc.exited, pumpSettlements]);
    sup.settle();
    if (closeGrace !== null) deps.clock.clearTimeout(closeGrace);
    if (pipeGrace !== null) deps.clock.clearTimeout(pipeGrace);
  }
}
