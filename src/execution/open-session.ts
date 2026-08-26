/**
 * openSession: the persistent headless session runner - ONE process, many
 * turns (A-001). `send` writes a descriptor-encoded user record to stdin and starts a
 * turn when idle or hands the text to the harness when a turn is live
 * (the harness queues it). `result` lines delimit turns; identity dedupe (D-022)
 * spans the whole session. Lifecycle is bounded end to end: close() ends
 * stdin, escalates SIGTERM->SIGKILL if the child ignores EOF, and pipes
 * held open past exit close out after grace - a session can always be
 * ended. Pending sends that die with the session are surfaced, never
 * silently dropped. Structured lifecycle events (session open/close, turn
 * start/end, send dispositions, drops) are always-on evidence with
 * sessionId + turnId correlation.
 */
import { buildSessionArgv, buildTurnEnv } from "../interpretation/argv.js";
import { capabilitiesOf } from "../interpretation/capabilities.js";
import { detectAuthFailureInLine, detectLimitInLine } from "../interpretation/limits.js";
import {
  composeEscalatedPrompt,
  detectQuestionBlock,
  type QuestionMode,
} from "../interpretation/question.js";
import {
  encodeSessionInput,
  resolveSessionInput,
  SessionInputRefusalError,
} from "../interpretation/session-input.js";
import type { HarnessDescriptor, SessionInputContract } from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeParsed, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess, TimerHandle } from "./deps.js";
import type { EscalationDetection, ExitCause, HarnessEvent } from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  failureFromAuth,
  failureFromLimit,
  failureFromTask,
  failureFromTerminalError,
  failureFromTransport,
  reduceFailures,
} from "./failure.js";
import { LineBuffer } from "./lines.js";
import { KILL_GRACE_MS, PIPE_GRACE_MS, redactArgv, StderrTail } from "./stream-turn.js";

/** Grace after stdin EOF before concluding the child will not exit on its
 * own and escalating signals. */
export const CLOSE_GRACE_MS = 5_000;

const PRETURN_MAX = 256;

export interface SessionSendResult {
  readonly disposition: "started" | "rejected";
  /** Present when rejected. `write-failed` is a broken stdin pipe, which is
   * a different remedy from a session the caller already closed - the two
   * must stay distinguishable. */
  readonly reason?: "write-failed";
}

/** One turn's event stream, tagged with the id of the send that opened it.
 * `inputId` is present for every turn a consumer send opened, which today is
 * every turn; a turn opened by anything else (none exists yet) omits it. */
export interface SessionTurn extends AsyncIterable<HarnessEvent> {
  readonly inputId?: string;
  /** `${sessionId}:turn-${n}`, matching the runner's turn_start log. */
  readonly turnId?: string;
}

/** A send's payload: the consumer's correlation id travels with the text
 * from the moment it arrives to the turn it opens and, on death, to the
 * loss report. */
export interface SessionInput {
  readonly id: string;
  readonly text: string;
}

export interface SessionHandle {
  /** One inner iterable per turn, each ending in a turn-scoped `done`.
   * Breaking out of THIS iterable closes the session; breaking out of a
   * single turn's iterable only stops reading that turn. */
  readonly turns: AsyncIterable<SessionTurn>;
  send(input: SessionInput): SessionSendResult;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  readonly sessionId: string;
  readonly model?: string;
  /** Working directory for the spawned harness. */
  readonly cwd?: string;
  /** question mode for session (ask/assume/none), default "ask" */
  readonly questions?: QuestionMode;
  /** Provider selector (pi); refused on a harness without one. */
  readonly provider?: string;
  /** True when resuming an existing conversation; controls which flag
   * (resumeFlag vs idFlag) buildSessionArgv renders. */
  readonly isResume?: boolean;
  /** Persistent-memory dimension (ratified 2026-08-26): the session spawn
   * honors it the way a one-shot launch does - false renders the
   * descriptor's disable (claude: CLAUDE_CODE_DISABLE_AUTO_MEMORY env var;
   * pi: nothing, no built-in memory). Undefined means the caller made no
   * memory decision; openSession adds no env overlay then. Resumed
   * sessions get it too - it is a spawn property, not a turn option, so
   * the launch-only rule never silently re-enables memory on a session. */
  readonly memory?: boolean;
}

export class SessionClosedError extends Error {
  constructor() {
    super("session is closed; sends have nowhere to go");
    this.name = "SessionClosedError";
  }
}

export class SessionSpawnError extends Error {
  constructor(harness: string, cause: unknown) {
    super(
      `could not spawn a ${harness} session: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "SessionSpawnError";
  }
}

export const openSession = (
  h: HarnessDescriptor,
  opts: OpenSessionOptions,
  deps: RunnerDeps,
): SessionHandle => {
  const log = deps.log ?? (() => {});
  const argv = buildSessionArgv(h, {
    sessionId: opts.sessionId,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.isResume !== undefined ? { isResume: opts.isResume } : {}),
  });
  let sessionInput: SessionInputContract;
  try {
    sessionInput = resolveSessionInput(h);
  } catch (cause) {
    if (!(cause instanceof SessionInputRefusalError)) throw cause;
    log({
      event: "session_input_refused",
      harness: h.name,
      issue: cause.issue,
      sessionId: opts.sessionId,
    });
    throw cause;
  }

  // Descriptor-derived spawn env (claude's memory disable) - same merge
  // rule as streamTurn: rendered at spawn, reported in the open log line.
  const turnEnv =
    opts.memory !== undefined ? buildTurnEnv(h, { memory: opts.memory }, "launch") : {};
  const envKeys = Object.keys(turnEnv).length > 0 ? Object.keys(turnEnv) : undefined;

  let proc: SpawnedProcess;
  try {
    // A session needs a writable stdin regardless of the descriptor's
    // one-shot stdin policy - that policy governs turns, not sessions.
    proc = deps.spawn(argv, {
      stdin: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(envKeys !== undefined ? { env: turnEnv } : {}),
    });
  } catch (cause) {
    log({ event: "session_spawn_failed", sessionId: opts.sessionId, harness: h.name });
    throw new SessionSpawnError(h.name, cause);
  }
  const stdin = proc.stdin;
  if (stdin === undefined) {
    // The child exists but there is no way to ever send to it - end it
    // before throwing, or it runs orphaned forever.
    deps.signal(proc, "SIGTERM");
    log({ event: "session_spawn_failed", sessionId: opts.sessionId, harness: h.name });
    throw new SessionSpawnError(h.name, new Error("spawner opened no stdin pipe"));
  }

  log({
    event: "session_open",
    sessionId: opts.sessionId,
    harness: h.name,
    argv: redactArgv(argv),
    ...(envKeys !== undefined ? { envKeys } : {}),
  });

  const turnsChannel = new AsyncChannel<SessionTurn>();
  const state = freshDecodeState(opts.sessionId);
  const questionMode: QuestionMode = opts.questions ?? "ask";
  const sessionInputMode = h.sessionMode;
  const stderrTail = new StderrTail();
  let turnCounter = 0;
  let activeTurn: AsyncChannel<HarnessEvent> | null = null;
  let activeTurnId = "";
  const pendingIds: string[] = [];
  const pendingLengths: number[] = [];
  // close() waits here while a turn is open. Ending the child's stdin
  // mid-turn is fatal on pi: rpc treats EOF as "finish up and exit", so the
  // prompt it has buffered never runs and the turn ends clean with no
  // output (issue #99). claude happens to drain a queued turn after EOF,
  // which is why this was invisible there. The README promises that a close
  // after a send lets the turn finish; this is what keeps that promise.
  let turnSettled: (() => void) | null = null;
  const preTurnEvents: HarnessEvent[] = [];
  let dead = false;
  let closing = false;
  let finalized = false;
  let exitCode: number | null = null;
  let resultError = false;
  let turnLimitSeen = false;
  let turnFailures: FailureSummary[] = [];
  let pumpError: unknown = null;
  // issue #44: the active turn's last assistant message (where the
  // hcn-question block lives) and whether the turn ended by asking.
  let lastAssistantText: string | null = null;
  let turnAsked = false;
  let turnEscalationDetection: EscalationDetection = "none";
  let identityAnnounced = false;

  const safeSignal = (sig: "SIGTERM" | "SIGKILL"): void => {
    if (!dead) deps.signal(proc, sig);
  };
  const escalate = (): void => {
    safeSignal("SIGTERM");
    deps.clock.setTimeout(() => safeSignal("SIGKILL"), KILL_GRACE_MS);
  };

  // Per-turn inactivity budget. A session turn can hang with the process
  // alive and the pipes open, which no exit code reports; without this the
  // consumer waits forever. Armed at turn start, rearmed on any output
  // chunk, disarmed at turn end and at exit - the same discipline
  // streamTurn uses, scoped to the turn rather than the process.
  let stallTimer: TimerHandle | null = null;
  let stalled = false;
  const disarmStall = (): void => {
    if (stallTimer !== null) deps.clock.clearTimeout(stallTimer);
    stallTimer = null;
  };
  const rearmStall = (): void => {
    if (deps.stallMs === undefined || activeTurn === null) return;
    disarmStall();
    stallTimer = deps.clock.setTimeout(() => {
      // The turn may have ended between the timer firing and this callback
      // running. Without this guard a clean turn that finished near the
      // budget would be reported as a stall and the child signalled.
      if (activeTurn === null) return;
      stalled = true;
      log({
        event: "stall",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        harness: h.name,
        reason: "inactivity",
        budgetMs: deps.stallMs,
      });
      // The turn is owed its own terminal event before the process dies;
      // the exit path then closes the session with the same cause.
      void pushFailure(failureFromTransport("stalled: inactivity"));
      endTurn({ kind: "done", exitCode: null, cause: "stall" });
      escalate();
    }, deps.stallMs);
  };

  const writeUser = (text: string): boolean => {
    try {
      stdin.write(
        encodeSessionInput(sessionInput, composeEscalatedPrompt(text, questionMode, "session")),
      );
      return true;
    } catch {
      // A broken stdin pipe ends the session: there is no way to drive the
      // child any more. Surface it as its own event, stop accepting sends,
      // and END the child - marking it dead here instead would suppress the
      // very signal that stops it. The exit path then finalizes as usual.
      void routeEvent({ kind: "error", message: "send failed: session stdin is gone" });
      closing = true;
      escalate();
      return false;
    }
  };

  /** A decoded failure event minus its kind: what done.failure carries. */
  const summaryOf = (event: HarnessEvent & { kind: "failure" }): FailureSummary => {
    const { kind: _kind, ...summary } = event;
    return summary;
  };

  const startTurn = (inputId?: string): void => {
    turnLimitSeen = false;
    turnFailures = [];
    turnAsked = false;
    turnEscalationDetection = "none";
    lastAssistantText = null;
    activeTurn = new AsyncChannel<HarnessEvent>();
    activeTurnId = `${opts.sessionId}:turn-${++turnCounter}`;
    // Tag the turn with the id of the send that opened it, so the consumer
    // correlates an input to its turn by reading the tag, not by
    // shadowing the runner's delivery order.
    (activeTurn as { inputId?: string; turnId?: string }).inputId = inputId;
    (activeTurn as { inputId?: string; turnId?: string }).turnId = activeTurnId;
    log({ event: "turn_start", sessionId: opts.sessionId, turnId: activeTurnId });
    for (const held of preTurnEvents.splice(0)) {
      if (held.kind === "failure") turnFailures.push(summaryOf(held));
      activeTurn.push(held);
    }
    turnsChannel.push(activeTurn as SessionTurn);
    rearmStall();
  };

  /** issue #44: at a turn boundary, scan the last assistant message for
   * the hcn-question block - same structured-first discipline and
   * last-message rule as streamTurn. The question event lands in the
   * turn stream right before its done; a malformed block surfaces as an
   * error event, never a silent no-op. */
  const emitQuestionIfAsked = (): void => {
    if (questionMode !== "ask" || lastAssistantText === null) {
      turnEscalationDetection = "none";
      return;
    }
    const detection = detectQuestionBlock(lastAssistantText);
    if (detection === null) {
      turnEscalationDetection = "none";
      return;
    }
    if ("malformed" in detection) {
      turnEscalationDetection = "malformed";
      activeTurn?.push({ kind: "error", message: detection.malformed });
      const failure = failureFromTask(`malformed hcn-question block: ${detection.malformed}`);
      turnFailures.push(failure);
      void activeTurn?.push({ kind: "failure", ...failure });
      return;
    }
    turnEscalationDetection = "block";
    turnAsked = true;
    log({
      event: "question",
      sessionId: opts.sessionId,
      turnId: activeTurnId,
      harness: h.name,
      options: detection.block.options.length,
    });
    activeTurn?.push({
      kind: "question",
      question: detection.block.question,
      options: detection.block.options,
      ...(detection.block.recommended !== undefined
        ? { recommended: detection.block.recommended }
        : {}),
    });
  };

  const endTurn = (done: Omit<HarnessEvent & { kind: "done" }, "escalation">): void => {
    if (activeTurn === null) return;
    disarmStall();
    // Asking is a successful turn: the session semantic is "blocked on
    // answer, session alive" - the done stays TURN-scoped (exitCode null
    // in sessions) and the caller answers with the next send().
    emitQuestionIfAsked();
    if (turnAsked && done.cause === "clean") done = { ...done, cause: "awaiting-input" };
    // RFC-01 every turn end carries the escalation record
    let fullDone: HarnessEvent & { kind: "done" } = {
      ...done,
      escalation: { mode: questionMode, detection: turnEscalationDetection },
    } as HarnessEvent & { kind: "done" };
    // Every failure was already emitted as an event through pushFailure;
    // the turn's done carries the reduced summary, as streamTurn's does.
    const reduced = reduceFailures(turnFailures);
    if (reduced !== undefined) {
      if (fullDone.cause === "clean") fullDone = { ...fullDone, cause: "failed", failure: reduced };
      else fullDone = { ...fullDone, failure: reduced };
    }
    activeTurn.push(fullDone);
    activeTurn.close();
    log({
      event: "turn_end",
      sessionId: opts.sessionId,
      turnId: activeTurnId,
      cause: fullDone.cause,
    });
    activeTurn = null;
    resultError = false;
    if (turnSettled !== null) {
      const release = turnSettled;
      turnSettled = null;
      release();
    }
    if (dead || closing) return;
    const nextId = pendingIds.shift();
    if (nextId === undefined) return;
    pendingLengths.shift();
    // The text was already written to the harness when the send arrived;
    // the id was held to correlate the next turn.
    startTurn(nextId);
  };

  const routeEvent = (event: HarnessEvent): Promise<void> => {
    if (event.kind === "limit") {
      state.limitSeen = true;
      turnLimitSeen = true;
    }
    if (questionMode === "ask" && event.kind === "message" && event.role === "assistant") {
      lastAssistantText = event.text;
    }
    if (activeTurn !== null) {
      // Awaited by the pumps: past the channel's high water mark this
      // blocks the pump, so OS pipe backpressure reaches the child.
      return activeTurn.push(event);
    }
    // Between-turn events wait for the next turn, bounded: past the cap
    // droppable events go first, then oldest.
    preTurnEvents.push(event);
    if (preTurnEvents.length > PRETURN_MAX) {
      const droppableAt = preTurnEvents.findIndex(
        (e) => e.kind === "token" || e.kind === "progress" || e.kind === "context",
      );
      preTurnEvents.splice(droppableAt === -1 ? 0 : droppableAt, 1);
    }
    return Promise.resolve();
  };

  const pushFailure = (f: FailureSummary): Promise<void> => {
    turnFailures.push(f);
    return routeEvent({ kind: "failure", ...f });
  };

  /** A decoded event other than a failure: a terminal error also records
   * the failure it stands for, the way streamTurn does. */
  const routeDecoded = async (event: HarnessEvent): Promise<void> => {
    await routeEvent(event);
    if (event.kind === "error" && event.terminal === true) {
      await pushFailure(failureFromTerminalError(h, event.message));
    }
  };

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    const matches = (
      record: Record<string, unknown>,
      spec: Readonly<Record<string, string>>,
    ): boolean => {
      for (const [key, expected] of Object.entries(spec)) {
        if (record[key] !== expected) return false;
      }
      return true;
    };
    // issue #44: pi rpc is identity-silent at startup; the probe round
    // trip is the only way to read the id (spike fixtures). The response
    // echoes our marker id, so it cannot be confused with a user-visible
    // get_state response.
    if (sessionInputMode?.identityProbe !== null && sessionInputMode !== null) {
      try {
        stdin.write(
          `${JSON.stringify({ id: "hcn-identity", type: sessionInputMode.identityProbe.command })}\n`,
        );
      } catch {
        // stdin already gone; the exited handler will surface the death.
      }
    }
    const handleLine = async (line: string): Promise<void> => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        const code = detectLimitInLine(h, line);
        if (code !== null) {
          await routeEvent({ kind: "limit", code, message: `limit wall detected (${code})` });
          await pushFailure(failureFromLimit(code));
        }
        return;
      }
      // pi rpc bookkeeping: the probe response announces identity; a
      // failed command response is a surfaced error, never a silent drop
      // (spike: mid-stream prompts fail with success:false naming the
      // remedy - hcn never sends those, but any other failure shows here).
      if (parsed.type === "response") {
        if (
          parsed.id === "hcn-identity" &&
          typeof parsed.command === "string" &&
          parsed.command === sessionInputMode?.identityProbe?.command &&
          parsed.success === true
        ) {
          const data = parsed.data as Record<string, unknown> | undefined;
          const announced = data?.sessionId;
          if (typeof announced !== "string") {
            await routeEvent({
              kind: "error",
              message: "identity probe response carried no sessionId",
            });
          } else if (sessionInputMode.idFlag === null) {
            // Harness-MINTED identity (pi rpc: `--session` refuses unknown
            // ids, so fresh sessions omit the flag). The minted id IS the
            // identity; opts.sessionId stays the caller-side handle.
            if (!identityAnnounced) {
              identityAnnounced = true;
              state.lastSeenId = announced;
              await routeEvent({
                kind: "identity",
                sessionId: announced,
                authority: "harness-minted",
                capabilities: capabilitiesOf(h, opts.model ?? "", "headless-session"),
              });
            }
          } else if (announced === opts.sessionId) {
            if (!identityAnnounced) {
              identityAnnounced = true;
              await routeEvent({
                kind: "identity",
                sessionId: announced,
                authority: "caller-assigned",
                capabilities: capabilitiesOf(h, opts.model ?? "", "headless-session"),
              });
            }
          } else {
            await routeEvent({
              kind: "error",
              message: `identity rotated: session announced ${JSON.stringify(announced)} but ${opts.sessionId} was requested`,
            });
          }
          return;
        }
        if (parsed.success === false) {
          await routeEvent({
            kind: "error",
            message: `rpc command failed: ${JSON.stringify(parsed.command)} - ${JSON.stringify(parsed.error ?? "unknown error")}`,
          });
        }
        return;
      }
      // The turn-end record still feeds identity dedupe (claude includes
      // session_id on result - a rotation announced there must not be
      // missed).
      const events = decodeParsed(h, parsed, state, opts.model ?? "");
      const isTurnEnd = sessionInputMode !== null && matches(parsed, sessionInputMode.turnEnd);
      if (isTurnEnd) {
        // decodeParsed already surfaces the is_error case as an error event
        // (content.ts claude reader); routing the events is enough - we only
        // still track resultError here to classify the done cause.
        for (const event of events) {
          if (event.kind === "failure") await pushFailure(summaryOf(event));
          else await routeDecoded(event);
        }
        if (parsed.is_error === true) resultError = true;
        endTurn({
          kind: "done",
          exitCode: null,
          cause: turnLimitSeen ? "limit" : resultError ? "crash" : "clean",
        });
        return;
      }
      for (const event of events) {
        if (event.kind === "failure") await pushFailure(summaryOf(event));
        else await routeDecoded(event);
      }
    };
    for await (const chunk of proc.stdout) {
      rearmStall();
      for (const line of lines.push(chunk)) await handleLine(line);
    }
    const rest = lines.flush();
    if (rest !== null) await handleLine(rest);
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      rearmStall();
      for (const line of lines.push(chunk)) {
        const limit = detectLimitInLine(h, line);
        if (limit !== null) {
          await routeEvent({
            kind: "limit",
            code: limit,
            message: `limit wall detected (${limit})`,
          });
          await pushFailure(failureFromLimit(limit));
          continue;
        }
        const auth = detectAuthFailureInLine(h, line);
        if (auth !== null) {
          await pushFailure(failureFromAuth(auth));
          await routeEvent({ kind: "error", message: `auth wall: ${auth}` });
          continue;
        }
        stderrTail.push(line);
      }
    }
  };

  const pumping = Promise.allSettled([pumpStdout(), pumpStderr()]).then((settlements) => {
    pumpError = settlements.find((settlement) => settlement.status === "rejected")?.reason ?? null;
  });

  let shutdownComplete: () => void = () => {};
  const shutdown = new Promise<void>((resolve) => {
    shutdownComplete = resolve;
  });

  let pipesOpenAtExit = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    // A stall killed the process on purpose, so the signal death it caused
    // reports as "stall", not "killed".
    const cause: ExitCause = stalled
      ? "stall"
      : state.limitSeen
        ? "limit"
        : exitCode === 0
          ? "clean"
          : exitCode === null
            ? "killed"
            : "crash";
    if (pumpError !== null) {
      void routeEvent({ kind: "error", message: `session pump failed: ${String(pumpError)}` });
    }
    if (pendingIds.length > 0) {
      const droppedIds = [...pendingIds];
      const droppedLengths = [...pendingLengths];
      void routeEvent({
        kind: "error",
        message: `${pendingIds.length} pending send(s) died with the session: ${droppedIds.join(", ")}`,
      });
      log({
        event: "sends_dropped",
        sessionId: opts.sessionId,
        count: pendingIds.length,
        ids: droppedIds,
        lengths: droppedLengths,
      });
      pendingIds.length = 0;
      pendingLengths.length = 0;
    }
    endTurn({ kind: "done", exitCode, cause });
    if (preTurnEvents.some((e) => e.kind !== "token" && e.kind !== "progress")) {
      log({
        event: "preturn_events_dropped",
        sessionId: opts.sessionId,
        kinds: preTurnEvents.map((e) => e.kind),
      });
    }
    turnsChannel.close();
    log({
      event: "session_close",
      sessionId: opts.sessionId,
      exitCode,
      cause,
      ...(pipesOpenAtExit ? { pipesOpenAtExit } : {}),
      ...(cause === "crash" || cause === "killed" ? { stderrTail: stderrTail.snapshot() } : {}),
    });
    shutdownComplete();
  };

  void proc.exited.then((code) => {
    dead = true;
    exitCode = code;
    // A close() waiting on an open turn must not outlive the child.
    if (turnSettled !== null) {
      const release = turnSettled;
      turnSettled = null;
      release();
    }
    // The process is gone: a later fire would flip a finished turn to stall.
    disarmStall();
    // Pipes held open past exit (a grandchild) must not hang the session.
    const pipeGrace = deps.clock.setTimeout(() => {
      pipesOpenAtExit = true;
      activeTurn?.releaseBackpressure();
      proc.disposeOutput();
      void pumping.then(() => finalize());
    }, PIPE_GRACE_MS);
    void pumping.then(() => {
      deps.clock.clearTimeout(pipeGrace);
      finalize();
    });
  });

  // Two intents share this path and must not be conflated. A CLOSE is the
  // consumer asking politely: an open turn gets to finish first, because
  // the consumer is still there to receive it. ABANDONMENT is the consumer
  // walking away from the turns iterable: nobody is left to receive a turn,
  // so stdin ends at once and the child is reaped, not drained.
  const close = async (drain = true): Promise<void> => {
    if (closing) return shutdown;
    closing = true;
    // Let an open turn reach its end record before stdin goes away. The
    // wait is bounded twice over: the stall watchdog ends a silent turn,
    // and the grace below still escalates a child that never exits.
    if (drain && activeTurn !== null && !dead) {
      await new Promise<void>((resolve) => {
        turnSettled = resolve;
      });
    }
    try {
      stdin.end();
    } catch {
      // stdin may already be gone - escalation below still bounds close.
    }
    // A child that does not exit on stdin EOF gets signalled after grace.
    const closeGrace = deps.clock.setTimeout(() => escalate(), CLOSE_GRACE_MS);
    await shutdown;
    deps.clock.clearTimeout(closeGrace);
  };

  return {
    // Breaking out of the turns iterable is abandonment - treat it as
    // close() so the child is never left running undrained (the streamTurn
    // C1 scar, adapted to a handle-shaped API).
    turns: (async function* () {
      try {
        for await (const turn of turnsChannel) yield turn;
      } finally {
        if (!closing && !dead) void close(false);
      }
    })(),
    send(input: SessionInput): SessionSendResult {
      if (dead || closing) throw new SessionClosedError();
      const wasBusy = activeTurn !== null;
      if (!writeUser(input.text)) {
        log({
          event: "send",
          sessionId: opts.sessionId,
          turnId: activeTurnId,
          inputId: input.id,
          disposition: "rejected",
          reason: "write-failed",
        });
        return { disposition: "rejected", reason: "write-failed" };
      }
      if (wasBusy) {
        pendingIds.push(input.id);
        pendingLengths.push(input.text.length);
      } else {
        startTurn(input.id);
      }
      log({
        event: "send",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        inputId: input.id,
        disposition: "started",
      });
      return { disposition: "started" };
    },
    close,
  };
};
