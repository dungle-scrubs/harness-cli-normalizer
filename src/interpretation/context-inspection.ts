import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { SpawnArgvOptions } from "./argv.js";
import { buildSpawnArgv } from "./argv.js";
import { ArgvRefusalError } from "./refusal.js";
import { asRecord } from "./shape.js";

/** Preserve the real turn's launch settings, replacing only its prompt
 * transport. The pending task is staged later over the control channel. */
export function buildContextInspectionArgv(
  harness: HarnessDescriptor,
  options: SpawnArgvOptions,
): string[] {
  assertContextInspectionOptions(harness, options);
  if (harness.contextInspection?.kind !== "claude-control-v1") {
    throw new ArgvRefusalError({
      harness: harness.name,
      issue: "invalid-option-value",
      option: "context",
      supported: ["verified native context adapter without native passthrough"],
    });
  }
  return [
    ...buildSpawnArgv(harness, { ...options, prompt: { text: "", explicit: true } }),
    ...harness.contextInspection.flags,
    ...(options.resume === undefined ? [] : [harness.contextInspection.forkFlag]),
  ];
}

export function assertContextInspectionOptions(
  harness: HarnessDescriptor,
  options: SpawnArgvOptions,
): void {
  if (!options.passthrough?.length) return;
  throw new ArgvRefusalError({
    harness: harness.name,
    issue: "invalid-option-value",
    option: "context",
    supported: ["context inspection without native passthrough"],
  });
}

/** A native estimate of the complete staged request, including recalled
 * history. No inferred token ratio or model table is used here. The caller
 * owns its additional reserve and dispatch policy. */
export type ContextInspection =
  | {
      readonly contextWindowTokens: number;
      readonly inputLimitTokens: number;
      readonly method: "native-context-estimate";
      readonly model: string;
      readonly status: "available";
      readonly totalTokens: number;
    }
  | {
      readonly reason:
        | "cancelled"
        | "transport-limit"
        | "transport"
        | "protocol"
        | "timeout"
        | "cleanup";
      readonly status: "unavailable";
    }
  | {
      readonly reason:
        | "unverified-adapter"
        | "unsupported-adapter"
        | "auth"
        | "limit"
        | "native-exit";
      readonly status: "unavailable";
    };

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Normalize only a complete native response. A window alone says nothing
 * about remaining capacity, and invalid compaction data must not increase it. */
export function contextInspectionOf(input: unknown): ContextInspection {
  const value = asRecord(input);
  if (
    value === null ||
    Array.isArray(input) ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !positive(value.maxTokens) ||
    typeof value.totalTokens !== "number" ||
    !Number.isSafeInteger(value.totalTokens) ||
    value.totalTokens < 0 ||
    typeof value.isAutoCompactEnabled !== "boolean" ||
    (value.isAutoCompactEnabled && !positive(value.autoCompactThreshold))
  ) {
    return { status: "unavailable", reason: "protocol" };
  }
  return {
    contextWindowTokens: value.maxTokens,
    inputLimitTokens:
      value.isAutoCompactEnabled && positive(value.autoCompactThreshold)
        ? Math.min(value.maxTokens, value.autoCompactThreshold)
        : value.maxTokens,
    method: "native-context-estimate",
    model: value.model,
    status: "available",
    totalTokens: value.totalTokens,
  };
}

export interface ContextProbe {
  readonly initial: string;
  readonly staged: string;
  accept(
    line: string,
  ):
    | { readonly kind: "send"; readonly line: string }
    | { readonly kind: "complete"; readonly accounting: ContextInspection }
    | null;
}

/** Pure protocol state: only an acknowledgement of this staged UUID allows
 * the usage query. The execution owner handles transport and cancellation. */
export function createContextProbe(inputId: string, prompt: string): ContextProbe {
  let phase: "initialize" | "ack" | "usage" | "finished" = "initialize";
  const initializeId = `${inputId}:initialize`;
  const usageId = `${inputId}:usage`;
  const control = (id: string, request: unknown): string =>
    JSON.stringify({ type: "control_request", request_id: id, request });
  const staged = JSON.stringify({
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    shouldQuery: false,
    type: "user",
    uuid: inputId,
  });
  return {
    initial: control(initializeId, { subtype: "initialize", hooks: null }),
    staged,
    accept(line) {
      if (phase === "finished") return null;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        phase = "finished";
        return { kind: "complete", accounting: { status: "unavailable", reason: "protocol" } };
      }
      const frame = asRecord(decoded);
      if (frame === null || Array.isArray(decoded)) return null;
      if (phase === "ack" && frame.type === "user" && frame.uuid === inputId) {
        phase = "usage";
        return { kind: "send", line: control(usageId, { subtype: "get_context_usage" }) };
      }
      const response = asRecord(frame.response);
      if (frame.type !== "control_response" || response === null || Array.isArray(frame.response))
        return null;
      const expected = phase === "initialize" ? initializeId : phase === "usage" ? usageId : null;
      if (expected === null || response.request_id !== expected) return null;
      if (response.subtype !== "success") {
        phase = "finished";
        return { kind: "complete", accounting: { status: "unavailable", reason: "protocol" } };
      }
      if (phase === "initialize") {
        phase = "ack";
        return { kind: "send", line: staged };
      }
      phase = "finished";
      return { kind: "complete", accounting: contextInspectionOf(response.response) };
    },
  };
}
