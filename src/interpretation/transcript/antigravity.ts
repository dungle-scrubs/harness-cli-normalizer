import { UUID_SHAPE } from "../../knowledge/descriptor.js";
import type { Part, RecordEnvelope } from "../../knowledge/transcript/wire.js";
import { JsonNumber, object, string, TranscriptError } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";
import { unknownRelation as unknown } from "./relations.js";

const LOG = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript_full\.jsonl$/;

/** The step log carries no conversation identity; its brain directory does. */
export function antigravityConversationId(path: string): string {
  const id = LOG.exec(path)?.[1];
  if (!id || !UUID_SHAPE.test(id))
    throw new TranscriptError(
      "source-identity-mismatch",
      "Antigravity conversation identity comes from brain/<id>/.system_generated/logs/transcript_full.jsonl.",
    );
  return id;
}

export function antigravityLogPath(id: string): string | null {
  return UUID_SHAPE.test(id) ? `${id}/.system_generated/logs/transcript_full.jsonl` : null;
}

export function parseAntigravityHistory(input: string | Uint8Array): NativeHistory {
  const entries = [...nativeEntries(input)];
  entries.forEach(({ original }, index) => {
    const step = original.step_index;
    if (
      !(step instanceof JsonNumber) ||
      !string(original.type) ||
      !string(original.source) ||
      !string(original.status)
    )
      throw new TranscriptError("source-malformed", "Invalid native Antigravity step metadata.");
    if (Number(step.text) !== index)
      throw new TranscriptError(
        "guarantee-unmet",
        "Native Antigravity steps are not contiguous from step 0.",
      );
    if (original.truncated_fields !== undefined)
      throw new TranscriptError(
        "guarantee-unmet",
        "The native Antigravity step log truncates retained content.",
      );
  });
  return { entries, identityRecord: {}, headers: [] };
}

function text(
  kind: "text" | "thinking",
  value: string | null,
  path: readonly (string | number)[],
): Part[] {
  return value === null
    ? []
    : [
        {
          contentStatus: "included",
          kind,
          originalPath: path,
          text: value,
          toolCallId: null,
          toolName: null,
        },
      ];
}

export function normalizeAntigravity(entry: NativeEntry, _conversationId: string): RecordEnvelope {
  const original = entry.original;
  const type = original.type;
  const content = string(original.content);
  const parts: Part[] = [];
  if (type === "PLANNER_RESPONSE") {
    parts.push(...text("thinking", string(original.thinking), ["thinking"]));
    parts.push(...text("text", content, ["content"]));
    const calls = Array.isArray(original.tool_calls) ? original.tool_calls : [];
    calls.forEach((value, index) => {
      const call = object(value);
      parts.push({
        contentStatus: call ? "included" : "unknown",
        kind: call ? "tool-call" : "unknown",
        originalPath: ["tool_calls", index],
        text: null,
        toolCallId: null,
        toolName: string(call?.name),
      });
    });
  } else if (type === "GENERIC") {
    parts.push({
      contentStatus: "included",
      kind: "tool-result",
      originalPath: ["content"],
      text: content,
      toolCallId: null,
      toolName: null,
    });
  } else if (type === "USER_INPUT" || type === "SYSTEM_MESSAGE") {
    parts.push(...text("text", content, ["content"]));
  }
  const role =
    type === "USER_INPUT"
      ? "user"
      : type === "SYSTEM_MESSAGE"
        ? "system"
        : type === "PLANNER_RESPONSE"
          ? "assistant"
          : type === "GENERIC"
            ? "tool"
            : null;
  return {
    kind: "record",
    nativeId: null,
    normalized: {
      kind: type === "GENERIC" ? "tool-result" : role ? "message" : "unknown",
      parts,
      relationships: {
        "branch-origin": unknown(),
        "first-kept-entry": unknown(),
        "parent-conversation": unknown(),
        "parent-entry": unknown(),
        "tool-call": unknown(),
      },
      role,
      timestamp: string(original.created_at),
    },
    original,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}
