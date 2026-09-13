import { codexCli } from "../knowledge/codex.js";
import type {
  NativeApprovalsReviewer,
  NativePermissionSettings,
} from "../knowledge/native-settings.js";
import { isNativeFolder } from "./native-path.js";
import { asRecord } from "./shape.js";
import { CLEAN_SELECTOR, validateEffort } from "./vocabulary.js";

type CodexSettingsRecord =
  | {
      readonly cwd: string;
      readonly kind: "metadata";
      readonly provider: string;
      readonly sessionId: string;
    }
  | {
      readonly approvalsReviewer: NativeApprovalsReviewer | undefined;
      readonly cwd: string;
      readonly effort: string;
      readonly kind: "settings";
      readonly model: string;
      readonly permissions: NativePermissionSettings;
      readonly provider?: string;
      readonly sessionId?: string;
    }
  | { readonly kind: "other" };

const selector = (value: unknown): value is string =>
  typeof value === "string" && CLEAN_SELECTOR.test(value);

/** Reject unknown policy fields instead of collapsing them into a broader preset. */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = asRecord(value);
  return record &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
    ? record
    : null;
}

function recordedPermissions(
  payload: Record<string, unknown>,
  settingsEvent = false,
): NativePermissionSettings {
  if (
    payload.approval_policy === undefined ||
    (!settingsEvent && payload.sandbox_policy === undefined) ||
    payload.permission_profile === undefined
  )
    return { reason: "permissions-unrecorded", status: "unavailable" };
  if (payload.approval_policy !== "on-request" && payload.approval_policy !== "never")
    return { reason: "approval-policy-unsupported", status: "unavailable" };
  if (
    payload.active_permission_profile != null ||
    payload.network != null ||
    payload.file_system_sandbox_policy != null
  )
    return { reason: "permission-profile-unsupported", status: "unavailable" };
  const sandbox = exactRecord(payload.sandbox_policy, ["type"]);
  const profile = exactRecord(payload.permission_profile, ["type", "file_system", "network"]);
  const filesystem = exactRecord(profile?.file_system, ["type", "entries"]);
  const entries = filesystem?.entries;
  const entry =
    Array.isArray(entries) && entries.length === 1
      ? exactRecord(entries[0], ["path", "access"])
      : null;
  const path = exactRecord(entry?.path, ["type", "value"]);
  const value = exactRecord(path?.value, ["kind"]);
  if (
    (!settingsEvent && sandbox?.type !== "read-only") ||
    (settingsEvent && payload.sandbox_policy !== undefined) ||
    profile?.type !== "managed" ||
    profile.network !== "restricted" ||
    filesystem?.type !== "restricted" ||
    entry?.access !== "read" ||
    path?.type !== "special" ||
    value?.kind !== "root"
  )
    return { reason: "permission-profile-unsupported", status: "unavailable" };
  return {
    approvalPolicy: payload.approval_policy,
    filesystem: "read-only",
    network: "restricted",
    status: "recorded",
  };
}

function recordedReviewer(
  value: unknown,
  settingsEvent: boolean,
): NativeApprovalsReviewer | undefined {
  if (value === "user") return "user";
  if (value === "auto_review" || value === "guardian_subagent") return "automatic";
  // Native turn contexts can omit the reviewer and retain an older explicit value.
  // Settings-update snapshots require it; missing there cannot inherit authority.
  return value != null || settingsEvent ? "unknown" : undefined;
}

/** Select native metadata only; conversation text never becomes settings. */
export function parseCodexSettingsRecord(value: unknown): CodexSettingsRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;
  const event = record.type === "event_msg" ? asRecord(record.payload) : null;
  const settingsEvent = event?.type === "thread_settings_applied";
  if (record.type !== "session_meta" && record.type !== "turn_context" && !settingsEvent)
    return { kind: "other" };
  const payload = asRecord(settingsEvent ? event?.thread_settings : record.payload);
  if (!payload || !isNativeFolder(payload.cwd)) return null;
  if (record.type === "session_meta")
    return typeof payload.id === "string" && selector(payload.model_provider)
      ? {
          cwd: payload.cwd,
          kind: "metadata",
          provider: payload.model_provider,
          sessionId: payload.id,
        }
      : null;
  const effort = settingsEvent ? payload.reasoning_effort : payload.effort;
  if (
    settingsEvent &&
    (!selector(payload.model_provider_id) ||
      (event?.thread_id != null && typeof event.thread_id !== "string"))
  )
    return null;
  return selector(payload.model) &&
    typeof effort === "string" &&
    validateEffort(codexCli, effort).ok
    ? {
        approvalsReviewer: recordedReviewer(payload.approvals_reviewer, settingsEvent),
        cwd: payload.cwd,
        effort,
        kind: "settings",
        model: payload.model,
        permissions: recordedPermissions(payload, settingsEvent),
        ...(settingsEvent && typeof payload.model_provider_id === "string"
          ? { provider: payload.model_provider_id }
          : {}),
        ...(settingsEvent && typeof event?.thread_id === "string"
          ? { sessionId: event.thread_id }
          : {}),
      }
    : null;
}
