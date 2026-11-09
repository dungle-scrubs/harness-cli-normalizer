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
import {
  buildSessionArgv,
  buildTurnEnv,
  type SessionPermissionOptions,
} from "../interpretation/argv.js";
import {
  type CapabilityResult,
  capabilitiesOf,
  type SessionControlsCapability,
  sessionControlsOf,
} from "../interpretation/capabilities.js";
import { overflowIsEcho } from "../interpretation/overflow.js";
import { composeEscalatedPrompt, type QuestionMode } from "../interpretation/question.js";
import {
  correlatesByInputUuid,
  decodeSessionRecord,
  encodeIdentityProbe,
  encodeSessionInput,
  encodeSessionInterrupt,
  encodeSessionStopBackground,
  hasNativeReceipts,
  publishesTurnOnRunEvidence,
  readInputUuids,
  readInterruptAdvertisement,
  requiresInterruptAdvertisement,
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
import {
  decodeLine,
  decodeParsed,
  freshDecodeState,
  noteStdoutOverflow,
  settleOverflows,
  settleProvisionalError,
} from "./decode.js";
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
import { LineBuffer, type LineOverflow, RUN_LINE_MAX } from "./lines.js";
import {
  createSessionApprovalTracker,
  type SessionApprovalAnswer,
  type SessionApprovalDecisionRequest,
  type SessionApprovalTracker,
} from "./session-approval-tracker.js";
import {
  createSettingsSequencer,
  type SessionSettingsReceipt,
  type SessionSettingsRequest,
  type SettingsSequencer,
} from "./session-settings-sequencer.js";
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
 * delivery mode; omitted, the harness's native busy-send behavior applies.
 * `verbatim` (issue #456) writes the text exactly as given, with no
 * question preamble in any questions mode - how a host types a slash
 * command. */
export interface SessionInput {
  readonly id: string;
  readonly text: string;
  readonly delivery?: SessionDelivery;
  readonly verbatim?: boolean;
}

/** The terminal outcome of an interrupt request (issue #426). `interrupted`
 * is the harness's own report that the active run was cancelled; command
 * acceptance alone is never read as one. `not-active` means the harness
 * reported no run cancelled (it had already settled, or was idle). */
export interface SessionInterruptReceipt {
  readonly state: "interrupted" | "not-active" | "rejected";
  readonly reason?: "unsupported" | "closed" | "write-failed" | "native-rejected";
}

/** Issue #454/#455: one host decision on a forwarded native permission
 * request - the shape the session handle, the tracker and the CLI's
 * stdin op share (one type, not three). `sent` means the native reply
 * was written; a rejected decision names why and nothing was written.
 * A decision is consumed before its write and never retried. The
 * answer outcome type lives with the tracker. */

/** `requested`: the native cancellation request was written, and `settled`
 * resolves exactly once with the terminal receipt. `rejected`: nothing was
 * written. */
export type SessionInterruptResult =
  | { readonly state: "requested"; readonly settled: Promise<SessionInterruptReceipt> }
  | { readonly state: "rejected"; readonly reason: "unsupported" | "closed" | "write-failed" };

/** The receipt a stop-background request settles with. `sent` says the
 * harness accepted the stop REQUEST - never that the job ended: the job's
 * own end arrives on the stream as a `background` event. */
export interface SessionStopBackgroundReceipt {
  readonly state: "sent" | "rejected";
  readonly reason?: "unsupported" | "closed" | "write-failed" | "native-rejected";
}

export type SessionStopBackgroundResult =
  | { readonly state: "requested"; readonly settled: Promise<SessionStopBackgroundReceipt> }
  | { readonly state: "rejected"; readonly reason: "unsupported" | "closed" | "write-failed" };

export interface SessionHandle {
  /** One inner iterable per turn, each ending in a turn-scoped `done`.
   * Breaking out of THIS iterable closes the session; breaking out of a
   * single turn's iterable only stops reading that turn. */
  readonly turns: AsyncIterable<SessionTurn>;
  /** Events no turn owns, delivered the moment they arrive: today only
   * `background`, a job's life between turns (claude's background tasks
   * finish after `result`). A bounded channel with the same backpressure
   * as a turn's iterable; it ends when the session ends, after delivering
   * what it holds, so a job's end never waits for a turn that never opens
   * and is never dropped on close. Breaking out of it only stops reading
   * it - `turns` alone owns the session's lifetime. */
  readonly outOfTurn: AsyncIterable<HarnessEvent>;
  /** The explicit controls this session supports now. Issue #429: claude
   * interrupt support is what the running process advertised on its latest
   * system/init, so it reads unsupported until then and can change; every
   * change is re-announced on the identity event's
   * capabilities.sessionControls. */
  readonly controls: SessionControlsCapability;
  send(input: SessionInput): SessionSendResult;
  /** Request cancellation of the active turn while the process continues.
   * Carries no replacement text: the caller sends that after the receipt. */
  interrupt(request: { readonly id: string }): SessionInterruptResult;
  /** Stop one background job by the id its `background` events carry,
   * while the process continues. The receipt never claims the job ended:
   * the job's own end arrives as a `background` event. */
  stopBackground(request: {
    readonly id: string;
    readonly job: string;
  }): SessionStopBackgroundResult;
  /** Issue #454/#455: answer one forwarded permission request. Exactly one
   * answer right per request: answered once, cleared never again. */
  answerApproval(decision: SessionApprovalDecisionRequest): SessionApprovalAnswer;
  /** Issue #456: change the model and/or effort of this session. Takes
   * effect from the next model request; a busy turn is not interrupted.
   * Resolves with exactly one receipt. */
  settings(request: SessionSettingsRequest): Promise<SessionSettingsReceipt>;
  close(): Promise<void>;
}

export interface OpenSessionOptions extends SessionPermissionOptions {
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
  /** Issue #454/#455: arm the harness's native permission channel
   * (`--permission-prompt-tool stdio` on claude) so each permission-gated
   * tool call is forwarded to the session host as an approval-request
   * event. Without it nothing changes: no channel is armed and the child
   * answers its own permission gates the way a bare session does. */
  readonly nativeApprovals?: boolean;
  /** Issue #457: which settings scopes the session child loads (claude's
   * --setting-sources). The descriptor's default renders when omitted. */
  readonly settingSources?: readonly string[];
}

// The approval-decision and settings-op request shapes, and the receipt
// they settle with, live with their owners (the tracker and the
// sequencer) and are re-exported here: one type each for the session
// handle, the CLI's stdin ops and their modules.
export type {
  SessionApprovalAnswer,
  SessionApprovalDecisionRequest,
} from "./session-approval-tracker.js";
export type {
  SessionSettingsReceipt,
  SessionSettingsRequest,
} from "./session-settings-sequencer.js";

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

/** True for harnesses whose sends are written one at a time, each only
 * after the previous send's native receipt. pi answers rpc commands
 * asynchronously: a send written while another's receipt is still
 * outstanding can be handled first - pi starts the later steer's run and
 * refuses the earlier unflagged prompt ("Agent is already processing") -
 * so back-to-back writes race inside the harness. Holds keep the write
 * order instead; when the input runs stays the harness's own decision
 * (steer, followUp), so this gates the wire, not the queue (ADR 0007). */
const gatesSendsOnReceipt = (input: SessionInputContract): boolean =>
  input.kind === "pi-rpc-prompt";

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

/** The outcome a settled target run gives an accepted interrupt. */
type TargetSettlement = SessionInterruptReceipt & { readonly state: "interrupted" | "not-active" };

/** Where an interrupt stands. Until the harness answers it, the target's
 * settlement may already have arrived (a natural completion can precede the
 * acknowledgement) and is held for the answer; once accepted, only the
 * target's own settlement decides the receipt. */
type InterruptPhase =
  | { readonly kind: "awaiting-receipt"; readonly settlement: TargetSettlement | null }
  | { readonly kind: "awaiting-settlement" };

/** An interrupt request written to the harness and not yet settled. */
interface PendingInterrupt {
  /** The caller's request id, for the log lines that correlate the request
   * with its outcome. */
  readonly id: string;
  /** The turn live when the request was written, or null when idle. Caller
   * ids repeat and the published turn id is assigned late (a provisional
   * turn has none yet), so the turn is held by its own channel. */
  readonly target: AsyncChannel<HarnessEvent> | null;
  phase: InterruptPhase;
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
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.excludeTools !== undefined ? { excludeTools: opts.excludeTools } : {}),
    ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}),
    ...(opts.access !== undefined ? { access: opts.access } : {}),
    ...(opts.toolMap !== undefined ? { toolMap: opts.toolMap } : {}),
    ...(opts.discovery !== undefined ? { discovery: opts.discovery } : {}),
    ...(opts.nativeApprovals === true ? { nativeApprovals: true } : {}),
    ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
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
  // Events no turn owns (today only `background`): their own bounded
  // channel, closed with the session after delivering what it holds. The
  // stdout pump awaits its pushes like a turn's, so pipe backpressure
  // reaches the child here too (review round 1, C1).
  const outOfTurnChannel = new AsyncChannel<HarnessEvent>();
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
  // Receipt-gated sends (pi): arrived from the caller but not yet written,
  // oldest first. They pre-register their receipt above, so a session that
  // dies while they wait still settles them; nothing is dropped silently.
  const heldSends: SentCommand[] = [];
  // The gated send currently on the wire, awaiting its receipt. Exactly one
  // at a time: while set - or while a hold exists - `send` parks the input
  // in heldSends instead of writing it. Only the receipt that settles THIS
  // command frees the gate (freeGate), never an unrelated answer.
  let gatedInFlight: SentCommand | undefined;
  // False until the wire can carry no more writes: the stdin pipe broke,
  // the session was abandoned, or close() has ended stdin. A draining
  // close keeps it open until EOF so holds still reach the harness while
  // the last turn finishes (issue #99's EOF-lets-the-turn-finish promise,
  // extended to holds).
  let wireClosed = false;
  let commandSeq = 0;
  const uuidCorrelated = correlatesByInputUuid(sessionInput.kind);
  // Issue #454/#455: whether this session forwards native permission
  // requests to its host - a spawn property (--native-approvals on a
  // harness whose descriptor declares the channel), unlike interrupt
  // support which the running claude process advertises per init.
  const approvalsArmed = opts.nativeApprovals === true && h.sessionMode?.controls.approvals != null;
  const potentialControls: SessionControlsCapability = sessionControlsOf(h) ?? {
    deliveryModes: [],
    interrupt: { supported: false },
    approvals: { supported: false },
    stopBackground: { supported: false },
  };
  // Issue #429: the descriptor states what the harness can do; a kind whose
  // process advertises its interrupt support offers it only once a record
  // says so (claude system/init), and each later init can change it.
  const controlsWith = (advertised: boolean): SessionControlsCapability =>
    advertised
      ? { ...potentialControls, approvals: { supported: approvalsArmed } }
      : {
          ...potentialControls,
          interrupt: { supported: false },
          approvals: { supported: approvalsArmed },
        };
  let controls = controlsWith(!requiresInterruptAdvertisement(sessionInput.kind));
  // The last identity routed, stamped with the controls current then: a
  // later change re-announces it.
  let lastIdentity: (HarnessEvent & { kind: "identity" }) | null = null;
  const pendingInterrupts = new Map<string, PendingInterrupt>();
  // Stop-background requests written and not yet answered, by their wire
  // token. Unlike an interrupt there is no target turn to observe: the
  // control_response alone settles the receipt, and the job's own end
  // arrives independently as a `background` event.
  type PendingStopBackground = {
    readonly id: string;
    readonly resolve: (receipt: SessionStopBackgroundReceipt) => void;
  };
  const pendingStopBackgrounds = new Map<string, PendingStopBackground>();
  // Issue #454/#455: the approval ledger (extracted, review round 1 F12).
  // Waiting requests keep their full proposal; an answered id becomes a
  // bounded tombstone (already-answered); a cleared request is deleted
  // (unknown-request). The pending set is capped like the Codex lane's.
  // Nothing persists across processes - the caller owns durable choice
  // records.
  const approvals: SessionApprovalTracker = createSessionApprovalTracker({
    sessionId: opts.sessionId,
    announcedSessionId: () => state.lastSeenId ?? opts.sessionId,
    log,
    routeEvent: (event) => routeEvent(event),
    pauseInactivity: () => sup.pauseInactivity(),
    resumeInactivity: () => sup.resumeInactivity(),
    isClosed: () => dead || closing,
    write: (line) => {
      stdin.write(line);
    },
    onWriteFailed: () => {
      // The same broken-pipe path a send takes: nothing more can reach
      // the child, so the session ends through the exit path.
      void routeEvent({
        kind: "error",
        message: "approval decision failed: session stdin is gone",
      });
      closing = true;
      wireClosed = true;
      sup.escalate();
    },
    turnId: () => activeTurnId,
  });
  // Issue #456: the settings sequencer (extracted, review round 1 F12).
  // One op on the wire at a time; pi reads its model catalog before a
  // model write and its effective state after the writes. settingsModel
  // tracks the last applied model so a later op's effort ladder follows
  // the model the session actually runs, not the spawn one (F14).
  let settingsModel = opts.model;
  const settings: SettingsSequencer = createSettingsSequencer(h, sessionInput, {
    sessionId: opts.sessionId,
    log,
    isClosed: () => dead || closing,
    write: (line) => {
      stdin.write(line);
    },
    onWriteFailed: () => {
      void routeEvent({ kind: "error", message: "settings write failed: session stdin is gone" });
      closing = true;
      wireClosed = true;
      sup.escalate();
    },
    ...(opts.provider !== undefined ? { sessionProvider: opts.provider } : {}),
    currentModel: () => settingsModel,
    onModelResolved: (model) => {
      settingsModel = model;
    },
    nextToken: () => String(++commandSeq),
  });
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
    log({
      event: "interrupt_settled",
      sessionId: opts.sessionId,
      id: pending.id,
      token,
      ...receipt,
    });
    pending.resolve(receipt);
  };
  const settleStopBackground = (token: string, receipt: SessionStopBackgroundReceipt): void => {
    const pending = pendingStopBackgrounds.get(token);
    if (pending === undefined) return;
    pendingStopBackgrounds.delete(token);
    log({
      event: "stop_background_settled",
      sessionId: opts.sessionId,
      id: pending.id,
      token,
      ...receipt,
    });
    pending.resolve(receipt);
  };
  /** The shared half of every session control write (an interrupt, a
   * stop-background): the refusal ladder - unsupported, closed, or a
   * refusal by the encoder, all writing nothing and leaving the session
   * usable - then the write, whose failure is the same broken stdin pipe
   * a send takes, so the session ends through the exit path. On success
   * the pending registration and the requested log line, keyed by the
   * wire token the native answer settles. Each control keeps its own
   * settlement semantics; only the write is shared. */
  const writeControl = <R, E extends { readonly resolve: (receipt: R) => void }>(op: {
    readonly event: string;
    readonly rejectedLog: Record<string, unknown>;
    readonly requestedLog: Record<string, unknown>;
    readonly supported: boolean;
    readonly encode: (token: string) => string;
    readonly failMessage: string;
    readonly pending: Map<string, E>;
    readonly entry: (resolve: (receipt: R) => void) => E;
  }):
    | { readonly ok: true; readonly settled: Promise<R> }
    | { readonly ok: false; readonly reason: "unsupported" | "closed" | "write-failed" } => {
    const rejected = (reason: "unsupported" | "closed" | "write-failed") => {
      log({
        event: op.event,
        sessionId: opts.sessionId,
        ...op.rejectedLog,
        state: "rejected",
        reason,
      });
      return { ok: false as const, reason };
    };
    if (!op.supported) return rejected("unsupported");
    if (dead || closing) return rejected("closed");
    const token = String(++commandSeq);
    let line: string;
    try {
      line = op.encode(token);
    } catch (cause) {
      if (!(cause instanceof SessionInputRefusalError)) throw cause;
      return rejected("unsupported");
    }
    try {
      stdin.write(line);
    } catch {
      // The same broken-pipe path a send takes: nothing more can reach
      // the child, so the session ends through the exit path.
      void routeEvent({ kind: "error", message: op.failMessage });
      closing = true;
      wireClosed = true;
      sup.escalate();
      return rejected("write-failed");
    }
    let resolveReceipt!: (receipt: R) => void;
    const settled = new Promise<R>((resolve) => {
      resolveReceipt = resolve;
    });
    op.pending.set(token, op.entry(resolveReceipt));
    log({
      event: op.event,
      sessionId: opts.sessionId,
      ...op.requestedLog,
      token,
      state: "requested",
    });
    return { ok: true as const, settled };
  };
  /** The run of `turn` settled. It decides only the requests written while
   * that turn was live: an accepted one settles now, an unanswered one holds
   * the first outcome for its answer. Another turn's settlement never
   * touches them. */
  const observeSettlement = (turn: AsyncChannel<HarnessEvent> | null, aborted: boolean): void => {
    if (turn === null) return;
    const settlement: TargetSettlement = { state: aborted ? "interrupted" : "not-active" };
    for (const [token, pending] of [...pendingInterrupts]) {
      if (pending.target !== turn) continue;
      if (pending.phase.kind === "awaiting-settlement") settleInterrupt(token, settlement);
      else if (pending.phase.settlement === null) {
        pending.phase = { kind: "awaiting-receipt", settlement };
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
    // Verbatim sends (issue #456) skip the question preamble in every
    // questions mode - a slash command must reach the harness as typed.
    const text =
      input.verbatim === true
        ? input.text
        : composeEscalatedPrompt(input.text, questionMode, "session");
    const line = encodeSessionInput(sessionInput, text, {
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
    });
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
      wireClosed = true;
      sup.escalate();
      return { written: false };
    }
  };

  /** Write the next held send, if any. Runs once the gated wire is free:
   * the holds leave in their arrival order, and busyness is re-read at
   * write time, the way the pre-identity flush re-reads it, because the
   * turn state can have changed while the send waited. */
  const writeNextHold = (): void => {
    if (dead || wireClosed) return;
    const next = heldSends.shift();
    if (next === undefined) return;
    gatedInFlight = next;
    const busy = activeTurn !== null;
    let written: ReturnType<typeof writeUser>;
    try {
      written = writeUser(next, busy);
    } catch (cause) {
      if (!(cause instanceof SessionInputRefusalError)) throw cause;
      // The same settlement send() gives an encoder refusal, logged the
      // same way; the wire is free, so the next hold still gets its turn.
      dropReceipt(next);
      gatedInFlight = undefined;
      log({
        event: "send",
        sessionId: opts.sessionId,
        inputId: next.input.id,
        disposition: "rejected",
        reason: "unsupported-delivery",
      });
      next.settle?.({ disposition: "rejected", reason: "unsupported-delivery" });
      writeNextHold();
      return;
    }
    if (!written.written) return;
    if (!busy) {
      // The same provisional open an idle send() gets: a gated prompt can
      // still run nothing (handled), so the turn publishes on run evidence.
      startTurn(next, { provisional: true });
    }
    log({
      event: "send",
      sessionId: opts.sessionId,
      turnId: activeTurnId,
      inputId: next.input.id,
      ...(next.input.delivery === undefined ? {} : { delivery: next.input.delivery }),
      disposition: "started",
    });
  };

  /** The receipt that settled `command` frees the gated wire, and the next
   * held send, if any, is written now. Identity-checked: an answer that
   * settles anything but the in-flight gated send - an old waiting input,
   * a duplicated answer - frees nothing, so it cannot reopen the race the
   * gate exists to close. */
  const freeGate = (command: SentCommand): void => {
    if (command !== gatedInFlight) return;
    gatedInFlight = undefined;
    writeNextHold();
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
    const retired = activeTurn;
    sup.disarm();
    sup.close();
    activeTurn.close();
    clearActiveTurn();
    observeSettlement(retired, false);
  };

  const endTurn = (
    done: Omit<HarnessEvent & { kind: "done" }, "escalation" | "denialCount">,
  ): void => {
    if (activeTurn === null) return;
    // A provisional turn that ends any other way (settlement, stall,
    // death) had a run, or owes a failure: it is published first.
    publishTurn();
    // Issue #454: a request that was still waiting when its turn ended
    // loses its answer right; the cleared event lands inside that turn,
    // ahead of its done. An answered one already stopped waiting. (No
    // stall resync here: the supervisor is disarmed immediately below,
    // so resuming would only arm a timer nothing uses - review round 1,
    // F14.)
    approvals.clearTurn(activeTurn as object);
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

  const routeEvent = (incoming: HarnessEvent): Promise<void> => {
    // Every identity carries the session's current controls, not the
    // descriptor's potential ones (issue #429).
    const event: HarnessEvent =
      incoming.kind === "identity"
        ? { ...incoming, capabilities: { ...incoming.capabilities, sessionControls: controls } }
        : incoming;
    if (event.kind === "identity") lastIdentity = event;
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
    // A background event no turn owns reaches the caller at once on the
    // session's out-of-turn channel: a job's end can arrive after the last
    // turn and must not wait for - or die with - a turn that never opens.
    // It never opens a turn of its own (background is not run output).
    if (event.kind === "background") return outOfTurnChannel.push(event);
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
  /** Issue #429: an init changed the controls the last identity carried:
   * re-announce it (same session id and model) so a caller reading the
   * latest identity sees what the process supports now. */
  const reannounceControls = (): Promise<void> => {
    if (lastIdentity === null) return Promise.resolve();
    const announced = lastIdentity.capabilities.sessionControls?.interrupt.supported;
    if (announced === controls.interrupt.supported) return Promise.resolve();
    return routeEvent(lastIdentity);
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
    // An over-long line is reported when it ends. The report is judged
    // where it happened: an echo record (one that only repeats what hcn
    // already read) warns at once, and any other overflow is held as
    // pending evidence until a later assistant message supersedes it or
    // the turn ends. Outside a turn there is nothing to hold the evidence
    // for and no turn to settle it against, so it keeps today's
    // behaviour: a parked failure.
    const lines = new LineBuffer(RUN_LINE_MAX);
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
      const advertised = readInterruptAdvertisement(h, parsed);
      if (advertised !== null) controls = controlsWith(advertised);
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
              if (activeTurnPublished) {
                const ending = activeTurn;
                endTurn({ kind: "done", exitCode: null, cause: "clean" });
                observeSettlement(ending, false);
              } else retireProvisionalTurn();
            }
            // The receipt settled its send, so a gated wire is free again.
            freeGate(command);
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
          // The receipt settled its send, so a gated wire is free again.
          freeGate(command);
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
              id: pending.id,
              token: record.token,
            });
          } else if (pending.phase.kind === "awaiting-settlement") {
            // A repeated acknowledgement: the request is already bound.
          } else if (pending.target === null) {
            // Written while idle: whatever runs now is not its target.
            settleInterrupt(record.token, { state: "not-active" });
          } else if (pending.phase.settlement !== null) {
            settleInterrupt(record.token, pending.phase.settlement);
          } else {
            pending.phase = { kind: "awaiting-settlement" };
          }
          return;
        }
        case "stop-background-answered": {
          // The control_response is the whole receipt: accepted says the
          // stop request was sent, an error says the harness refused it.
          // The job's own end arrives separately as a `background` event.
          settleStopBackground(
            record.token,
            record.ok ? { state: "sent" } : { state: "rejected", reason: "native-rejected" },
          );
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
              observeSettlement(activeTurn, false);
              endTurn({ kind: "done", exitCode: null, cause: "clean" });
              // A refusal settles the send it names, so a gated wire is
              // free again: the next held send is written now.
              freeGate(command);
              return;
            }
          }
          await routeEvent({ kind: "error", message: record.message });
          // Only a failure that settles a send this process wrote can free
          // the gated wire; freeGate itself ignores every other answer.
          if (command !== undefined) freeGate(command);
          return;
        }
        case "approval-request": {
          // Issue #454/#455: the child asked the host about a tool use.
          // Without --native-approvals no channel was armed and the child
          // raises none; an unexpected one is dropped, never half-forwarded.
          if (!approvalsArmed) return;
          // A request the tracker already knows (waiting, or answered) is
          // a replay: it gets none of a first sighting's side effects - in
          // particular it must not open a new turn after its own ended.
          if (!approvals.isKnown(record.requestId)) {
            // The event rides inside the current turn: a provisional turn
            // publishes like any other run output would, and with no turn
            // open the request opens one of its own (untagged).
            if (activeTurn !== null && !activeTurnPublished) publishUntagged();
            else if (activeTurn === null && !dead && !closing) startTurn();
          }
          // Awaited: past the turn channel's high-water mark this blocks
          // the stdout pump, so a flooding child meets its consumer's
          // pace instead of buffering unbounded request events.
          await approvals.offer(record.requestId, record.proposal, activeTurn);
          // A request arriving while a closing drain waits on this turn
          // can never be answered (the command stream has ended), so the
          // wait is now unbounded: wake the drain, whose re-check breaks
          // out and ends stdin instead.
          if (closing && turnSettled !== null) {
            const release = turnSettled;
            turnSettled = null;
            release();
          }
          return;
        }
        case "approval-cancelled": {
          // Issue #454: the child cancelled its own request (an interrupt
          // while it waited). The answer right is gone either way. The
          // cleared event's delivery is awaited for the same backpressure
          // as the request itself.
          await approvals.cancel(record.requestId);
          return;
        }
        case "settings-answered": {
          // Synchronous: the op's settlement (and any queued op it drains
          // into) completes before this call returns, so the pump reads
          // the next line only after it - a queued
          // op's dispatch validation reads the model this settlement
          // applied (review round 2, G8; round 3, H4).
          settings.onAnswered(record);
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
          // done cause. A typed aborted settlement is cancellation in a
          // session; leave the generic reader's one-shot verdict unchanged.
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            if (record.aborted === true && event.kind === "error" && event.terminal === true) {
              continue;
            }
            await routeDecoded(event);
          }
          // The turn is over: a provisional terminal error (pi stopReason
          // error) that no successful assistant message in this turn
          // superseded settles into the turn's verdict now, and so do the
          // stdout overflows. The events are routed before endTurn so the
          // failure lands inside the closing turn, never in the next one.
          // A turn that ended successfully warns about the overflows it
          // recovered from; one that ended in an error or a cancellation
          // fails on them.
          const succeeded = !record.isError && record.aborted !== true;
          for (const event of settleOverflows(state, succeeded)) {
            await routeDecoded(event);
          }
          for (const event of settleProvisionalError(state)) {
            await routeDecoded(event);
          }
          if (record.isError) resultError = true;
          const ending = activeTurn;
          endTurn({
            kind: "done",
            exitCode: null,
            cause: turnLimitSeen ? "limit" : resultError ? "crash" : "clean",
          });
          observeSettlement(ending, record.aborted === true);
          return;
        }
        case "content": {
          for (const event of decodeParsed(h, parsed, state, opts.model ?? "")) {
            await routeDecoded(event);
          }
          // A model attestation decoded on this record postdates the probe
          // identity: re-announce so the turn's identity carries it.
          await reannounceIdentity();
          if (advertised !== null) await reannounceControls();
          return;
        }
        default: {
          const exhaustive: never = record;
          return exhaustive;
        }
      }
    };
    const handleOverflow = async (overflow: LineOverflow): Promise<void> => {
      if (activeTurn === null && !overflowIsEcho(h, overflow.head)) {
        // No turn to hold the evidence for: the overflow stays a parked
        // failure, the way it was before the evidence rule. An echo record
        // lost nothing wherever it lands, so it warns between turns too.
        await pushFailure(failureFromLineOverflow("stdout", overflow));
        return;
      }
      const event = noteStdoutOverflow(h, state, overflow);
      if (event !== null) await routeEvent(event);
    };
    for await (const chunk of proc.stdout) {
      sup.rearm();
      // The items arrive in stream order: a discarded line is judged
      // before the lines that came after it, so an assistant message
      // supersedes only the overflows that preceded it.
      for (const item of lines.pushItems(chunk)) {
        if (item.kind === "line") await handleLine(item.text);
        else await handleOverflow(item.overflow);
      }
    }
    for (const item of lines.flushItems()) {
      if (item.kind === "line") await handleLine(item.text);
      else await handleOverflow(item.overflow);
    }
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
    // Issue #456: every settings op still awaiting a native answer dies
    // with the process; each is owed its one receipt, queued ones too -
    // they never reached the wire, but the receipt must still arrive.
    settings.closeAll();
    // Issue #454: every request still waiting dies with the process. The
    // cleared events land before the dying turn's done; with no turn open
    // they park with the other pre-turn events.
    approvals.clearAll();
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
    // Held sends died with the session too. Their receipts were
    // pre-registered, so the sweep above already settled each rejected
    // (closed); nothing may be written now.
    heldSends.length = 0;
    gatedInFlight = undefined;
    // A refusal or death resolves every outstanding interrupt explicitly.
    for (const token of [...pendingInterrupts.keys()]) {
      settleInterrupt(token, { state: "rejected", reason: "closed" });
    }
    // Every stop-background request still awaiting its answer too.
    for (const token of [...pendingStopBackgrounds.keys()]) {
      settleStopBackground(token, { state: "rejected", reason: "closed" });
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
    // terminal error here (pi stopReason error the turn never superseded),
    // and so do the stdout overflows it held: the turn did not complete,
    // so they fail. Both the failure record and the events enqueue
    // synchronously - routeDecoded defers its failure half past a
    // microtask boundary, which would land it after endTurn's done - so
    // finalize records the failure directly, before endTurn reduces the
    // turn's verdict.
    const overflowEvents = settleOverflows(state, false);
    if (activeTurn !== null) {
      for (const event of overflowEvents) {
        if (event.kind === "failure") turnFailures.push(summaryOf(event));
        void routeEvent(event);
      }
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
        ...overflowEvents.filter((event) => event.kind === "failure").map(summaryOf),
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
    // Ends the out-of-turn iterable after delivering what it holds: the
    // events routed above are already in the channel, and push-after-close
    // is the channel's own no-op.
    outOfTurnChannel.close();
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

  // Issue #456 (review round 1, F3): a stdin write can fail
  // asynchronously - the child closes its stdin but keeps running, so no
  // synchronous throw ever fires and an in-flight settings op would wait
  // forever. The adapter's inputError promise is the real signal: settle
  // every in-flight and queued settings op write-failed, clear waiting
  // approvals channel-failed, and end the session the way the broken
  // send pipe does (the exit path then finalizes as usual).
  void proc.inputError?.then(() => {
    if (dead || closing) return;
    void routeEvent({ kind: "error", message: "session stdin failed: the input pipe broke" });
    closing = true;
    wireClosed = true;
    settings.writeFailedAll();
    approvals.clearChannel();
    sup.escalate();
  });

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
  // consumer asking politely: an open turn gets to finish first, and every
  // accepted send still reaches the harness, because the consumer is still
  // there to receive it. ABANDONMENT is the consumer walking away from the
  // turns iterable: nobody is left to receive a turn, so stdin ends at
  // once and the child is reaped, not drained.
  const close = async (drain = true): Promise<void> => {
    if (closing) return shutdown;
    closing = true;
    if (drain === false) wireClosed = true;
    // The drain waits for the open turn; a held send rides inside that
    // wait, written as its receipt frees the gate while the closing turn
    // is still open. The wait is a re-checking loop, because a receipt can
    // retire the turn and free a hold onto the wire in one synchronous
    // step: the woken close then sees the hold's own turn and waits again.
    // A turn that ends before its prompt's receipt ends the loop the same
    // way - EOF proceeds and the still-held sends settle rejected (closed)
    // - so a harness that never answers cannot hang the close. Death ends
    // the loop unconditionally (the exited handler releases the waiter);
    // once stdin ends below, the usual close grace bounds the rest.
    // Issue #454: a turn blocked on a permission request the host never
    // answered can settle only through that answer, and once close() runs
    // no decision can arrive (the command stream has ended). Waiting would
    // hang forever with the stall clock paused, so the drain gives up on
    // it: stdin ends, the harness dies, and the exit path clears the
    // request (process-ended) and ends the turn with the exit cause.
    const blockedOnApproval = (): boolean =>
      activeTurn !== null && approvals.isWaitingOn(activeTurn);
    while (drain && !dead && activeTurn !== null) {
      if (blockedOnApproval()) break;
      await new Promise<void>((resolve) => {
        turnSettled = resolve;
      });
    }
    // The wire is closed the moment stdin ends: a receipt the harness still
    // owes can arrive after EOF, and it must settle its send without
    // pushing a hold into the ended pipe (a real adapter reports such a
    // write as delivered, opening a phantom turn for input the harness
    // never saw).
    wireClosed = true;
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
    outOfTurn: (async function* () {
      for await (const event of outOfTurnChannel) yield event;
    })(),
    get controls() {
      return controls;
    },
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
      // A gated kind holds the send while an earlier send's receipt is
      // still outstanding (or earlier holds wait): pi would otherwise
      // handle the two writes out of order. The receipt registration
      // exists from now, so the eventual write settles this promise and a
      // session that dies while it waits settles it too - a hold is never
      // left hanging.
      if (
        gatesSendsOnReceipt(sessionInput) &&
        (gatedInFlight !== undefined || heldSends.length > 0)
      ) {
        heldSends.push(command);
        log({
          event: "send",
          sessionId: opts.sessionId,
          turnId: activeTurnId,
          inputId: input.id,
          ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          disposition: "held",
        });
        return { disposition: "started", settled: awaitReceipt(command) };
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
      if (gatesSendsOnReceipt(sessionInput)) gatedInFlight = command;
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
      // Bound before the write: the harness may answer for this turn after
      // another one has opened.
      const target = activeTurn;
      const targetTurnId = target !== null && activeTurnPublished ? activeTurnId : undefined;
      const written = writeControl<SessionInterruptReceipt, PendingInterrupt>({
        event: "interrupt",
        rejectedLog: { id: request.id },
        requestedLog: {
          ...(targetTurnId === undefined ? {} : { turnId: targetTurnId }),
          id: request.id,
        },
        supported: controls.interrupt.supported,
        encode: (token) => encodeSessionInterrupt(sessionInput, token),
        failMessage: "interrupt failed: session stdin is gone",
        pending: pendingInterrupts,
        entry: (resolve): PendingInterrupt => ({
          id: request.id,
          target,
          phase: { kind: "awaiting-receipt", settlement: null },
          resolve,
        }),
      });
      if (!written.ok) return { state: "rejected", reason: written.reason };
      return { state: "requested", settled: written.settled };
    },
    stopBackground(request: {
      readonly id: string;
      readonly job: string;
    }): SessionStopBackgroundResult {
      // A descriptor fact, not a process advertisement: a harness without
      // the native stop is refused here, nothing is written, and the
      // session stays usable.
      const written = writeControl<SessionStopBackgroundReceipt, PendingStopBackground>({
        event: "stop_background",
        rejectedLog: { id: request.id, job: request.job },
        requestedLog: { id: request.id, job: request.job },
        supported: controls.stopBackground.supported,
        encode: (token) => encodeSessionStopBackground(sessionInput, token, request.job),
        failMessage: "stop-background failed: session stdin is gone",
        pending: pendingStopBackgrounds,
        entry: (resolve) => ({ id: request.id, resolve }),
      });
      if (!written.ok) return { state: "rejected", reason: written.reason };
      return { state: "requested", settled: written.settled };
    },
    answerApproval(decision: SessionApprovalDecisionRequest): SessionApprovalAnswer {
      return approvals.answer(decision);
    },
    settings(request: SessionSettingsRequest): Promise<SessionSettingsReceipt> {
      return settings.submit(request);
    },
    close,
  };
};
