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
 *
 * The supervising policies - stall clock, signal escalation, stderr
 * classification, question detection at close - are the turn supervisor's
 * (RFC-02 change 5), composed once per session and begun per turn. This
 * runner owns only what is particular to sessions: turn delimiting, the
 * send correlation, and the close-versus-abandon distinction.
 */
import { buildSessionArgv } from "../interpretation/argv.js";
import { capabilitiesOf } from "../interpretation/capabilities.js";
import { composeEscalatedPrompt, type QuestionMode } from "../interpretation/question.js";
import {
  decodeSessionRecord,
  encodeIdentityProbe,
  encodeSessionInput,
  resolveSessionInput,
  SessionInputRefusalError,
} from "../interpretation/session-input.js";
import type { HarnessDescriptor, SessionInputContract } from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, decodeParsed, freshDecodeState } from "./decode.js";
import type { RunnerDeps, SpawnedProcess } from "./deps.js";
import {
  DROPPABLE_KINDS,
  type EscalationDetection,
  type ExitCause,
  type HarnessEvent,
} from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  failureFromLimit,
  failureFromTerminalError,
  failureFromTransport,
  reduceFailures,
} from "./failure.js";
import { LineBuffer } from "./lines.js";
import { PIPE_GRACE_MS, redactArgv } from "./stream-turn.js";
import { StderrTail, superviseTurn } from "./supervisor.js";

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
  /** Effort level for the session spawn, validated per harness/model the
   * way a one-shot launch validates it. Undefined means the caller made
   * no effort decision: the session runs at the harness's own default
   * effort (sessions carry no profile entry). */
  readonly effort?: string;
  /** True when resuming an existing conversation; controls which flag
   * (resumeFlag vs idFlag) buildSessionArgv renders. */
  readonly isResume?: boolean;
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
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
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

  let proc: SpawnedProcess;
  try {
    // A session needs a writable stdin regardless of the descriptor's
    // one-shot stdin policy - that policy governs turns, not sessions.
    proc = deps.spawn(argv, {
      stdin: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
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
  // issue #44: whether the active turn ended by asking, and what its close
  // detected.
  let turnAsked = false;
  let turnEscalationDetection: EscalationDetection = "none";
  let identityAnnounced = false;
  // A stall killed the process on purpose, so the signal death it caused
  // reports as "stall", not "killed".
  let stalled = false;

  // The supervisor spans the session; each turn begins and ends on it. A
  // session turn can hang with the process alive and the pipes open, which
  // no exit code reports; the stall clock is what bounds that wait.
  const sup = superviseTurn(h, questionMode, {
    clock: deps.clock,
    stallMs: deps.stallMs,
    signal: (sig) => deps.signal(proc, sig),
    emit: (event) => routeEvent(event),
    fail: (summary) => pushFailure(summary),
    tail: stderrTail,
    onStall: () => {
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
    },
    onQuestion: (options) => {
      log({
        event: "question",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        harness: h.name,
        options,
      });
    },
  });

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
      sup.escalate();
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
    sup.beginTurn();
  };

  const endTurn = (done: Omit<HarnessEvent & { kind: "done" }, "escalation">): void => {
    if (activeTurn === null) return;
    sup.disarm();
    // issue #44: the supervisor scans the last assistant message for the
    // hcn-question block; the question event lands in the turn stream
    // right before its done. Asking is a successful turn: the session
    // semantic is "blocked on answer, session alive" - the done stays
    // TURN-scoped (exitCode null in sessions) and the caller answers with
    // the next send().
    const close = sup.close();
    turnEscalationDetection = close.detection;
    turnAsked = close.asked;
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
    sup.noteEvent(event);
    if (activeTurn !== null) {
      // Awaited by the pumps: past the channel's high water mark this
      // blocks the pump, so OS pipe backpressure reaches the child.
      return activeTurn.push(event);
    }
    // Between-turn events wait for the next turn, bounded: past the cap
    // droppable events go first, then oldest.
    preTurnEvents.push(event);
    if (preTurnEvents.length > PRETURN_MAX) {
      const droppableAt = preTurnEvents.findIndex((e) => DROPPABLE_KINDS.has(e.kind));
      preTurnEvents.splice(droppableAt === -1 ? 0 : droppableAt, 1);
    }
    return Promise.resolve();
  };

  const pushFailure = (f: FailureSummary): Promise<void> => {
    turnFailures.push(f);
    return routeEvent({ kind: "failure", ...f });
  };

  /** A decoded event other than a failure: a limit also records the
   * failure it stands for, and so does a terminal error, the way
   * streamTurn does. */
  const routeDecoded = async (event: HarnessEvent): Promise<void> => {
    if (event.kind === "failure") {
      await pushFailure(summaryOf(event));
      return;
    }
    await routeEvent(event);
    if (event.kind === "limit") await pushFailure(failureFromLimit(event.code));
    if (event.kind === "error" && event.terminal === true) {
      await pushFailure(failureFromTerminalError(h, event.message));
    }
  };

  /** The probe answered: bind the announced id under the descriptor's
   * authority, or surface a rotation. */
  const announceIdentity = async (announced: string): Promise<void> => {
    if (identityAnnounced) return;
    if (sessionInputMode?.idFlag === null) {
      // Harness-MINTED identity (pi rpc: `--session` refuses unknown ids,
      // so fresh sessions omit the flag). The minted id IS the identity;
      // opts.sessionId stays the caller-side handle.
      identityAnnounced = true;
      state.lastSeenId = announced;
      await routeEvent({
        kind: "identity",
        sessionId: announced,
        authority: "harness-minted",
        capabilities: capabilitiesOf(h, opts.model ?? "", "headless-session"),
      });
      return;
    }
    if (announced === opts.sessionId) {
      identityAnnounced = true;
      await routeEvent({
        kind: "identity",
        sessionId: announced,
        authority: "caller-assigned",
        capabilities: capabilitiesOf(h, opts.model ?? "", "headless-session"),
      });
      return;
    }
    await routeEvent({
      kind: "error",
      message: `identity rotated: session announced ${JSON.stringify(announced)} but ${opts.sessionId} was requested`,
    });
  };

  const pumpStdout = async (): Promise<void> => {
    const lines = new LineBuffer();
    // issue #44: a harness that is identity-silent at startup gets the
    // probe its descriptor declares; interpretation encodes it (ADR 0005).
    const probe = encodeIdentityProbe(h);
    if (probe !== null) {
      try {
        stdin.write(probe);
      } catch {
        // stdin already gone; the exited handler will surface the death.
      }
    }
    const handleLine = async (line: string): Promise<void> => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Not a record: the shared decoder reads the one signal a plain
        // line can carry (a wall) and nothing else.
        for (const event of decodeLine(h, line, state, opts.model ?? "")) {
          await routeDecoded(event);
        }
        return;
      }
      // Interpretation says what the record means; this runner only routes
      // on the kind (ADR 0005: no harness field names here).
      const record = decodeSessionRecord(h, parsed);
      switch (record.kind) {
        case "identity":
          await announceIdentity(record.sessionId);
          return;
        case "probe-failed":
        case "command-failed":
          await routeEvent({ kind: "error", message: record.message });
          return;
        case "ignored":
          return;
        case "turn-end": {
          // The turn-end record still feeds identity dedupe (claude includes
          // session_id on result - a rotation announced there must not be
          // missed) and content decoding, which already surfaces a failed
          // result as an error event; the flag here only classifies the
          // done cause.
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            await routeDecoded(event);
          }
          if (record.isError) resultError = true;
          endTurn({
            kind: "done",
            exitCode: null,
            cause: turnLimitSeen ? "limit" : resultError ? "crash" : "clean",
          });
          return;
        }
        case "content": {
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            await routeDecoded(event);
          }
          return;
        }
        default: {
          const exhaustive: never = record;
          return exhaustive;
        }
      }
    };
    for await (const chunk of proc.stdout) {
      sup.rearm();
      for (const line of lines.push(chunk)) await handleLine(line);
    }
    const rest = lines.flush();
    if (rest !== null) await handleLine(rest);
  };

  const pumpStderr = async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      sup.rearm();
      for (const line of lines.push(chunk)) await sup.stderrLine(line);
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
    if (preTurnEvents.some((e) => !DROPPABLE_KINDS.has(e.kind))) {
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
    // The process is gone: no signal, no pending escalation, no stall
    // clock - a later fire would flip a finished turn to stall.
    sup.settle();
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
    const closeGrace = deps.clock.setTimeout(() => sup.escalate(), CLOSE_GRACE_MS);
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
