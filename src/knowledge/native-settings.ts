import type { HarnessName } from "./descriptor.js";
import { deepFreeze } from "./descriptor.js";

export const NATIVE_SETTINGS_SOURCES = deepFreeze({
  claude: null,
  codex: "codex-rollout-v1",
  muse: null,
  pi: null,
  // RFC-05: no settings source observed; reads report unsupported-harness.
  cursor: null,
} as const);

export const NATIVE_SETTINGS_FINGERPRINT_SHAPE = /^[a-f0-9]{64}$/;

export type NativeApprovalsReviewer = "user" | "automatic" | "unknown";

/** Recorded local-command limits, not a promise that a launch can restore them. */
export type NativePermissionSettings =
  | {
      readonly approvalPolicy: "never" | "on-request";
      /** Missing in older native records; absence is unknown, never user authority. */
      readonly approvalsReviewer?: NativeApprovalsReviewer;
      readonly filesystem: "read-only";
      readonly network: "restricted";
      readonly status: "recorded";
    }
  | {
      readonly reason:
        | "approval-policy-unsupported"
        | "permission-profile-unsupported"
        | "permissions-unrecorded";
      readonly status: "unavailable";
    };

export type NativeSettingsReason =
  | "cwd-refused"
  | "invalid-request"
  | "session-unavailable"
  | "settings-unavailable"
  | "source-changed"
  | "source-incomplete"
  | "source-too-large"
  | "unsupported-harness";

export interface NativeSettingsSnapshot {
  readonly cwd: string;
  readonly effort: string;
  readonly fingerprint: string;
  readonly harness: HarnessName;
  readonly model: string;
  /** Older v1 producers omit this field; absence means unknown. */
  readonly permissions?: NativePermissionSettings;
  readonly provider: string;
  readonly sessionId: string;
  readonly source: "codex-rollout-v1";
  readonly status: "available";
  readonly v: 1;
}

export type NativeSettingsResult =
  | NativeSettingsSnapshot
  | {
      readonly harness: HarnessName;
      readonly reason: NativeSettingsReason;
      readonly status: "unavailable";
      readonly v: 1;
    };
