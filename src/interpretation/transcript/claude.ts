import {
  CLAUDE_TRANSCRIPT_ENTRY_TYPES,
  CLAUDE_TRANSCRIPT_EVIDENCE,
} from "../../knowledge/transcript/claude.js";
import type {
  BranchObservation,
  Part,
  RecordEnvelope,
  Reference,
  Relation,
} from "../../knowledge/transcript/wire.js";
import { object, string, TranscriptError } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";
import { nativeReference, nativeRelation, unknownRelation as unknown } from "./relations.js";

export function parseClaudeHistory(input: string | Uint8Array): NativeHistory {
  const entries = [...nativeEntries(input)];
  const header = entries.find(
    ({ original }) =>
      CLAUDE_TRANSCRIPT_ENTRY_TYPES.includes(string(original.type) ?? "") &&
      string(original.sessionId),
  )?.original;
  if (!header)
    throw new TranscriptError("source-malformed", "Missing native Claude conversation identity.");
  const ids = new Set<string>();
  for (const { original } of entries) {
    if (original.isSidechain === true || string(original.agentId))
      throw new TranscriptError(
        "guarantee-unmet",
        "Agent transcript identity requires a separate method.",
      );
    const type = string(original.type);
    const message = object(original.message);
    if (
      !type ||
      ((type === "user" || type === "assistant") &&
        (!string(original.uuid) ||
          !string(original.sessionId) ||
          (original.parentUuid !== null && !string(original.parentUuid)) ||
          !message ||
          message.role !== type ||
          !(typeof message.content === "string" || Array.isArray(message.content))))
    )
      throw new TranscriptError("source-malformed", "Invalid native Claude record shape.");
    if (original.sessionId !== undefined && original.sessionId !== header.sessionId)
      throw new TranscriptError(
        "source-identity-mismatch",
        "Conflicting native Claude conversation identity.",
      );
    const id = CLAUDE_TRANSCRIPT_ENTRY_TYPES.includes(type) ? string(original.uuid) : null;
    if (id && ids.has(id))
      throw new TranscriptError("source-malformed", "Conflicting native Claude entry identity.");
    if (id) ids.add(id);
  }
  return { entries, identityRecord: header, headers: [] };
}

export function claudeBranch(history: NativeHistory, conversationId: string): BranchObservation {
  const saved = history.entries.findLast(
    ({ original }) =>
      original.type === "last-prompt" && original.explicit === true && "leafUuid" in original,
  );
  const id = string(saved?.original.leafUuid);
  return id
    ? {
        evidence: [CLAUDE_TRANSCRIPT_EVIDENCE],
        selection: reference("entry", id, conversationId),
        state: "known",
        view: "saved",
      }
    : { evidence: [], selection: null, state: "unknown", view: "unknown" };
}
function reference(kind: Reference["kind"], nativeId: string, conversationId: string): Reference {
  return nativeReference(kind, nativeId, {
    conversationId,
    harness: "claude",
    location: null,
    sourceKey: null,
  });
}
function relation(
  kind: Reference["kind"],
  id: string | null,
  conversationId: string,
  path: readonly (string | number)[],
): Relation {
  return nativeRelation(id ? reference(kind, id, conversationId) : null, path);
}
export function normalizeClaude(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const original = entry.original;
  const message =
    original.type === "user" || original.type === "assistant" ? object(original.message) : null;
  const system = original.type === "system";
  const compact = system && original.subtype === "compact_boundary";
  const preserved = compact ? object(object(original.compactMetadata)?.preservedSegment) : null;
  const content = system ? original.content : message?.content;
  const parts: Part[] = [];
  const calls: { id: string; path: (string | number)[] }[] = [];
  if (typeof content === "string")
    parts.push({
      contentStatus: "included",
      kind: "text",
      originalPath: system ? ["content"] : ["message", "content"],
      text: content,
      toolCallId: null,
      toolName: null,
    });
  else if (message && Array.isArray(content))
    content.forEach((value, index) => {
      const block = object(value);
      const type = string(block?.type);
      const call = type === "tool_use";
      const result = type === "tool_result";
      const id = call ? string(block?.id) : result ? string(block?.tool_use_id) : null;
      const media = type === "image" ? object(block?.source) : null;
      const kind = call
        ? "tool-call"
        : result
          ? "tool-result"
          : type === "text" || type === "thinking" || type === "image"
            ? type
            : "unknown";
      if (id) calls.push({ id, path: ["message", "content", index, call ? "id" : "tool_use_id"] });
      parts.push({
        contentStatus:
          kind === "unknown"
            ? "unknown"
            : kind === "image"
              ? media?.type === "url"
                ? "not-included"
                : media?.type === "base64" && typeof media.data === "string"
                  ? "included"
                  : "unknown"
              : "included",
        kind,
        originalPath: ["message", "content", index],
        text: result
          ? string(block?.content)
          : type === "text"
            ? string(block?.text)
            : type === "thinking"
              ? string(block?.thinking)
              : null,
        toolCallId: id,
        toolName: call ? string(block?.name) : null,
      });
    });
  const toolResult = parts.length > 0 && parts.every((part) => part.kind === "tool-result");
  const instant = typeof original.timestamp === "string" ? Date.parse(original.timestamp) : NaN;
  const forkId = original.type === "fork-context-ref" ? string(original.parentSessionId) : null;
  return {
    kind: "record",
    nativeId: CLAUDE_TRANSCRIPT_ENTRY_TYPES.includes(string(original.type) ?? "")
      ? string(original.uuid)
      : null,
    normalized: {
      kind: compact
        ? "compaction"
        : toolResult
          ? "tool-result"
          : message || system
            ? "message"
            : "unknown",
      parts,
      relationships: {
        "branch-origin": forkId
          ? relation("entry", string(original.parentLastUuid), forkId, ["parentLastUuid"])
          : unknown(),
        "first-kept-entry": preserved
          ? relation("entry", string(preserved.headUuid), conversationId, [
              "compactMetadata",
              "preservedSegment",
              "headUuid",
            ])
          : unknown(),
        "parent-conversation": forkId
          ? relation("conversation", forkId, forkId, ["parentSessionId"])
          : unknown(),
        "parent-entry": message
          ? original.parentUuid === null
            ? {
                basis: "native-field",
                originalPaths: [["parentUuid"]],
                ruleId: null,
                state: "none",
                targets: [],
              }
            : relation("entry", string(original.parentUuid), conversationId, ["parentUuid"])
          : unknown(),
        "tool-call": calls.length
          ? {
              basis: "native-field",
              originalPaths: calls.map((call) => call.path),
              ruleId: null,
              state: "known",
              targets: calls.map((call) => reference("tool-call", call.id, conversationId)),
            }
          : unknown(),
      },
      role: system
        ? "system"
        : toolResult
          ? "tool"
          : message
            ? original.type === "user"
              ? "user"
              : "assistant"
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
