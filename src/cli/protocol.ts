/**
 * protocol: the TypeScript surface of hcn's two machine streams (issue #441,
 * ADR 0014). `hcn run --json` and `hcn session --json` speak NDJSON; this
 * module names every line of both streams as types, published as the package
 * export `@dungle-scrubs/harness-cli-normalizer/protocol`. The NDJSON
 * protocol stays the contract - non-TypeScript consumers are unchanged - and
 * the CLI writes through these exact types rather than a copy, so a wire
 * change fails the repository's typecheck until this module agrees. Types
 * only: no client, no runtime value, no in-process library. The types
 * describe the wire format of the hcn version they were installed with.
 *
 * `RunEvent` is the whole of `hcn run --json` stdout. `SessionEvent` is the
 * whole of `hcn session --json` stdout: the `session` header, the `turn`
 * markers, every `HarnessEvent` (inside a turn and between turns), the
 * command receipts, the bare `error` lines, and the terminal `closed`.
 * `SessionCommand` is every stdin command `hcn session --json` reads.
 */
import type {
  EscalationDetection,
  EscalationMode,
  EscalationRecord,
  ExitCause,
  HarnessEvent,
  TurnCompletion,
} from "../execution/events.js";
import type { FailureSummary } from "../execution/failure.js";
import type {
  SessionInterruptReceipt,
  SessionInterruptResult,
  SessionSendResult,
  SessionStopBackgroundReceipt,
  SessionStopBackgroundResult,
} from "../execution/open-session.js";
import type {
  SessionApprovalAnswer,
  SessionApprovalDecisionRequest,
} from "../execution/session-approval-tracker.js";
import type {
  SessionSettingsReceipt,
  SessionSettingsRequest,
} from "../execution/session-settings-sequencer.js";
import type {
  CapabilityResult,
  SessionControlsCapability,
} from "../interpretation/capabilities.js";
import type { ToolDenial } from "../interpretation/content.js";
import type { QuestionMode } from "../interpretation/question.js";
import type { RefusalIssue, RefusalOption } from "../interpretation/refusal.js";
import type { SessionApprovalDecision } from "../interpretation/session-approvals.js";
import type {
  AuthFailureKind,
  CompactionState,
  CompactionTrigger,
  DiscoveryFacet,
  HarnessName,
  LimitCode,
  SessionDelivery,
} from "../knowledge/descriptor.js";
import type { NativeApprovalFailure } from "../knowledge/native-approvals.js";

/** The names a consumer needs to spell the three unions and their fields.
 * These are re-exports, not copies: each type keeps the module that owns it.
 * The runner's in-process result types (`SessionSendResult` and its kin) are
 * not here: their `settled` promises never cross the wire. */
export type {
  AuthFailureKind,
  CapabilityResult,
  CompactionState,
  CompactionTrigger,
  DiscoveryFacet,
  EscalationDetection,
  EscalationMode,
  EscalationRecord,
  ExitCause,
  FailureSummary,
  HarnessEvent,
  HarnessName,
  LimitCode,
  NativeApprovalFailure,
  QuestionMode,
  RefusalIssue,
  RefusalOption,
  SessionApprovalAnswer,
  SessionApprovalDecision,
  SessionApprovalDecisionRequest,
  SessionControlsCapability,
  SessionDelivery,
  SessionInterruptReceipt,
  SessionSettingsReceipt,
  SessionSettingsRequest,
  SessionStopBackgroundReceipt,
  ToolDenial,
  TurnCompletion,
};

/** Whether the session opened a new conversation or continued one the
 * harness store already held. */
export type SessionOrigin = "fresh" | "resumed";

/** `send` starts a turn, or joins the harness's own busy-send queue. */
export interface SessionSendCommand {
  readonly op: "send";
  readonly id: string;
  readonly text: string;
  /** An explicit native delivery mode; omitted means the harness's own
   * busy-send behavior. A mode the harness does not support is a
   * malformed command, never a silent fallback. */
  readonly delivery?: SessionDelivery;
  /** Write the text exactly as given, with no question preamble in any
   * questions mode. */
  readonly verbatim?: boolean;
}

/** `answer` replies to the open question of a turn that ended
 * `awaiting-input`. It carries no `verbatim` at all, not even `false`:
 * compose the reply yourself. */
export interface SessionAnswerCommand {
  readonly op: "answer";
  readonly id: string;
  readonly text: string;
  readonly delivery?: SessionDelivery;
}

export interface SessionInterruptCommand {
  readonly op: "interrupt";
  readonly id: string;
}

export interface SessionStopBackgroundCommand {
  readonly op: "stop-background";
  readonly id: string;
  /** The id the job's `background` events carry. */
  readonly job: string;
}

/** One decision on a forwarded permission request. `v: 1` is required on
 * the wire; a command without it is malformed. */
export type SessionApprovalCommand = SessionApprovalDecisionRequest & {
  readonly op: "approval";
  readonly v: 1;
};

/** Change the session's model, effort, or both. At least one of the two is
 * required; a command with neither is malformed. */
export type SessionSettingsCommand = {
  readonly op: "settings";
  readonly id: string;
} & (
  | { readonly model: string; readonly effort?: string }
  | { readonly effort: string; readonly model?: string }
);

export interface SessionCloseCommand {
  readonly op: "close";
}

/**
 * One stdin command of `hcn session --json`, as written on the wire. A line
 * that does not parse into this shape is answered with a bare `error` event
 * and never reaches the harness. Ids are the consumer's own correlation
 * tokens and may repeat.
 */
export type SessionCommand =
  | SessionSendCommand
  | SessionAnswerCommand
  | SessionInterruptCommand
  | SessionStopBackgroundCommand
  | SessionApprovalCommand
  | SessionSettingsCommand
  | SessionCloseCommand;

/** The first line of every session stream: what was opened, and how. */
export interface SessionHeaderEvent {
  readonly kind: "session";
  readonly sessionId: string;
  readonly harness: HarnessName;
  readonly hcn: string;
  readonly questions: QuestionMode;
  readonly origin: SessionOrigin;
  /** The explicit controls this session supports now. Interrupt support can
   * rise while the process runs; every change is re-announced on the
   * `identity` event's `capabilities.sessionControls`. */
  readonly controls: SessionControlsCapability;
}

/** One turn opened on the stream. `id` names the send that opened the turn;
 * native background output has no caller id. */
export interface SessionTurnEvent {
  readonly kind: "turn";
  readonly turnId: string;
  readonly id?: string;
}

/** One send or answer's receipt: the runner's disposition, or the CLI's own
 * refusal of an answer with no open question. */
export interface SessionDispositionEvent {
  readonly kind: "disposition";
  readonly id: string;
  readonly disposition: SessionSendResult["disposition"];
  readonly reason?: SessionSendResult["reason"] | "no-open-question";
}

/** The two-phase receipt of an `interrupt`: `requested` once the request is
 * on the wire, then exactly one terminal state. A refused request answers
 * `rejected` with its reason and no `requested` phase. `interrupted` is the
 * harness's own report that the active run was aborted; `not-active` means
 * an accepted request cancelled no run. */
export interface SessionInterruptionEvent {
  readonly kind: "interruption";
  readonly id: string;
  readonly state: SessionInterruptResult["state"] | SessionInterruptReceipt["state"];
  readonly reason?: SessionInterruptReceipt["reason"];
}

/** The two-phase receipt of a `stop-background`: `requested`, then `sent`
 * when the harness accepted the stop. `sent` names acceptance of the stop
 * REQUEST only - the job's own end arrives as a `background` event. */
export interface SessionBackgroundStopEvent {
  readonly kind: "background-stop";
  readonly id: string;
  readonly state: SessionStopBackgroundResult["state"] | SessionStopBackgroundReceipt["state"];
  readonly reason?: SessionStopBackgroundReceipt["reason"];
}

/** Exactly one receipt per `settings` command, emitted as it settles. */
export type SessionSettingsEvent = {
  readonly kind: "settings";
  readonly id: string;
} & SessionSettingsReceipt;

/** An `error` line. Inside a turn it is the runner's own event and may
 * carry `terminal` and `denial`. Outside any turn the session writes the
 * same shape bare, with `message` alone: a malformed command, a failed
 * command stream, or a settings readback the receipt could not confirm.
 * Informational either way - the stream stays open. This is the
 * `HarnessEvent` error arm, named, so narrowing on `kind` keeps its fields. */
export type SessionErrorEvent = Extract<HarnessEvent, { kind: "error" }>;

/** `closed.cause` never carries `awaiting-input`: that cause ends a turn,
 * never a session. */
export type SessionCloseCause = Exclude<ExitCause, "awaiting-input">;

/** The last line of a session stream that ends in order, with and without
 * `failure`: the failure rides whenever the cause is not clean and a failure
 * was seen. A crash of hcn itself ends the stream with a `failure` and a
 * `done` instead. */
export interface SessionClosedEvent {
  readonly kind: "closed";
  readonly exitCode: number | null;
  readonly cause: SessionCloseCause;
  readonly failure?: FailureSummary;
}

type HarnessDoneEvent = Extract<HarnessEvent, { kind: "done" }>;

/**
 * The one `done` line of both streams. A turn the runner finished carries
 * its `escalation` record. A refusal, a crash and a transport failure end a
 * `--json` stream with a `done` that has a `failure` and no `escalation`,
 * because no turn ran to record a question mode.
 */
export type DoneEvent = Omit<HarnessDoneEvent, "escalation"> & {
  readonly escalation?: EscalationRecord;
};

/** Every runner event except `done`, which the wire widens to `DoneEvent`. */
type StreamedHarnessEvent = Exclude<HarnessEvent, HarnessDoneEvent>;

/** Every line `hcn run --json` writes on stdout. */
export type RunEvent = StreamedHarnessEvent | DoneEvent;

/** Every line `hcn session --json` writes on stdout. */
export type SessionEvent =
  | SessionHeaderEvent
  | SessionTurnEvent
  | StreamedHarnessEvent
  | DoneEvent
  | SessionDispositionEvent
  | SessionInterruptionEvent
  | SessionBackgroundStopEvent
  | SessionSettingsEvent
  | SessionClosedEvent;
