import type { ContentEvent } from "./content.js";
import { asRecord } from "./shape.js";

export type NativeApprovalContent = Extract<
  ContentEvent,
  { kind: "token" | "tool" | "progress" | "error" }
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
): NativeApprovalContent | null {
  if (method === "error") {
    const message = nativeApprovalError(params?.error);
    if (message === null || typeof params?.willRetry !== "boolean") return null;
    return {
      kind: "error",
      message,
      terminal: !params.willRetry,
    };
  }
  if (method === "item/agentMessage/delta" && typeof params?.delta === "string")
    return { kind: "token", text: params.delta };
  const item = asRecord(params?.item);
  if (
    method === "item/started" &&
    item?.type === "commandExecution" &&
    typeof item.command === "string"
  )
    return { kind: "tool", name: "shell", input: item.command };
  return null;
}
