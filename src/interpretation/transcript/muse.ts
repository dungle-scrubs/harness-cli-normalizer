import type { Part, RecordEnvelope } from "../../knowledge/transcript/wire.js";
import type { Json, JsonObject } from "./json.js";
import {
  equalsInteger,
  JsonNumber,
  object,
  parseNativeJson,
  string,
  TranscriptError,
} from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";
import { nativeReference, unknownRelation as unknown } from "./relations.js";

function unsignedInteger(value: Json | undefined): bigint | null {
  return value instanceof JsonNumber && /^\d+$/.test(value.text) ? BigInt(value.text) : null;
}

const RESULT_KINDS = new Set([
  "tool_result",
  "tool_result_batch_committed",
  "tool_results_committed",
  "tool_result_committed",
]);

export function normalizeMuse(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const original = entry.original;
  if (
    original.retained_frame === "session_permission_transaction" &&
    !equalsInteger(original.schema_version, 1)
  ) {
    return {
      kind: "record",
      nativeId: string(original.transaction_id),
      normalized: {
        kind: "unknown",
        parts: [],
        relationships: {
          "branch-origin": unknown(),
          "first-kept-entry": unknown(),
          "parent-conversation": unknown(),
          "parent-entry": unknown(),
          "tool-call": unknown(),
        },
        role: null,
        timestamp: null,
      },
      original,
      originalKind: "saved-record",
      position: position(entry.offset),
      schemaVersion: 1,
      sourceKey: "source-0",
    };
  }
  const payload = object(original.payload);
  const event =
    original.payload_type === "runtime.session" &&
    equalsInteger(original.payload_schema_version, 1) &&
    payload?.kind === "run"
      ? object(payload.event)
      : null;
  const started = event?.kind === "started";
  const display = event?.kind === "user_prompt_display";
  const steer =
    event?.kind === "inbox_item_queued" && object(event.source)?.source === "user_steer";
  const user = started || display || steer;
  const assistant = event?.kind === "assistant_message_committed";
  const field = started ? "prompt" : "text";
  const steeringPayload = steer ? object(event?.payload) : null;
  const text = steer
    ? (string(steeringPayload?.prompt) ?? string(event?.body))
    : user || assistant
      ? string(event?.[field])
      : null;
  const calls = event?.kind === "assistant_tool_calls_committed";
  const results = RESULT_KINDS.has(string(event?.kind) ?? "");
  const items = calls ? event?.tool_calls : results ? event?.results : null;
  const entries = Array.isArray(items) ? items : results && event ? [event] : [];
  const textPath = steer
    ? typeof steeringPayload?.prompt === "string"
      ? ["payload", "event", "payload", "prompt"]
      : ["payload", "event", "body"]
    : ["payload", "event", field];
  const parts: Part[] =
    text === null
      ? []
      : [
          {
            contentStatus: "included",
            kind: "text",
            originalPath: textPath,
            text,
            toolCallId: null,
            toolName: null,
          },
        ];
  const identities: { id: string; path: (string | number)[] }[] = [];
  entries.forEach((value, index) => {
    const item = object(value);
    const path: (string | number)[] = Array.isArray(items)
      ? ["payload", "event", calls ? "tool_calls" : "results", index]
      : ["payload", "event"];
    const idField = calls
      ? string(item?.call_id)
        ? "call_id"
        : "id"
      : string(item?.tool_call_id)
        ? "tool_call_id"
        : "call_id";
    const id = string(item?.[idField]);
    if (id) identities.push({ id, path: [...path, idField] });
    parts.push({
      contentStatus: item ? "included" : "unknown",
      kind: item ? (calls ? "tool-call" : "tool-result") : "unknown",
      originalPath: path,
      text: results ? (string(item?.text) ?? string(item?.output) ?? string(item?.result)) : null,
      toolCallId: id,
      toolName: calls ? string(item?.name) : null,
    });
  });
  const micros = unsignedInteger(original.recorded_at);
  const fraction =
    micros === null ? "" : (micros % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return {
    kind: "record",
    nativeId: string(original.id),
    normalized: {
      kind: results ? "tool-result" : user || assistant || calls ? "message" : "unknown",
      parts,
      relationships: {
        "branch-origin": unknown(),
        "first-kept-entry": unknown(),
        "parent-conversation": unknown(),
        "parent-entry": unknown(),
        "tool-call": identities.length
          ? {
              basis: "native-field",
              originalPaths: identities.map((identity) => identity.path),
              ruleId: null,
              state: "known",
              targets: identities.map(({ id }) =>
                nativeReference("tool-call", id, {
                  harness: "muse",
                  conversationId,
                  location: null,
                  sourceKey: null,
                }),
              ),
            }
          : unknown(),
      },
      role: results ? "tool" : user ? "user" : assistant || calls ? "assistant" : null,
      timestamp: micros === null ? null : `${micros / 1000000n}${fraction ? `.${fraction}` : ""}`,
    },
    original,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}

function permissionFrameRecords(frame: JsonObject): JsonObject[] {
  if (
    frame.retained_frame !== "session_permission_transaction" ||
    !equalsInteger(frame.frame_schema_version, 1)
  ) {
    throw new TranscriptError(
      "guarantee-unmet",
      "Unestablished native Muse retained-frame variant.",
      "format",
    );
  }
  if (
    unsignedInteger(frame.outer_log_ordinal) === null ||
    !string(frame.transaction_id) ||
    !string(frame.content_sha256) ||
    !Array.isArray(frame.children) ||
    frame.children.length === 0
  ) {
    throw new TranscriptError("source-malformed", "Invalid native Muse permission-frame metadata.");
  }
  return frame.children.map((value, index) => {
    const child = object(value);
    const text = string(child?.record_json);
    if (unsignedInteger(child?.child_index) !== BigInt(index) || text === null) {
      throw new TranscriptError(
        "source-malformed",
        "Invalid native Muse permission-frame child order or record.",
      );
    }
    const record = object(parseNativeJson(text));
    if (record === null) {
      throw new TranscriptError(
        "source-malformed",
        "Native Muse permission-frame children must be envelopes.",
      );
    }
    return record;
  });
}

export function parseMuseHistory(input: string | Uint8Array): NativeHistory {
  const entries = [...nativeEntries(input)];
  let identityRecord: JsonObject | null = null;
  let sessionId: string | null = null;
  const ids = new Set<string>();
  const transactions = new Set<string>();
  let lastSequence = -1n;
  let lastFrameOrdinal = -1n;
  const validate = (original: JsonObject): void => {
    const observed = object(original.stream);
    if (sessionId === null) {
      const id = string(observed?.id);
      if (observed?.kind !== "session" || !id) {
        throw new TranscriptError("source-malformed", "Missing native Muse session identity.");
      }
      sessionId = id;
      identityRecord = original;
    }
    if (!equalsInteger(original.schema_version, 1)) {
      throw new TranscriptError("guarantee-unmet", "Unestablished native Muse envelope schema.");
    }
    const sequence = unsignedInteger(original.sequence);
    if (
      sequence === null ||
      unsignedInteger(original.recorded_at) === null ||
      unsignedInteger(original.payload_schema_version) === null ||
      !object(original.payload) ||
      !string(original.record_type) ||
      !string(original.durability) ||
      !string(original.payload_type) ||
      !(original.causation_id === null || string(original.causation_id))
    ) {
      throw new TranscriptError("source-malformed", "Invalid native Muse envelope metadata.");
    }
    if (sequence <= lastSequence) {
      throw new TranscriptError("source-malformed", "Conflicting native Muse sequence order.");
    }
    lastSequence = sequence;
    if (observed?.kind !== "session" || observed.id !== sessionId) {
      throw new TranscriptError(
        "source-identity-mismatch",
        "Conflicting native Muse session identity.",
      );
    }
    const id = string(original.id);
    if (!id || ids.has(id)) {
      throw new TranscriptError(
        "source-malformed",
        "Missing or conflicting native Muse record identity.",
      );
    }
    ids.add(id);
  };
  for (const { original } of entries) {
    if (original.retained_frame !== undefined && !equalsInteger(original.schema_version, 1)) {
      const children = permissionFrameRecords(original);
      const ordinal = unsignedInteger(original.outer_log_ordinal);
      const transaction = string(original.transaction_id);
      if (
        ordinal === null ||
        ordinal <= lastFrameOrdinal ||
        transaction === null ||
        transactions.has(transaction)
      ) {
        throw new TranscriptError(
          "source-malformed",
          "Conflicting native Muse permission-frame order or transaction identity.",
        );
      }
      lastFrameOrdinal = ordinal;
      transactions.add(transaction);
      children.forEach(validate);
    } else {
      validate(original);
    }
  }
  if (identityRecord === null) {
    throw new TranscriptError("source-malformed", "Missing native Muse session identity.");
  }
  return { entries, identityRecord, headers: [] };
}
