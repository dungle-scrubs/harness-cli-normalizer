import { type ContentEvent, contentEventsOf } from "./content.js";
import { asRecord } from "./shape.js";

export type NativeApprovalContent = Extract<
  ContentEvent,
  { kind: "token" | "tool" | "tool-result" | "usage" | "progress" | "error" }
>;

export function nativeApprovalError(value: unknown): string | null {
  const error = asRecord(value);
  if (
    typeof error?.message !== "string" ||
    (error.additionalDetails != null && typeof error.additionalDetails !== "string")
  )
    return null;
  return error.message + (error.additionalDetails ? `\n${error.additionalDetails}` : "");
}

export function nativeApprovalContent(
  method: string,
  params: Record<string, unknown> | null,
): readonly NativeApprovalContent[] {
  if (method === "error") {
    const message = nativeApprovalError(params?.error);
    if (message === null || typeof params?.willRetry !== "boolean") return [];
    return [{ kind: "error", message, terminal: !params.willRetry }];
  }
  if (method === "item/agentMessage/delta" && typeof params?.delta === "string")
    return [{ kind: "token", text: params.delta }];
  return contentEventsOf("codex", { method, params }).filter(
    (event): event is NativeApprovalContent =>
      event.kind === "token" ||
      event.kind === "tool" ||
      event.kind === "tool-result" ||
      event.kind === "usage" ||
      event.kind === "progress" ||
      event.kind === "error",
  );
}
