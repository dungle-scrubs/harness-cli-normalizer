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
  LimitCode,
  SessionDelivery,
} from "../knowledge/descriptor.js";
import type { NativeApprovalFailure } from "../knowledge/native-approvals.js";

/** The names a consumer needs to spell the three unions and their fields.
 * These are re-exports, not copies: each type keeps the module that owns it. */
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
  SessionInterruptResult,
  SessionSendResult,
  SessionSettingsReceipt,
  SessionSettingsRequest,
  SessionStopBackgroundReceipt,
  SessionStopBackgroundResult,
  ToolDenial,
  TurnCompletion,
};

/** Whether the session opened a new conversation or continued one the
 * harness store already held. */
export type SessionOrigin = "fresh" | "resumed";

/**
 * One stdin command of `hcn session --json`. A line that does not parse
 * into this shape is answered with a bare `error` event and never reaches
 * the harness. Ids are the consumer's own correlation tokens and may repeat.
 */
export type SessionCommand =
  | {
      /** `send` starts a turn, or joins the harness's own busy-send queue;
       * `answer` replies to the open question of a turn that ended
       * `awaiting-input`. */
      readonly op: "send" | "answer";
      readonly id: string;
      readonly text: string;
      /** An explicit native delivery mode; omitted means the harness's own
       * busy-send behavior. A mode the harness does not support is a
       * malformed command, never a silent fallback. */
      readonly delivery?: SessionDelivery;
      /** `send` only: write the text exactly as given, with no question
       * preamble in any questions mode. `answer` carries no verbatim at
       * all - compose the reply yourself. */
      readonly verbatim?: boolean;
    }
  | { readonly op: "interrupt"; readonly id: string }
  | { readonly op: "stop-background"; readonly id: string; readonly job: string }
  | (SessionApprovalDecisionRequest & { readonly op: "approval" })
  | (SessionSettingsRequest & { readonly op: "settings" })
  | { readonly op: "close" };

/** The first line of every session stream: what was opened, and how. */
export interface SessionHeaderEvent {
  readonly kind: "session";
  readonly sessionId: string;
  readonly harness: string;
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

/** Exactly one receipt per `approval` command: the write's outcome. The
 * request it answers rode the turn stream as an `approval-request` event. */
export type SessionApprovalDispositionEvent = {
  readonly kind: "approval-disposition";
  readonly v: 1;
  readonly id: string;
  readonly requestId: string;
} & SessionApprovalAnswer;

/** Exactly one receipt per `settings` command, emitted as it settles. */
export type SessionSettingsEvent = {
  readonly kind: "settings";
  readonly id: string;
} & SessionSettingsReceipt;

/** A bare observation the session owes the consumer outside any turn: a
 * malformed command, a failed command stream, or a settings readback the
 * receipt could not confirm. Informational - the stream stays open. */
export interface SessionErrorEvent {
  readonly kind: "error";
  readonly message: string;
}

/** `closed.cause` never carries `awaiting-input`: that cause ends a turn,
 * never a session. */
export type SessionCloseCause = Exclude<ExitCause, "awaiting-input">;

/** The last line of every session stream, with and without `failure`: the
 * failure rides whenever the cause is not clean and a failure was seen. */
export interface SessionClosedEvent {
  readonly kind: "closed";
  readonly exitCode: number | null;
  readonly cause: SessionCloseCause;
  readonly failure?: FailureSummary;
}

/**
 * The terminal `done` a dying stream writes with no `escalation` record:
 * the refusal, crash and transport-failure paths end a `--json` stream with
 * this done because no turn ran to record an escalation mode. The crash
 * tier writes the same pair on a session stream too, so it terminates both
 * unions.
 */
export interface TerminalDoneEvent {
  readonly kind: "done";
  readonly exitCode: number | null;
  readonly cause: ExitCause;
  readonly failure: FailureSummary;
}

/** Every line `hcn run --json` writes on stdout: the runner's own events,
 * then the terminal `done` a refusal, crash or transport failure writes. */
export type RunEvent = HarnessEvent | TerminalDoneEvent;

/** Every line `hcn session --json` writes on stdout. */
export type SessionEvent =
  | SessionHeaderEvent
  | SessionTurnEvent
  | HarnessEvent
  | SessionDispositionEvent
  | SessionInterruptionEvent
  | SessionBackgroundStopEvent
  | SessionApprovalDispositionEvent
  | SessionSettingsEvent
  | SessionErrorEvent
  | SessionClosedEvent
  | TerminalDoneEvent;
