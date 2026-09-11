import { PI_TRANSCRIPT_EVIDENCE } from "../../knowledge/transcript/pi.js";
import type {
  BranchObservation,
  Part,
  RecordEnvelope,
  Reference,
  Relation,
  RelationshipMap,
} from "../../knowledge/transcript/wire.js";
import type { JsonObject } from "./json.js";
import { equalsInteger, object, string, TranscriptError } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";

export function parsePiHistory(text: string | Uint8Array): NativeHistory {
  const entries: NativeEntry[] = [];
  let header: JsonObject | null = null;
  const ids = new Set<string>();
  for (const { original, offset } of nativeEntries(text)) {
    if (!header) {
      if (original.type !== "session" || !equalsInteger(original.version, 3))
        throw new TranscriptError(
          "guarantee-unmet",
          "The source is not a verified Pi v3 transcript.",
        );
      if (!string(original.id) || !string(original.cwd))
        throw new TranscriptError("source-malformed", "The native conversation header is invalid.");
      header = original;
    } else {
      const id = string(original.id);
      if (
        !id ||
        ids.has(id) ||
        !string(original.type) ||
        original.type === "session" ||
        !(original.parentId === null || typeof original.parentId === "string")
      )
        throw new TranscriptError(
          "source-malformed",
          "Invalid or duplicate native entry identity.",
        );
      ids.add(id);
      entries.push({ offset, original });
    }
  }
  if (!header)
    throw new TranscriptError(
      "source-malformed",
      "A complete native conversation header is required.",
    );
  return { entries, header };
}

export function reference(
  kind: "entry" | "tool-call" | "conversation",
  id: string,
  conversationId: string,
): Reference {
  return {
    kind,
    nativeId: id,
    position: null,
    scope: { conversationId, harness: "pi", location: null, sourceKey: "source-0" },
  };
}
function relation(
  id: string | null,
  path: readonly (string | number)[],
  kind: "entry" | "tool-call",
  conversationId: string,
): Relation {
  return {
    basis: id ? "native-field" : "unknown",
    originalPaths: id ? [path] : [],
    ruleId: null,
    state: id ? "known" : "unknown",
    targets: id ? [reference(kind, id, conversationId)] : [],
  };
}
export function normalizePi(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const original = entry.original;
  const message = original.type === "message" ? object(original.message) : null;
  const role = string(message?.role);
  const content =
    message?.content ?? (original.type === "custom_message" ? original.content : undefined);
  const base = message ? ["message", "content"] : ["content"];
  const parts: Part[] = [];
  if (typeof content === "string")
    parts.push({
      contentStatus: "included",
      kind: "text",
      originalPath: base,
      text: content,
      toolCallId: null,
      toolName: null,
    });
  else if (Array.isArray(content))
    content.forEach((value, index) => {
      const block = object(value);
      const type = string(block?.type);
      const kind =
        type === "toolCall"
          ? "tool-call"
          : type === "text" || type === "thinking" || type === "image"
            ? type
            : "unknown";
      parts.push({
        contentStatus: kind === "unknown" ? "unknown" : "included",
        kind,
        originalPath: [...base, index],
        text: string(block?.text) ?? string(block?.thinking),
        toolCallId: type === "toolCall" ? string(block?.id) : null,
        toolName: type === "toolCall" ? string(block?.name) : null,
      });
    });
  if (
    (original.type === "compaction" || original.type === "branch_summary") &&
    typeof original.summary === "string"
  )
    parts.push({
      contentStatus: "included",
      kind: "text",
      originalPath: ["summary"],
      text: original.summary,
      toolCallId: null,
      toolName: null,
    });
  const relationships: RelationshipMap = {
    "branch-origin":
      original.type === "branch_summary" && original.parentId === null && original.fromId === "root"
        ? {
            basis: "native-field",
            originalPaths: [["parentId"], ["fromId"]],
            ruleId: null,
            state: "none",
            targets: [],
          }
        : relation(
            original.type === "branch_summary" && original.fromId === original.parentId
              ? string(original.fromId)
              : null,
            ["fromId"],
            "entry",
            conversationId,
          ),
    "first-kept-entry": relation(
      original.type === "compaction" ? string(original.firstKeptEntryId) : null,
      ["firstKeptEntryId"],
      "entry",
      conversationId,
    ),
    "parent-conversation": {
      basis: "unknown",
      originalPaths: [],
      ruleId: null,
      state: "unknown",
      targets: [],
    },
    "parent-entry":
      original.parentId === null
        ? {
            basis: "native-field",
            originalPaths: [["parentId"]],
            ruleId: null,
            state: "none",
            targets: [],
          }
        : relation(string(original.parentId), ["parentId"], "entry", conversationId),
    "tool-call": relation(
      string(message?.toolCallId),
      ["message", "toolCallId"],
      "tool-call",
      conversationId,
    ),
  };
  const instant = typeof original.timestamp === "string" ? Date.parse(original.timestamp) : NaN;
  return {
    kind: "record",
    nativeId: string(original.id),
    normalized: {
      kind:
        role === "toolResult"
          ? "tool-result"
          : original.type === "message"
            ? "message"
            : original.type === "compaction"
              ? "compaction"
              : original.type === "branch_summary"
                ? "branch-summary"
                : original.type === "custom" || original.type === "custom_message"
                  ? "custom"
                  : ["model_change", "thinking_level_change", "label", "session_info"].includes(
                        String(original.type),
                      )
                    ? "metadata"
                    : "unknown",
      parts,
      relationships,
      role:
        role === "toolResult"
          ? "tool"
          : role === "user" || role === "assistant" || role === "system"
            ? role
            : message
              ? "unknown"
              : null,
      timestamp: Number.isFinite(instant) ? String(instant / 1000) : null,
    },
    original,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}
export function piBranch(history: NativeHistory, conversationId: string): BranchObservation {
  const last = history.entries.at(-1);
  const nativeId = string(last?.original.id);
  return last && nativeId
    ? {
        evidence: [PI_TRANSCRIPT_EVIDENCE],
        selection: reference("entry", nativeId, conversationId),
        state: "known",
        view: "saved",
      }
    : { evidence: [], selection: null, state: "unknown", view: "unknown" };
}
