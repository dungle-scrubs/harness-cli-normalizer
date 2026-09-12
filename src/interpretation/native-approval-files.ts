import { NATIVE_APPROVAL_LIMITS } from "../knowledge/native-approvals.js";
import { nativeApprovalChoice } from "./native-approval-choices.js";
import type { ApprovalProposal } from "./native-approvals.js";
import { isNativeFolder } from "./native-path.js";
import { asRecord } from "./shape.js";

export interface FileApprovalIdentity {
  readonly itemId: string;
  readonly sessionId: string;
  readonly turnId: string;
}
export interface FileApprovalItem extends FileApprovalIdentity {
  readonly details: string;
}
export interface FileApprovalRequest extends FileApprovalIdentity {
  readonly nativeId: string | number;
  readonly reason: string | null;
}

export function fileApprovalKey(value: FileApprovalIdentity): string {
  return JSON.stringify([value.sessionId, value.turnId, value.itemId]);
}

export function parseFileApprovalItem(value: unknown): FileApprovalItem | null {
  const params = asRecord(value);
  const item = asRecord(params?.item);
  if (
    typeof params?.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof item?.id !== "string" ||
    item.type !== "fileChange" ||
    item.status !== "inProgress" ||
    !Array.isArray(item.changes) ||
    item.changes.length === 0 ||
    Object.keys(item).some((key) => !["id", "type", "status", "changes"].includes(key))
  )
    return null;
  const sections: string[] = [];
  for (const entry of item.changes) {
    const change = asRecord(entry);
    const kind = asRecord(change?.kind);
    if (
      !change ||
      !kind ||
      !isNativeFolder(change.path) ||
      typeof change.diff !== "string" ||
      Object.keys(change).some((key) => !["path", "kind", "diff"].includes(key))
    )
      return null;
    let label: string;
    if ((kind.type === "add" || kind.type === "delete") && Object.keys(kind).length === 1)
      label = kind.type === "add" ? "Add" : "Delete";
    else if (
      kind.type === "update" &&
      Object.keys(kind).every((key) => ["type", "move_path"].includes(key)) &&
      (kind.move_path == null || isNativeFolder(kind.move_path))
    )
      label =
        kind.move_path == null ? "Update" : `Move to ${JSON.stringify(kind.move_path)} and update`;
    else return null;
    sections.push(`${label} ${JSON.stringify(change.path)}:\n${change.diff}`);
  }
  const details = `File changes:\n${sections.join("\n")}`;
  if (new TextEncoder().encode(details).length > NATIVE_APPROVAL_LIMITS.detailsBytes) return null;
  return { details, itemId: item.id, sessionId: params.threadId, turnId: params.turnId };
}

export function parseFileApprovalRequest(
  message: Record<string, unknown>,
): FileApprovalRequest | null {
  const params = asRecord(message.params);
  if (
    (typeof message.id !== "string" &&
      !(typeof message.id === "number" && Number.isSafeInteger(message.id))) ||
    typeof params?.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    (params.reason != null && typeof params.reason !== "string") ||
    params.grantRoot != null ||
    Object.keys(params).some(
      (key) =>
        !["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"].includes(key),
    )
  )
    return null;
  // grantRoot remains unsupported: the native schema does not establish its
  // effective duration. The exact file list comes from item/started instead.
  return {
    nativeId: message.id,
    itemId: params.itemId,
    sessionId: params.threadId,
    turnId: params.turnId,
    reason: params.reason ?? null,
  };
}

export function assembleFileApproval(
  request: FileApprovalRequest,
  item: FileApprovalItem | undefined,
  cwd: string,
): ApprovalProposal | null {
  if (!item || fileApprovalKey(item) !== fileApprovalKey(request)) return null;
  const choices: ApprovalProposal["choices"][number][] = [];
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
    const choice = nativeApprovalChoice(decision);
    if (!choice) return null;
    choices.push(choice);
  }
  const details = `${item.details}\nWorking folder: ${cwd}${request.reason ? `\nReason: ${request.reason}` : ""}\nSession approval also covers future changes to these same files.`;
  if (new TextEncoder().encode(details).length > NATIVE_APPROVAL_LIMITS.detailsBytes) return null;
  return {
    category: "file-change",
    choices,
    details,
    nativeId: request.nativeId,
    sessionId: request.sessionId,
    turnId: request.turnId,
  };
}
