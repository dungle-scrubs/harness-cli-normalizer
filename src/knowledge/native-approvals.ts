import { deepFreeze } from "./descriptor.js";

export const NATIVE_APPROVAL_LIMITS = deepFreeze({
  choices: 16,
  decisionBytes: 4096,
  detailsBytes: 65536,
  exitGraceMs: 2000,
  identities: 4096,
  nativeFrameBytes: 1024 * 1024,
  pending: 32,
  protocolDeadlineMs: 30000,
} as const);

export const NATIVE_APPROVAL_PROTOCOLS = deepFreeze({
  claude: null,
  codex: { argv: ["app-server", "--listen", "stdio://"], kind: "codex-app-server-v1" },
  muse: null,
  pi: null,
} as const);

export const NATIVE_APPROVAL_REQUEST_IDS = deepFreeze({
  initialize: "hcn-initialize",
  resume: "hcn-resume",
  start: "hcn-turn",
} as const);

export type ApprovalCategory = "command" | "file-change" | "permissions";

export interface ApprovalChoice {
  readonly id: string;
  readonly label: string;
  readonly scope: "once" | "turn" | "session" | "persistent" | "deny" | "cancel";
}

export type NativeApprovalEvent =
  | {
      readonly category: ApprovalCategory;
      readonly choices: readonly ApprovalChoice[];
      readonly details: string;
      readonly kind: "approval-request";
      readonly requestId: string;
      /** The exact resumable thread ID, not Codex's root-group sessionId. */
      readonly sessionId: string;
      readonly turnId: string;
      readonly v: 1;
    }
  | {
      readonly id: string | null;
      readonly kind: "approval-disposition";
      readonly reason?: string;
      readonly requestId: string | null;
      readonly status: "sent" | "rejected";
      readonly v: 1;
    }
  | {
      readonly kind: "approval-cleared";
      readonly reason: "native-resolved" | "turn-ended" | "process-ended" | "channel-failed";
      readonly requestId: string;
      readonly v: 1;
    };

export type NativeApprovalPhase = "preflight" | "initialize" | "resume" | "turn-start" | "running";
export type NativeApprovalFailureReason =
  | "approval-channel-lost"
  | "inactivity"
  | "native-process-ended"
  | "native-process-failed"
  | "native-protocol-failed"
  | "native-protocol-timeout"
  | "native-settings-changed"
  | "native-settings-mismatch"
  | "native-settings-unavailable"
  | "request-refused"
  | "spawn-failed"
  | "timeout"
  | "unsupported-native-interaction";

export type NativeApprovalSubmission = "not-submitted" | "submission-unknown" | "acknowledged";

/** Evidence for one owned attempt. Unknown submission never authorizes replay. */
export interface NativeApprovalFailure {
  readonly phase: NativeApprovalPhase;
  readonly process: "not-attempted" | "not-started" | "started" | "unknown";
  readonly prompt: NativeApprovalSubmission;
  readonly reason: NativeApprovalFailureReason;
}

export const NATIVE_APPROVAL_METHODS = deepFreeze({
  command: "item/commandExecution/requestApproval",
  fileChange: "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval",
  userInput: "item/tool/requestUserInput",
  mcpElicitation: "mcpServer/elicitation/request",
} as const);
