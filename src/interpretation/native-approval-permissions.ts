import { NATIVE_APPROVAL_LIMITS } from "../knowledge/native-approvals.js";
import type { ApprovalProposal } from "./native-approvals.js";
import { isNativeFolder } from "./native-path.js";
import { asRecord } from "./shape.js";

/** Only explicit absolute paths and an explicit network toggle are currently
 * projected. Native symbolic roots, globs and implicit scopes stay unsupported. */
export function projectNativePermissions(value: unknown): {
  readonly details: string;
  readonly payload: Record<string, unknown>;
} | null {
  const permissions = asRecord(value);
  if (
    !permissions ||
    Object.keys(permissions).some((key) => !["fileSystem", "network"].includes(key))
  )
    return null;
  const details: string[] = [];
  if (permissions.network != null) {
    const network = asRecord(permissions.network);
    if (!network || Object.keys(network).length !== 1 || typeof network.enabled !== "boolean")
      return null;
    details.push(`Network access: ${network.enabled ? "enabled" : "disabled"}`);
  }
  if (permissions.fileSystem != null) {
    const filesystem = asRecord(permissions.fileSystem);
    if (
      !filesystem ||
      Object.keys(filesystem).some(
        (key) => !["entries", "read", "write", "globScanMaxDepth"].includes(key),
      ) ||
      filesystem.read != null ||
      filesystem.write != null ||
      filesystem.globScanMaxDepth != null ||
      !Array.isArray(filesystem.entries) ||
      filesystem.entries.length === 0
    )
      return null;
    for (const value of filesystem.entries) {
      const entry = asRecord(value);
      const path = asRecord(entry?.path);
      if (
        !entry ||
        Object.keys(entry).length !== 2 ||
        !path ||
        Object.keys(path).length !== 2 ||
        path.type !== "path" ||
        !isNativeFolder(path.path)
      )
        return null;
      const access =
        entry.access === "read"
          ? "Read"
          : entry.access === "write"
            ? "Write"
            : entry.access === "deny"
              ? "Deny"
              : null;
      if (!access) return null;
      details.push(`${access} access: ${JSON.stringify(path.path)}`);
    }
  }
  const text = details.join("\n");
  if (!text || new TextEncoder().encode(text).length > NATIVE_APPROVAL_LIMITS.detailsBytes)
    return null;
  return { details: text, payload: permissions };
}

export function permissionApprovalProposal(
  message: Record<string, unknown>,
): ApprovalProposal | null {
  const params = asRecord(message.params);
  if (
    (typeof message.id !== "string" &&
      !(typeof message.id === "number" && Number.isSafeInteger(message.id))) ||
    typeof params?.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    !isNativeFolder(params.cwd) ||
    (params.environmentId != null && params.environmentId !== "local") ||
    (params.reason != null && typeof params.reason !== "string") ||
    Object.keys(params).some(
      (key) =>
        ![
          "threadId",
          "turnId",
          "itemId",
          "startedAtMs",
          "cwd",
          "environmentId",
          "permissions",
          "reason",
        ].includes(key),
    )
  )
    return null;
  const projection = projectNativePermissions(params.permissions);
  if (!projection) return null;
  const details = `Requested permissions:\n${projection.details}\nWorking folder: ${params.cwd}${params.environmentId ? `\nEnvironment: ${params.environmentId}` : ""}${params.reason ? `\nReason: ${params.reason}` : ""}\nA session grant also applies to later responses in this same native session.`;
  if (new TextEncoder().encode(details).length > NATIVE_APPROVAL_LIMITS.detailsBytes) return null;
  return {
    category: "permissions",
    choices: [
      {
        id: "turn",
        label: "Grant for this response",
        scope: "turn",
        payload: { permissions: projection.payload, scope: "turn" },
      },
      {
        id: "session",
        label: "Grant for this native session",
        scope: "session",
        payload: { permissions: projection.payload, scope: "session" },
      },
      { id: "deny", label: "Deny", scope: "deny", payload: { permissions: {}, scope: "turn" } },
    ],
    details,
    nativeId: message.id,
    sessionId: params.threadId,
    turnId: params.turnId,
  };
}
