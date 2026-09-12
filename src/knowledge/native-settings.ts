import type { HarnessName } from "./descriptor.js";
import { deepFreeze } from "./descriptor.js";

export const NATIVE_SETTINGS_SOURCES = deepFreeze({
  claude: null,
  codex: "codex-rollout-v1",
  muse: null,
  pi: null,
} as const);

export const NATIVE_SETTINGS_FINGERPRINT_SHAPE = /^[a-f0-9]{64}$/;

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
