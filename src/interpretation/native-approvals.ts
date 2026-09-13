import { UUID_SHAPE } from "../knowledge/descriptor.js";
import type { ApprovalCategory, ApprovalChoice } from "../knowledge/native-approvals.js";
import {
  NATIVE_APPROVAL_LIMITS,
  NATIVE_APPROVAL_METHODS,
  NATIVE_APPROVAL_REQUEST_IDS,
} from "../knowledge/native-approvals.js";
import type { NativeSettingsSnapshot } from "../knowledge/native-settings.js";
import { execpolicyAmendment, nativeApprovalChoice } from "./native-approval-choices.js";
import type { NativeApprovalContent } from "./native-approval-content.js";
import { nativeApprovalContent, nativeApprovalError } from "./native-approval-content.js";
import type {
  FileApprovalIdentity,
  FileApprovalItem,
  FileApprovalRequest,
} from "./native-approval-files.js";
import { parseFileApprovalItem, parseFileApprovalRequest } from "./native-approval-files.js";
import { permissionApprovalProposal } from "./native-approval-permissions.js";
import { asRecord } from "./shape.js";

export interface ApprovalProposal {
  readonly category: ApprovalCategory;
  readonly choices: readonly (ApprovalChoice & { readonly payload: unknown })[];
  readonly details: string;
  readonly nativeId: string | number;
  readonly sessionId: string;
  readonly turnId: string;
}

export type ApprovalProtocolMessage =
  | {
      readonly kind: "content";
      readonly sessionId: string;
      readonly turnId: string;
      readonly event: NativeApprovalContent;
    }
  | { readonly kind: "file-item"; readonly item: FileApprovalItem }
  | { readonly kind: "file-request"; readonly request: FileApprovalRequest }
  | { readonly kind: "file-item-ended"; readonly item: FileApprovalIdentity }
  | {
      readonly kind: "reply";
      readonly operation: keyof typeof NATIVE_APPROVAL_REQUEST_IDS;
      readonly value: unknown;
      readonly failed: boolean;
    }
  | { readonly kind: "request"; readonly proposal: ApprovalProposal }
  | { readonly kind: "cleared"; readonly nativeId: string | number; readonly sessionId: string }
  | {
      readonly kind: "message";
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly kind: "complete";
      readonly error: string | null;
      readonly sessionId: string;
      readonly turnId: string;
      readonly interrupted: boolean;
      readonly failed: boolean;
    }
  | { readonly kind: "ignored"; readonly method: string }
  | { readonly kind: "unsupported" };

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const id = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));

export function approvalInitialize(): string {
  return line({
    id: NATIVE_APPROVAL_REQUEST_IDS.initialize,
    method: "initialize",
    params: { clientInfo: { name: "hcn", version: "1" }, capabilities: { experimentalApi: true } },
  });
}
export function approvalInitialized(): string {
  return line({ method: "initialized" });
}
export function approvalResume(saved: NativeSettingsSnapshot): string {
  return line({
    id: NATIVE_APPROVAL_REQUEST_IDS.resume,
    method: "thread/resume",
    params: {
      approvalPolicy:
        saved.permissions?.status === "recorded" ? saved.permissions.approvalPolicy : null,
      approvalsReviewer: "user",
      config: { model_reasoning_effort: saved.effort },
      cwd: saved.cwd,
      excludeTurns: true,
      model: saved.model,
      modelProvider: saved.provider,
      sandbox: "read-only",
      threadId: saved.sessionId,
    },
  });
}
export function approvalStart(sessionId: string, prompt: string): string {
  return line({
    id: NATIVE_APPROVAL_REQUEST_IDS.start,
    method: "turn/start",
    params: { threadId: sessionId, input: [{ type: "text", text: prompt }] },
  });
}
export function approvalResponse(nativeId: string | number, payload: unknown): string {
  return line({ id: nativeId, result: payload });
}

export function matchesApprovalResume(value: unknown, saved: NativeSettingsSnapshot): boolean {
  const record = asRecord(value);
  const thread = asRecord(record?.thread);
  const sandbox = asRecord(record?.sandbox);
  return (
    record?.model === saved.model &&
    record.modelProvider === saved.provider &&
    record.reasoningEffort === saved.effort &&
    record.cwd === saved.cwd &&
    thread?.id === saved.sessionId &&
    record.approvalsReviewer === "user" &&
    saved.permissions?.status === "recorded" &&
    record.approvalPolicy === saved.permissions.approvalPolicy &&
    record.activePermissionProfile === null &&
    sandbox?.type === "readOnly" &&
    sandbox.networkAccess === false &&
    Object.keys(sandbox).length === 2
  );
}
export function approvalTurnId(value: unknown): string | null {
  const turn = asRecord(asRecord(value)?.turn);
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : null;
}

function commandProposal(message: Record<string, unknown>): ApprovalProposal | null {
  const params = asRecord(message.params);
  if (
    !params ||
    !id(message.id) ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.command !== "string" ||
    typeof params.cwd !== "string" ||
    (params.reason != null && typeof params.reason !== "string") ||
    !Array.isArray(params.availableDecisions)
  )
    return null;
  const allowed = [
    "threadId",
    "turnId",
    "itemId",
    "command",
    "cwd",
    "reason",
    "availableDecisions",
    "startedAtMs",
    "kind",
    "environmentId",
    "approvalId",
    "additionalPermissions",
    "commandActions",
    "networkApprovalContext",
    "proposedExecpolicyAmendment",
    "proposedNetworkPolicyAmendments",
  ];
  if (Object.keys(params).some((key) => !allowed.includes(key))) return null;
  if (
    (params.kind !== undefined && params.kind !== "command") ||
    (params.environmentId != null && params.environmentId !== "local") ||
    params.additionalPermissions != null ||
    params.networkApprovalContext != null ||
    params.proposedNetworkPolicyAmendments != null ||
    (params.approvalId != null && typeof params.approvalId !== "string") ||
    (params.commandActions != null && !Array.isArray(params.commandActions))
  )
    return null;
  // commandActions are best-effort display hints; the complete command is
  // authoritative and always shown. A callback's approvalId does not replace
  // its native RPC identity.
  const choices: (ApprovalChoice & { readonly payload: unknown })[] = [];
  for (const decision of params.availableDecisions) {
    const choice = nativeApprovalChoice(decision);
    if (!choice) return null;
    choices.push(choice);
  }
  if (
    !choices.length ||
    choices.length > NATIVE_APPROVAL_LIMITS.choices ||
    new Set(choices.map((c) => c.id)).size !== choices.length
  )
    return null;
  const rules = params.availableDecisions.map(execpolicyAmendment).filter((rule) => rule !== null);
  if (
    params.proposedExecpolicyAmendment != null &&
    !rules.some(
      (rule) => JSON.stringify(rule) === JSON.stringify(params.proposedExecpolicyAmendment),
    )
  )
    return null;
  let details = `Command: ${params.command}\nWorking folder: ${params.cwd}${params.reason ? `\nReason: ${params.reason}` : ""}`;
  if (params.environmentId === "local") details += "\nEnvironment: local";
  for (const rule of rules)
    details += `\nSaved allow rule: command argument prefix ${JSON.stringify(rule)}. Future matching commands may run without prompting.`;
  if (choices.some((choice) => choice.scope === "session"))
    details +=
      "\nSession approval also covers future requests matched by the native session approval cache.";
  if (new TextEncoder().encode(details).length > NATIVE_APPROVAL_LIMITS.detailsBytes) return null;
  return {
    category: "command",
    choices,
    details,
    nativeId: message.id,
    sessionId: params.threadId,
    turnId: params.turnId,
  };
}

export function decodeApprovalProtocol(value: unknown): ApprovalProtocolMessage {
  const record = asRecord(value);
  if (!record) return { kind: "unsupported" };
  if (typeof record.method === "string") {
    if (
      Object.values(NATIVE_APPROVAL_METHODS).some((method) => method === record.method) &&
      !Object.hasOwn(record, "id")
    )
      return { kind: "unsupported" };
    if (Object.hasOwn(record, "id")) {
      if (record.method === NATIVE_APPROVAL_METHODS.fileChange) {
        const request = parseFileApprovalRequest(record);
        return request ? { kind: "file-request", request } : { kind: "unsupported" };
      }
      const proposal =
        record.method === NATIVE_APPROVAL_METHODS.command
          ? commandProposal(record)
          : record.method === NATIVE_APPROVAL_METHODS.permissions
            ? permissionApprovalProposal(record)
            : null;
      return proposal ? { kind: "request", proposal } : { kind: "unsupported" };
    }
    const params = asRecord(record.params);
    if (record.method === "serverRequest/resolved")
      return id(params?.requestId) && typeof params?.threadId === "string"
        ? { kind: "cleared", nativeId: params.requestId, sessionId: params.threadId }
        : { kind: "unsupported" };
    if (record.method === "item/started" && asRecord(params?.item)?.type === "fileChange") {
      const item = parseFileApprovalItem(params);
      return item ? { kind: "file-item", item } : { kind: "unsupported" };
    }
    if (record.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "fileChange")
        return typeof item.id === "string" &&
          typeof params?.threadId === "string" &&
          typeof params.turnId === "string"
          ? {
              kind: "file-item-ended",
              item: { itemId: item.id, sessionId: params.threadId, turnId: params.turnId },
            }
          : { kind: "unsupported" };
      if (
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        typeof params?.threadId === "string" &&
        typeof params.turnId === "string"
      )
        return {
          kind: "message",
          sessionId: params.threadId,
          turnId: params.turnId,
          text: item.text,
        };
    }
    if (record.method === "turn/completed") {
      const turn = asRecord(params?.turn);
      if (typeof turn?.id !== "string" || typeof params?.threadId !== "string")
        return { kind: "unsupported" };
      return {
        kind: "complete",
        error: nativeApprovalError(turn.error),
        sessionId: params.threadId,
        turnId: turn.id,
        interrupted: turn.status === "interrupted",
        failed:
          (turn.status !== "completed" && turn.status !== "interrupted") || turn.error != null,
      };
    }
    const content = nativeApprovalContent(record.method, params);
    if (record.method === "error" && !content) return { kind: "unsupported" };
    if (content)
      return typeof params?.threadId === "string" && typeof params.turnId === "string"
        ? { kind: "content", sessionId: params.threadId, turnId: params.turnId, event: content }
        : { kind: "unsupported" };
    return { kind: "ignored", method: record.method };
  }
  const operation =
    record.id === NATIVE_APPROVAL_REQUEST_IDS.initialize
      ? "initialize"
      : record.id === NATIVE_APPROVAL_REQUEST_IDS.resume
        ? "resume"
        : record.id === NATIVE_APPROVAL_REQUEST_IDS.start
          ? "start"
          : null;
  return operation
    ? { kind: "reply", operation, value: record.result, failed: Object.hasOwn(record, "error") }
    : { kind: "unsupported" };
}

export function validNativeApprovalOptions(options: object): boolean {
  const allowed = [
    "prompt",
    "resume",
    "cwd",
    "env",
    "nativeSettingsFingerprint",
    "nativeApprovals",
    "questions",
    "signal",
  ];
  return Object.entries(options).every(
    ([key, value]) => value === undefined || allowed.includes(key),
  );
}

export function hasUserApprovalAuthority(
  saved: NativeSettingsSnapshot | undefined,
): saved is NativeSettingsSnapshot {
  return (
    saved?.permissions?.status === "recorded" && saved.permissions.approvalsReviewer === "user"
  );
}

export interface ApprovalDecision {
  readonly choiceId: string;
  readonly id: string;
  readonly requestId: string;
}

export type ParsedApprovalDecision =
  | { readonly kind: "valid"; readonly decision: ApprovalDecision }
  | { readonly kind: "invalid"; readonly id: string | null; readonly requestId: string | null };

export function parseApprovalDecision(raw: string): ParsedApprovalDecision {
  let value: Record<string, unknown> | null = null;
  try {
    value = asRecord(JSON.parse(raw));
  } catch {}
  const id = typeof value?.id === "string" && UUID_SHAPE.test(value.id) ? value.id : null;
  const requestId =
    typeof value?.requestId === "string" && UUID_SHAPE.test(value.requestId)
      ? value.requestId
      : null;
  if (
    value?.v !== 1 ||
    value.op !== "approval" ||
    Object.keys(value).length !== 5 ||
    !id ||
    !requestId ||
    typeof value.choiceId !== "string" ||
    value.choiceId.length === 0
  )
    return { kind: "invalid", id, requestId };
  return { kind: "valid", decision: { id, requestId, choiceId: value.choiceId } };
}
