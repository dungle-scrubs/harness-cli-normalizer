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
import { randomUUID } from "node:crypto";
import { buildSessionArgv, buildTurnEnv } from "../interpretation/argv.js";
import {
  type CapabilityResult,
  capabilitiesOf,
  type SessionControlsCapability,
  sessionControlsOf,
} from "../interpretation/capabilities.js";
import { composeEscalatedPrompt, type QuestionMode } from "../interpretation/question.js";
import {
  correlatesByInputUuid,
  decodeSessionRecord,
  encodeIdentityProbe,
  encodeSessionInput,
  encodeSessionInterrupt,
  hasNativeReceipts,
  publishesTurnOnRunEvidence,
  readInputUuids,
  resolveSessionInput,
  SessionInputRefusalError,
} from "../interpretation/session-input.js";
import type { SkillsSelection } from "../interpretation/skills-selection.js";
import type {
  HarnessDescriptor,
  SessionDelivery,
  SessionInputContract,
} from "../knowledge/descriptor.js";
import { AsyncChannel } from "./channel.js";
import { decodeLine, decodeParsed, freshDecodeState, settleProvisionalError } from "./decode.js";
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
  failureFromLineOverflow,
  failureFromNativeRejection,
  failureFromStderrTail,
  failureFromTerminalError,
  failureFromTransport,
  isLimitFailure,
  reduceFailures,
} from "./failure.js";
import { LineBuffer, RUN_LINE_MAX } from "./lines.js";
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
   * must stay distinguishable. `unsupported-delivery` is an explicit
   * delivery mode this harness does not support: nothing was written and
   * the session stays usable. */
  readonly reason?: "closed" | "native-rejected" | "write-failed" | "unsupported-delivery";
  /** Resolves when a harness with command receipts accepts or rejects the input. */
  readonly settled?: Promise<SessionSendResult>;
}

/** One turn's event stream, tagged with the id of the send that opened it.
 * `inputId` is present for every turn a consumer send opened. A native turn
 * no send opened (claude output whose records name no waiting send, such as
 * background task output) omits it. */
export interface SessionTurn extends AsyncIterable<HarnessEvent> {
  readonly inputId?: string;
  /** `${sessionId}:turn-${n}`, matching the runner's turn_start log. */
  readonly turnId?: string;
}

/** A send's payload: the consumer's correlation id travels with the text
 * from the moment it arrives to the turn it opens and, on death, to the
 * loss report. Ids are the caller's and may repeat; the runner correlates
 * each send by its own token. `delivery` requests an explicit native
 * delivery mode; omitted, the harness's native busy-send behavior applies. */
export interface SessionInput {
  readonly id: string;
  readonly text: string;
  readonly delivery?: SessionDelivery;
}

/** The terminal outcome of an interrupt request (issue #426). `interrupted`
 * is the harness's own report that the active run was cancelled; command
 * acceptance alone is never read as one. `not-active` means the harness
 * reported no run cancelled (it had already settled, or was idle). */
export interface SessionInterruptReceipt {
  readonly state: "interrupted" | "not-active" | "rejected";
  readonly reason?: "unsupported" | "closed" | "write-failed" | "native-rejected";
}

/** `requested`: the native cancellation request was written, and `settled`
 * resolves exactly once with the terminal receipt. `rejected`: nothing was
 * written. */
export type SessionInterruptResult =
  | { readonly state: "requested"; readonly settled: Promise<SessionInterruptReceipt> }
  | { readonly state: "rejected"; readonly reason: "unsupported" | "closed" | "write-failed" };

export interface SessionHandle {
  /** One inner iterable per turn, each ending in a turn-scoped `done`.
   * Breaking out of THIS iterable closes the session; breaking out of a
   * single turn's iterable only stops reading that turn. */
  readonly turns: AsyncIterable<SessionTurn>;
  /** The explicit controls this session's harness supports. */
  readonly controls: SessionControlsCapability;
  send(input: SessionInput): SessionSendResult;
  /** Request cancellation of the active turn while the process continues.
   * Carries no replacement text: the caller sends that after the receipt. */
  interrupt(request: { readonly id: string }): SessionInterruptResult;
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
  /** Named-agent selection (map #288); refused on a harness without a
   * spec, the same way a one-shot turn refuses. */
  readonly agent?: string;
  readonly contextWindow?: number;
  /** Effort level for the session spawn, validated per harness/model the
   * way a one-shot launch validates it. Undefined means the caller made
   * no effort decision: the session runs at the harness's own default
   * effort (sessions carry no profile entry). */
  readonly effort?: string;
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
  /** The host's own version, reported to harnesses that ask at session
   * open (codex app-server's initialize handshake carries clientInfo). */
  readonly clientVersion?: string;
  /** Caller-directed skills allowlist (issue #332), resolved by the CLI
   * against the registry root. Passed to buildSessionArgv, which renders
   * it through the same owner a one-shot launch uses; a harness that
   * cannot enforce an allowlist refuses here, before any spawn. */
  readonly skills?: SkillsSelection;
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

/** True for harnesses whose session input waits for the spawn-probe
 * identity before any send can be written (popeye mint the session via
 * the create probe; codex needs the thread id on every request). pi's
 * prompt-wire is identity-silent and writes at send time. The single
 * predicate `send` uses to buffer before identity and the #345 arm uses
 * to settle buffered sends when the probe fails. */
const buffersSendsBeforeIdentity = (input: SessionInputContract): boolean =>
  input.kind === "popeye-rpc-prompt" || input.kind === "codex-jsonrpc";

/** Native run output: what shows a run is producing work, as opposed to an
 * identity announcement, progress, or a failure observed locally. */
const isRunOutput = (event: HarnessEvent): boolean =>
  (event.kind === "message" && event.role === "assistant") ||
  event.kind === "token" ||
  event.kind === "tool" ||
  event.kind === "tool-result";

/** One send as the runner tracks it: a unique token per command, so a
 * reused caller id never stands in for another command. */
interface SentCommand {
  /** The per-command correlation id written on the wire after the send
   * marker. Unique within the process, so a reused caller id never stands
   * in for another command and native answers may arrive in any order. */
  readonly token: string;
  readonly input: SessionInput;
  /** claude: the native message uuid stamped on every frame; turn records
   * naming it correlate the turn to this send. */
  readonly uuid?: string;
  settle?: (result: SessionSendResult) => void;
}

/** An interrupt request written to the harness and not yet settled. */
interface PendingInterrupt {
  /** A settlement reporting an aborted run arrived after the request. */
  abortedSeen: boolean;
  /** The harness accepted the command while a run was still live; the next
   * settlement decides the receipt. */
  awaitingSettlement: boolean;
  readonly resolve: (receipt: SessionInterruptReceipt) => void;
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
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.isResume !== undefined ? { isResume: opts.isResume } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
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
  const state = freshDecodeState(opts.sessionId, h.name);
  const questionMode: QuestionMode = opts.questions ?? "ask";
  const sessionInputMode = h.sessionMode;
  const stderrTail = new StderrTail();
  let turnCounter = 0;
  let activeTurn: AsyncChannel<HarnessEvent> | null = null;
  let activeTurnId = "";
  // The send that opened the active turn (its id is the turn's inputId).
  // Used by the #344 command-failed arm and the pi handled receipt to decide
  // whether the harness answered the command that opened the turn, vs a
  // later input (steer, codex request with no turn), by command identity
  // rather than by the caller's reusable id. Cleared at each turn end.
  let activeTurnOpener: SentCommand | undefined;
  let activeTurnOpenerAccepted = false;
  // Issue #426: false while the active turn is provisional - an idle send
  // written with no native evidence for it yet. A write is not native
  // acceptance. A provisional turn is internal: no turn id, no turn_start,
  // nothing on the turns iterable until native evidence publishes it. Pi:
  // a started receipt, run output or a settlement; a handled receipt
  // retires it with no public trace. Claude: a record naming a waiting
  // send's uuid chooses the opener; run output or a result naming none is
  // a native turn no send opened. On both, a stall or a death publishes it
  // with its opener, which is owed the failure.
  let activeTurnPublished = false;
  let activeNativeTurnId: string | null = null;
  // Sends written whose turn opens later (claude and the other protocols
  // without receipts), oldest first. Text is never held here: it was written
  // to the harness at send time.
  const pendingTurns: SentCommand[] = [];
  // Sends awaiting a native receipt, by the per-command token they carry.
  const awaitingReceipt = new Map<string, SentCommand>();
  let commandSeq = 0;
  const uuidCorrelated = correlatesByInputUuid(sessionInput.kind);
  const controls: SessionControlsCapability = sessionControlsOf(h) ?? {
    deliveryModes: [],
    interrupt: { supported: false },
  };
  const pendingInterrupts = new Map<string, PendingInterrupt>();
  // The id of the codex turn currently running NATIVELY (result.turn.id /
  // turn/steer's {turnId}), the steer precondition for the next mid-turn
  // send. Null while no native turn is open; cleared at each turn end.
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
  // Popeye mints the session via the create probe: sends before the
  // response carry no session id and refuse. Buffer them; identity flushes.
  const popeyePending: SentCommand[] = [];
  let finalized = false;
  let exitCode: number | null = null;
  let resultError = false;
  let turnLimitSeen = false;
  let turnFailures: FailureSummary[] = [];
  let turnDenialCount = 0;
  let pumpError: unknown = null;
  // issue #44: whether the active turn ended by asking, and what its close
  // detected.
  let turnAsked = false;
  let turnEscalationDetection: EscalationDetection = "none";
  let identityAnnounced = false;
  // A stall killed the process on purpose, so the signal death it caused
  // reports as "stall", not "killed".
  let stalled = false;
  // A refused session open (#345) or a crash with no open turn (#347)
  // has no turn to carry its failure. Keep it for the session-close reduction.
  let sessionFailure: FailureSummary | undefined;

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
      // A provisional turn is owed its stall: publish it first so the log
      // line carries its turn id.
      publishTurn();
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

  /** Register a send to be settled by the harness's receipt. */
  const awaitReceipt = (command: SentCommand): Promise<SessionSendResult> =>
    new Promise<SessionSendResult>((resolve) => {
      command.settle = resolve;
      awaitingReceipt.set(command.token, command);
    });
  /** The send a native answer names by its token, if one is outstanding. */
  const takeReceipt = (token: string): SentCommand | undefined => {
    const command = awaitingReceipt.get(token);
    awaitingReceipt.delete(token);
    return command;
  };
  const dropReceipt = (command: SentCommand): void => {
    awaitingReceipt.delete(command.token);
  };
  /** A written send named by its token: awaiting a receipt, opening the
   * active turn, or waiting for its turn (popeye answers refusals by id
   * with no receipt protocol). */
  const sentByToken = (token: string): SentCommand | undefined =>
    takeReceipt(token) ??
    (activeTurnOpener?.token === token
      ? activeTurnOpener
      : pendingTurns.find((command) => command.token === token));

  const settleInterrupt = (token: string, receipt: SessionInterruptReceipt): void => {
    const pending = pendingInterrupts.get(token);
    if (pending === undefined) return;
    pendingInterrupts.delete(token);
    log({ event: "interrupt_settled", sessionId: opts.sessionId, ...receipt });
    pending.resolve(receipt);
  };
  /** A run settled. An aborted settlement after a request is the harness's
   * own confirmation; a request the harness accepted while the run was
   * live settles on this outcome. */
  const observeSettlement = (aborted: boolean): void => {
    for (const [token, pending] of [...pendingInterrupts]) {
      if (aborted) pending.abortedSeen = true;
      if (pending.awaitingSettlement) {
        settleInterrupt(token, { state: aborted ? "interrupted" : "not-active" });
      }
    }
  };

  const writeUser = (
    command: SentCommand,
    busy: boolean,
  ): { readonly settled?: Promise<SessionSendResult>; readonly written: boolean } => {
    const { input } = command;
    // Encoding refuses before anything is written or registered: a refused
    // delivery mode is not a broken pipe and leaves the session usable.
    const line = encodeSessionInput(
      sessionInput,
      composeEscalatedPrompt(input.text, questionMode, "session"),
      {
        busy,
        id: command.token,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(command.uuid === undefined ? {} : { uuid: command.uuid }),
        // Popeye prompt frames and codex requests carry the minted
        // session/thread id; the create/thread-open response binds it
        // before any send is written.
        ...((sessionInput.kind === "popeye-rpc-prompt" || sessionInput.kind === "codex-jsonrpc") &&
        state.lastSeenId !== null
          ? { sessionId: state.lastSeenId }
          : {}),
        // Codex steer precondition: the tracked id of the running
        // native turn. Unknown (receipt still in flight) renders as
        // the empty string, which the harness itself rejects - the
        // send reports rejected instead of being written blindly.
        ...(sessionInput.kind === "codex-jsonrpc" && activeNativeTurnId !== null
          ? { activeTurnId: activeNativeTurnId }
          : {}),
      },
    );
    // A send buffered before identity pre-registers its receipt; the flush
    // then writes with the registration already in place.
    const settled =
      command.settle === undefined && hasNativeReceipts(sessionInput.kind)
        ? awaitReceipt(command)
        : undefined;
    try {
      stdin.write(line);
      return { ...(settled === undefined ? {} : { settled }), written: true };
    } catch {
      dropReceipt(command);
      command.settle?.({ disposition: "rejected", reason: "write-failed" });
      // A broken stdin pipe ends the session: there is no way to drive the
      // child any more. Surface it as its own event, stop accepting sends,
      // and END the child - marking it dead here instead would suppress the
      // very signal that stops it. The exit path then finalizes as usual.
      void routeEvent({ kind: "error", message: "send failed: session stdin is gone" });
      closing = true;
      sup.escalate();
      return { written: false };
    }
  };

  /** A decoded failure event minus its kind: what done.failure carries. */
  const summaryOf = (event: HarnessEvent & { kind: "failure" }): FailureSummary => {
    const { kind: _kind, ...summary } = event;
    return summary;
  };

  /** Open the turn a send (or, with no opener, native output) starts. A
   * provisional turn is busy and supervised from now, but stays internal
   * until publishTurn. */
  const startTurn = (opener?: SentCommand, options?: { readonly provisional?: boolean }): void => {
    turnLimitSeen = false;
    turnFailures = [];
    turnDenialCount = 0;
    turnAsked = false;
    turnEscalationDetection = "none";
    activeTurn = new AsyncChannel<HarnessEvent>();
    activeTurnOpener = opener;
    activeTurnOpenerAccepted = false;
    activeTurnPublished = false;
    sup.beginTurn();
    if (options?.provisional !== true) publishTurn();
  };

  /** Put the active turn on the turns iterable, with its turn id. */
  const publishTurn = (): void => {
    if (activeTurn === null || activeTurnPublished) return;
    activeTurnPublished = true;
    activeTurnId = `${opts.sessionId}:turn-${++turnCounter}`;
    // Tag the turn with the id of the send that opened it, so the consumer
    // correlates an input to its turn by reading the tag, not by
    // shadowing the runner's delivery order.
    (activeTurn as { inputId?: string; turnId?: string }).inputId = activeTurnOpener?.input.id;
    (activeTurn as { inputId?: string; turnId?: string }).turnId = activeTurnId;
    log({ event: "turn_start", sessionId: opts.sessionId, turnId: activeTurnId });
    for (const held of preTurnEvents.splice(0)) {
      if (held.kind === "failure") turnFailures.push(summaryOf(held));
      if (held.kind === "error" && held.denial !== undefined) turnDenialCount++;
      activeTurn.push(held);
    }
    turnsChannel.push(activeTurn as SessionTurn);
  };

  /** Reset the per-turn state once the active turn is over, and release a
   * close() waiting on it. */
  const clearActiveTurn = (): void => {
    activeTurn = null;
    activeTurnOpener = undefined;
    activeTurnOpenerAccepted = false;
    activeTurnPublished = false;
    activeNativeTurnId = null;
    resultError = false;
    if (turnSettled !== null) {
      const release = turnSettled;
      turnSettled = null;
      release();
    }
  };

  /** Issue #426: the harness reported the provisional turn's input consumed
   * with no run (pi handled). It never becomes public: no turn, no done.
   * Events held for it stay parked for the next turn. No settlement will
   * follow, so an interrupt the harness already accepted against it settles
   * not-active now. */
  const retireProvisionalTurn = (): void => {
    if (activeTurn === null || activeTurnPublished) return;
    sup.disarm();
    sup.close();
    activeTurn.close();
    clearActiveTurn();
    observeSettlement(false);
  };

  const endTurn = (
    done: Omit<HarnessEvent & { kind: "done" }, "escalation" | "denialCount">,
  ): void => {
    if (activeTurn === null) return;
    // A provisional turn that ends any other way (settlement, stall,
    // death) had a run, or owes a failure: it is published first.
    publishTurn();
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
      ...(turnDenialCount > 0 ? { denialCount: turnDenialCount } : {}),
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
    clearActiveTurn();
    if (dead || closing) return;
    // A uuid-correlated send (claude) waits for a record naming its uuid:
    // it may have joined the turn that just ended, and background task
    // output can run first. Its turn opens on that native evidence.
    if (uuidCorrelated) return;
    const next = pendingTurns.shift();
    if (next === undefined) return;
    // The text was already written to the harness when the send arrived;
    // the id was held to correlate the next turn.
    startTurn(next);
  };

  /** Issue #426: a provisional claude turn met native output that no record
   * attributed to a waiting send - a native turn no send opened, such as
   * background task output. The visible turn is untagged and streams now;
   * the send it was held for waits, unconsumed, for the records naming it.
   * It was written before every other waiting send, so it goes first. */
  const publishUntagged = (): void => {
    if (activeTurn === null || activeTurnPublished) return;
    if (activeTurnOpener !== undefined) pendingTurns.unshift(activeTurnOpener);
    activeTurnOpener = undefined;
    publishTurn();
  };

  /** Issue #426: claude records name the input uuids they answer, and only
   * those name a turn's opener. On a provisional turn the named send opens
   * it: the send held for it, or another waiting send, in which case the
   * held send waits on. On a live turn a named waiting send joined it (a
   * merged input) and gets no turn of its own. Idle, the named send opens
   * the turn. Every named waiting send is consumed once. Correlation is by
   * command, never by caller id, and stays inside this process. */
  const correlateInputUuids = (parsed: Record<string, unknown>): void => {
    const named = readInputUuids(h, parsed);
    if (named.length === 0) return;
    const isNamed = (command: SentCommand | undefined): command is SentCommand =>
      command?.uuid !== undefined && named.includes(command.uuid);
    const consumeNamed = (): void => {
      for (let index = pendingTurns.length - 1; index >= 0; index--) {
        if (isNamed(pendingTurns[index])) pendingTurns.splice(index, 1);
      }
    };
    if (activeTurn !== null && !activeTurnPublished) {
      if (!isNamed(activeTurnOpener)) {
        const chosen = pendingTurns.find(isNamed);
        // Uuids this process never wrote say nothing about its sends.
        if (chosen === undefined) return;
        if (activeTurnOpener !== undefined) pendingTurns.unshift(activeTurnOpener);
        activeTurnOpener = chosen;
      }
      consumeNamed();
      publishTurn();
      return;
    }
    if (activeTurn !== null) {
      consumeNamed();
      return;
    }
    if (dead || closing) return;
    const opener = pendingTurns.find(isNamed);
    if (opener === undefined) return;
    consumeNamed();
    startTurn(opener);
  };

  /** Hold an event for the next published turn, bounded: past the cap
   * droppable events go first, then oldest. */
  const parkEvent = (event: HarnessEvent): Promise<void> => {
    preTurnEvents.push(event);
    if (preTurnEvents.length > PRETURN_MAX) {
      const droppableAt = preTurnEvents.findIndex((e) => DROPPABLE_KINDS.has(e.kind));
      preTurnEvents.splice(droppableAt === -1 ? 0 : droppableAt, 1);
    }
    return Promise.resolve();
  };

  const routeEvent = (event: HarnessEvent): Promise<void> => {
    // Claude run output with no turn open belongs to a native turn no send
    // opened: it gets an untagged turn of its own.
    if (activeTurn === null && uuidCorrelated && !dead && !closing && isRunOutput(event)) {
      startTurn();
    }
    if (event.kind === "limit") {
      state.limitSeen = true;
      turnLimitSeen = true;
    }
    sup.noteEvent(event);
    // A provisional turn is published as its evidence arrives - streaming is
    // never withheld. Only run output is evidence of a run; a failure or
    // error observed locally is owed to the send. Everything else (identity,
    // compaction, usage, progress, question) waits with the turn and flushes
    // into the next published one: pi can compact outside its run markers,
    // and an input it then reports handled ran nothing. On claude only a
    // record naming the send (correlateInputUuids) attributes the run to it,
    // so run output without one is published untagged.
    if (activeTurn !== null && !activeTurnPublished) {
      if (isRunOutput(event)) {
        if (uuidCorrelated) publishUntagged();
        else publishTurn();
      } else if (event.kind === "failure" || event.kind === "error") publishTurn();
      else return parkEvent(event);
    }
    if (activeTurn !== null) {
      if (event.kind === "error" && event.denial !== undefined) turnDenialCount++;
      // Awaited by the pumps: past the channel's high water mark this
      // blocks the pump, so OS pipe backpressure reaches the child.
      return activeTurn.push(event);
    }
    // Between-turn events wait for the next turn.
    return parkEvent(event);
  };

  const pushFailure = (f: FailureSummary): Promise<void> => {
    turnFailures.push(f);
    return routeEvent({ kind: "failure", ...f });
  };

  /** A decoded event other than a failure: a limit also records the
   * failure it stands for, and so does a terminal error, the way
   * streamTurn does. A content-path identity re-emit carrying a later
   * model attestation also re-announces the session identity (same
   * sessionId), so last-takes consumers read the observed model. */
  const routeDecoded = async (event: HarnessEvent): Promise<void> => {
    if (event.kind === "failure") {
      await pushFailure(summaryOf(event));
      return;
    }
    await routeEvent(event);
    if (event.kind === "limit") await pushFailure(failureFromLimit(event.code));
    if (event.kind === "error" && event.terminal === true) {
      const failure = failureFromTerminalError(h, event.message, deps.clock);
      if (isLimitFailure(failure)) {
        state.limitSeen = true;
        turnLimitSeen = true;
      }
      await pushFailure(failure);
    }
  };

  /** The probe answered: bind the announced id under the descriptor's
   * authority, or surface a rotation. The re-announce below keeps a live
   * session's identity current: when a later model attestation arrives on
   * content records, the turn's identity is re-emitted with the observed
   * model filled in (same sessionId, dedupe-by-id consumers see one) -
   * display only, never validation or refusal input. */
  const reannounceIdentity = (): Promise<void> => {
    if (!identityAnnounced || state.observedModel === null) return Promise.resolve();
    if (state.observedModel === state.emittedModel) return Promise.resolve();
    state.emittedModel = state.observedModel;
    const authority = sessionInputMode?.idFlag === null ? "harness-minted" : "caller-assigned";
    return routeEvent({
      kind: "identity",
      sessionId: state.lastSeenId ?? opts.sessionId,
      authority,
      capabilities: capabilitiesWithObserved(),
    });
  };
  const capabilitiesWithObserved = (): CapabilityResult => {
    const caps = capabilitiesOf(h, opts.model ?? "", "headless-session");
    if (state.observedModel === null) return caps;
    return {
      ...caps,
      escalation: {
        ...caps.escalation,
        observedOn: {
          harness: caps.escalation.observedOn?.harness ?? h.name,
          model: state.observedModel,
          version: caps.escalation.observedOn?.version ?? h.verifiedAgainst,
          date: caps.escalation.observedOn?.date ?? "",
        },
      },
    };
  };
  const announceIdentity = async (announced: string): Promise<void> => {
    if (identityAnnounced) return;
    // Kinds that mint identity via the spawn probe (popeye create, codex
    // thread open) buffer sends that arrived before the response; the
    // flush replays them with the minted id bound.
    const flushPreIdentity = (): void => {
      for (const pending of popeyePending.splice(0)) {
        // Re-check busyness at flush time: every pre-identity send
        // recorded idle, but an earlier flush entry may own the turn.
        const busy = activeTurn !== null;
        let written: ReturnType<typeof writeUser>;
        try {
          written = writeUser(pending, busy);
        } catch (cause) {
          if (!(cause instanceof SessionInputRefusalError)) throw cause;
          // send() checked the delivery mode against the descriptor; an
          // encoder refusal here still settles the send, never drops it.
          dropReceipt(pending);
          pending.settle?.({ disposition: "rejected", reason: "unsupported-delivery" });
          continue;
        }
        if (!written.written) continue;
        if (busy && sessionInput.kind !== "codex-jsonrpc") {
          pendingTurns.push(pending);
        } else if (!busy) {
          // Codex defers its turn open to the native receipt; pi/popeye
          // open at write time. Either way the id is now in flight.
          if (sessionInput.kind !== "codex-jsonrpc") startTurn(pending);
        }
      }
    };
    if (sessionInputMode?.idFlag === null) {
      // Harness-MINTED identity (pi rpc: `--session` refuses unknown ids,
      // so fresh sessions omit the flag; popeye and codex mint through the
      // spawn probe). The minted id IS the identity;
      // opts.sessionId stays the caller-side handle.
      identityAnnounced = true;
      state.lastSeenId = announced;
      flushPreIdentity();
      await routeEvent({
        kind: "identity",
        sessionId: announced,
        authority: "harness-minted",
        capabilities: capabilitiesWithObserved(),
      });
      return;
    }
    if (announced === opts.sessionId) {
      identityAnnounced = true;
      await routeEvent({
        kind: "identity",
        sessionId: announced,
        authority: "caller-assigned",
        capabilities: capabilitiesWithObserved(),
      });
      return;
    }
    await routeEvent({
      kind: "error",
      message: `identity rotated: session announced ${JSON.stringify(announced)} but ${opts.sessionId} was requested`,
    });
  };

  const pumpStdout = async (): Promise<void> => {
    // An over-long line is reported when it ends; the pump turns each report
    // into a failure after the lines of the same chunk.
    const overflows: FailureSummary[] = [];
    const lines = new LineBuffer(RUN_LINE_MAX, (overflow) =>
      overflows.push(failureFromLineOverflow("stdout", overflow)),
    );
    // issue #44: a harness that is identity-silent at startup gets the
    // probe its descriptor declares; interpretation encodes it (ADR 0005).
    // Codex's probe is two JSON-RPC lines: initialize (required first,
    // verified 0.159.2) then the thread open - thread/start fresh,
    // thread/resume with the requested id when resuming.
    const probe = encodeIdentityProbe(h, {
      sessionId: opts.sessionId,
      isResume: opts.isResume,
      model: opts.model,
      clientVersion: opts.clientVersion,
    });
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
      correlateInputUuids(parsed);
      switch (record.kind) {
        case "command-accepted": {
          if (record.nativeTurnId !== undefined) activeNativeTurnId = record.nativeTurnId;
          // An answer to a request this process never wrote settles nothing.
          const command = takeReceipt(record.inputId);
          if (command === undefined) return;
          if (record.nativeDisposition === "handled") {
            // Issue #426: pi consumed the input with no run, so no
            // settlement will follow. The provisional turn this send held
            // is retired unseen; anywhere else the receipt opens nothing.
            const opened = activeTurn !== null && activeTurnOpener === command;
            command.settle?.({ disposition: "started" });
            if (opened && !activeTurnOpenerAccepted) {
              if (activeTurnPublished) endTurn({ kind: "done", exitCode: null, cause: "clean" });
              else retireProvisionalTurn();
            }
            return;
          }
          // Started, queued into a run, or a receipt with no disposition:
          // the run this send opened is real.
          if (command === activeTurnOpener) publishTurn();
          // A harness whose turn open is a protocol REQUEST (codex) only
          // starts the hcn turn once the receipt confirms it; a failed
          // open then leaves no stuck empty turn. Prompt-wire harnesses
          // (pi) start the turn at write time, so this is a no-op for
          // them - the turn already exists. Starting BEFORE the receipt
          // settles keeps the turn line ahead of the disposition line.
          // A pi input the harness QUEUED joined a run; when its receipt
          // lands after that run settled it opens no turn.
          if (activeTurn === null && record.nativeDisposition !== "queued") startTurn(command);
          if (command === activeTurnOpener) activeTurnOpenerAccepted = true;
          command.settle?.({ disposition: "started" });
          return;
        }
        case "interrupt-answered": {
          const pending = pendingInterrupts.get(record.token);
          if (pending === undefined) return;
          if (!record.accepted) {
            settleInterrupt(record.token, { state: "rejected", reason: "native-rejected" });
            log({
              event: "interrupt_rejected",
              sessionId: opts.sessionId,
              message: record.message,
            });
          } else if (pending.abortedSeen) {
            settleInterrupt(record.token, { state: "interrupted" });
          } else if (activeTurn === null) {
            // Accepted with no aborted settlement and no run live: the run
            // had already settled normally, or there was none.
            settleInterrupt(record.token, { state: "not-active" });
          } else {
            pending.awaitingSettlement = true;
          }
          return;
        }
        case "identity":
          await announceIdentity(record.sessionId);
          return;
        case "probe-failed": {
          await routeEvent({ kind: "error", message: record.message });
          if (buffersSendsBeforeIdentity(sessionInput)) {
            const failure = failureFromNativeRejection(h, record.message, deps.clock);
            if (sessionFailure === undefined) sessionFailure = failure;
            await pushFailure(failure);
            // Codex rejects stranded sends without opening a phantom turn;
            // popeye keeps them so the first turn carries the refusal.
            if (sessionInput.kind === "codex-jsonrpc") {
              for (const pending of popeyePending.splice(0)) {
                dropReceipt(pending);
                pending.settle?.({ disposition: "rejected", reason: "native-rejected" });
              }
            }
            void close(false);
          }
          return;
        }
        case "command-failed": {
          const command = record.inputId === undefined ? undefined : sentByToken(record.inputId);
          if (command !== undefined) {
            const pendingIndex = pendingTurns.indexOf(command);
            if (pendingIndex >= 0) pendingTurns.splice(pendingIndex, 1);
            // Issue #344: the harness refused the command that opened the
            // turn before acknowledging it. End it so close() cannot hang;
            // a refused later input, even with a reused id, leaves it running.
            const refusedOpener =
              activeTurn !== null && command === activeTurnOpener && !activeTurnOpenerAccepted;
            // A refusal is the turn's outcome: a provisional turn is
            // published before its disposition settles.
            if (refusedOpener) publishTurn();
            command.settle?.({ disposition: "rejected", reason: "native-rejected" });
            if (refusedOpener) {
              await routeEvent({ kind: "error", message: record.message });
              const failure = failureFromNativeRejection(h, record.message, deps.clock);
              await pushFailure(failure);
              // The refused input ran nothing and no settlement will follow:
              // an interrupt already accepted against it settles not-active.
              observeSettlement(false);
              endTurn({ kind: "done", exitCode: null, cause: "clean" });
              return;
            }
          }
          await routeEvent({ kind: "error", message: record.message });
          return;
        }
        case "ignored":
          return;
        case "turn-end": {
          // Issue #426: a uuid-correlated native turn ended that no send
          // opened (claude background task output): a result no record
          // named a send for. It is surfaced as a turn with no input id,
          // never folded into a caller's turn, and a send held for a
          // provisional turn waits on.
          if (uuidCorrelated) {
            if (activeTurn === null && !dead && !closing) startTurn();
            else publishUntagged();
          }
          // The turn-end record still feeds identity dedupe (claude includes
          // session_id on result - a rotation announced there must not be
          // missed) and content decoding, which already surfaces a failed
          // result as an error event; the flag here only classifies the
          // done cause.
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            await routeDecoded(event);
          }
          // The turn is over: a provisional terminal error (pi stopReason
          // error) that no successful assistant message in this turn
          // superseded settles into the turn's verdict now. The events are
          // routed before endTurn so the failure lands inside the closing
          // turn, never in the next one.
          for (const event of settleProvisionalError(state)) {
            await routeDecoded(event);
          }
          if (record.isError) resultError = true;
          endTurn({
            kind: "done",
            exitCode: null,
            cause: turnLimitSeen ? "limit" : resultError ? "crash" : "clean",
          });
          observeSettlement(record.aborted === true);
          return;
        }
        case "content": {
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            await routeDecoded(event);
          }
          // A model attestation decoded on this record postdates the probe
          // identity: re-announce so the turn's identity carries it.
          await reannounceIdentity();
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
      for (const failure of overflows.splice(0)) await pushFailure(failure);
    }
    const rest = lines.flush();
    if (rest !== null) await handleLine(rest);
    for (const failure of overflows.splice(0)) await pushFailure(failure);
  };

  const pumpStderr = async (): Promise<void> => {
    const overflows: FailureSummary[] = [];
    const lines = new LineBuffer(RUN_LINE_MAX, (overflow) =>
      overflows.push(failureFromLineOverflow("stderr", overflow)),
    );
    for await (const chunk of proc.stderr) {
      sup.rearm();
      for (const line of lines.push(chunk)) await sup.stderrLine(line);
      for (const failure of overflows.splice(0)) await pushFailure(failure);
    }
    // Flushed only for an over-long final line's report: an unterminated
    // final stderr line never reached the tail scan, and still does not.
    lines.flush();
    for (const failure of overflows.splice(0)) await pushFailure(failure);
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
    if (pumpError !== null) {
      void routeEvent({ kind: "error", message: `session pump failed: ${String(pumpError)}` });
    }
    // Issue #345: a refused identity probe lands here with popeyePending
    // already drained by the probe-failed arm and sessionFailure set.
    // For a clean exit, that becomes "failed" - the harness did not crash,
    // it refused to open, and the cause must say so. Crash, killed, stall
    // and limit are stronger signals and stay.
    const baseCause: ExitCause = stalled
      ? "stall"
      : state.limitSeen
        ? "limit"
        : exitCode === 0
          ? "clean"
          : exitCode === null
            ? "killed"
            : "crash";
    const cause: ExitCause =
      sessionFailure !== undefined && baseCause === "clean" ? "failed" : baseCause;
    for (const command of awaitingReceipt.values()) {
      command.settle?.({ disposition: "rejected", reason: "closed" });
    }
    awaitingReceipt.clear();
    // A refusal or death resolves every outstanding interrupt explicitly.
    for (const token of [...pendingInterrupts.keys()]) {
      settleInterrupt(token, { state: "rejected", reason: "closed" });
    }
    if (popeyePending.length > 0) {
      const dropped = popeyePending.splice(0);
      // Popeye already reported started, so its buffered send needs a turn
      // to carry the failure. Codex receipts were rejected by the sweep above.
      if (sessionInput.kind === "popeye-rpc-prompt") {
        if (activeTurn === null) {
          const first = dropped[0];
          if (first !== undefined) startTurn(first);
        }
        const ids = dropped.map((pending) => pending.input.id);
        void routeEvent({
          kind: "error",
          message: `${ids.length} buffered send(s) died before session identity: ${ids.join(", ")}`,
        });
      }
    }
    if (pendingTurns.length > 0) {
      const dropped = pendingTurns.splice(0);
      const droppedIds = dropped.map((command) => command.input.id);
      const droppedLengths = dropped.map((command) => command.input.text.length);
      void routeEvent({
        kind: "error",
        message: `${dropped.length} pending send(s) died with the session: ${droppedIds.join(", ")}`,
      });
      log({
        event: "sends_dropped",
        sessionId: opts.sessionId,
        count: dropped.length,
        ids: droppedIds,
        lengths: droppedLengths,
      });
    }
    // Issue #425: the supervisor's credential-access observation settles
    // before the tail fallback; reduction applies precedence. A stall keeps
    // its authority.
    const credential = stalled ? null : sup.credentialAccessFailure(exitCode);
    // A turn still open when the process died settles its provisional
    // terminal error here (pi stopReason error the turn never superseded).
    // Both the failure record and the events enqueue synchronously -
    // routeDecoded defers its failure half past a microtask boundary, which
    // would land it after endTurn's done - so finalize records the failure
    // directly, before endTurn reduces the turn's verdict.
    if (activeTurn !== null) {
      for (const event of settleProvisionalError(state)) {
        const failure = failureFromTerminalError(h, event.message, deps.clock);
        if (isLimitFailure(failure)) {
          state.limitSeen = true;
          turnLimitSeen = true;
        }
        turnFailures.push(failure);
        void routeEvent(event);
        void routeEvent({ kind: "failure", ...failure });
      }
      if (credential !== null) void pushFailure(credential);
      // Issue #341: an open turn at a crash exit gets run mode's
      // stderr-tail verdict. Unlike run mode, done.cause stays crash for
      // every class.
      if (cause === "crash" && turnFailures.length === 0) {
        void pushFailure(failureFromStderrTail(h, exitCode, stderrTail.snapshot()));
      }
    } else {
      // Between-turn walls are parked events, not stderr tail. Never reuse
      // turnFailures here: it still holds the last completed turn's verdict.
      const parked =
        sessionFailure === undefined && (cause === "crash" || cause === "limit")
          ? preTurnEvents.filter((event) => event.kind === "failure").map(summaryOf)
          : [];
      sessionFailure = reduceFailures([
        ...(sessionFailure === undefined ? [] : [sessionFailure]),
        ...parked,
        ...(credential === null ? [] : [credential]),
      ]);
      if (sessionFailure === undefined && cause === "crash") {
        sessionFailure = failureFromStderrTail(h, exitCode, stderrTail.snapshot());
      }
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
      ...(sessionFailure !== undefined ? { failure: sessionFailure } : {}),
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
    controls,
    send(input: SessionInput): SessionSendResult {
      if (dead || closing) throw new SessionClosedError();
      // Issue #426: an explicit mode the descriptor does not list is refused
      // before anything is written or registered; the session stays usable.
      if (input.delivery !== undefined && !controls.deliveryModes.includes(input.delivery)) {
        log({
          event: "send",
          sessionId: opts.sessionId,
          turnId: activeTurnId,
          inputId: input.id,
          delivery: input.delivery,
          disposition: "rejected",
          reason: "unsupported-delivery",
        });
        return { disposition: "rejected", reason: "unsupported-delivery" };
      }
      const wasBusy = activeTurn !== null;
      const command: SentCommand = {
        token: String(++commandSeq),
        input,
        // Claude: every frame carries a native uuid so the records answering
        // it tell a merged input, a queued input's own turn and background
        // output apart. It is private correlation metadata; omitted delivery
        // still sets no priority, so native behavior is unchanged.
        ...(uuidCorrelated ? { uuid: randomUUID() } : {}),
      };
      // Popeye sends before the create response - and codex sends before
      // the thread-open response - wait for identity; the flush replays
      // them with the minted session/thread id bound.
      if (buffersSendsBeforeIdentity(sessionInput) && state.lastSeenId === null) {
        popeyePending.push(command);
        if (sessionInput.kind === "codex-jsonrpc") {
          // The receipt registration exists from now, so the flushed
          // write settles THIS promise.
          return { disposition: "started", settled: awaitReceipt(command) };
        }
        return { disposition: "started" };
      }
      let written: ReturnType<typeof writeUser>;
      try {
        written = writeUser(command, wasBusy);
      } catch (cause) {
        if (!(cause instanceof SessionInputRefusalError)) throw cause;
        return { disposition: "rejected", reason: "unsupported-delivery" };
      }
      if (!written.written) {
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
        // Codex and Pi deliver into the running turn (pi receipts say when
        // a raced send started a run of its own); inputs on the other
        // protocols identify a later native turn, or - claude explicit
        // delivery - the turn whose records name their uuid.
        if (sessionInput.kind !== "codex-jsonrpc" && sessionInput.kind !== "pi-rpc-prompt") {
          pendingTurns.push(command);
        }
      } else if (sessionInput.kind !== "codex-jsonrpc") {
        // Codex opens its hcn turn when the native receipt confirms the
        // turn/start request (command-accepted below); writing the turn
        // open at send time would leave a stuck empty turn on a refusal.
        // A pi prompt may run nothing (handled), so its turn is provisional
        // until the harness shows a run. A claude send's turn is
        // provisional until a record names its uuid: background output can
        // run first.
        startTurn(command, {
          provisional: uuidCorrelated || publishesTurnOnRunEvidence(sessionInput.kind),
        });
      }
      log({
        event: "send",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        inputId: input.id,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        disposition: "started",
      });
      return {
        disposition: "started",
        ...(written.settled === undefined ? {} : { settled: written.settled }),
      };
    },
    interrupt(request: { readonly id: string }): SessionInterruptResult {
      const rejected = (
        reason: "unsupported" | "closed" | "write-failed",
      ): SessionInterruptResult => {
        log({
          event: "interrupt",
          sessionId: opts.sessionId,
          id: request.id,
          state: "rejected",
          reason,
        });
        return { state: "rejected", reason };
      };
      if (!controls.interrupt.supported) return rejected("unsupported");
      if (dead || closing) return rejected("closed");
      const token = String(++commandSeq);
      let line: string;
      try {
        line = encodeSessionInterrupt(sessionInput, token);
      } catch (cause) {
        if (!(cause instanceof SessionInputRefusalError)) throw cause;
        return rejected("unsupported");
      }
      try {
        stdin.write(line);
      } catch {
        // The same broken-pipe path a send takes: nothing more can reach
        // the child, so the session ends through the exit path.
        void routeEvent({ kind: "error", message: "interrupt failed: session stdin is gone" });
        closing = true;
        sup.escalate();
        return rejected("write-failed");
      }
      const settled = new Promise<SessionInterruptReceipt>((resolve) => {
        pendingInterrupts.set(token, { abortedSeen: false, awaitingSettlement: false, resolve });
      });
      log({
        event: "interrupt",
        sessionId: opts.sessionId,
        turnId: activeTurnId,
        id: request.id,
        state: "requested",
      });
      return { state: "requested", settled };
    },
    close,
  };
};
