import { CODEX_TRANSCRIPT_EVIDENCE } from "../../knowledge/transcript/codex.js";
import type { Part, RecordEnvelope, Reference, Relation } from "../../knowledge/transcript/wire.js";
import { object, string, TranscriptError } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";

export function parseCodexHistory(text: string | Uint8Array): NativeHistory {
  const rows = [...nativeEntries(text)];
  const first = rows.shift();
  const header = first?.original;
  const metadata = object(header?.payload);
  if (header?.type !== "session_meta" || !metadata || !string(metadata.id))
    throw new TranscriptError("source-malformed", "Missing native rollout identity.");
  if (
    metadata.cli_version !== CODEX_TRANSCRIPT_EVIDENCE.appliesTo.writerBuilds[0]?.version ||
    (metadata.history_mode !== undefined && metadata.history_mode !== "legacy") ||
    (metadata.history_base !== undefined && metadata.history_base !== null)
  )
    throw new TranscriptError(
      "guarantee-unmet",
      "The selected rollout is not a verified standalone legacy view.",
    );
  if (rows.some((row) => row.original.type === "session_meta"))
    throw new TranscriptError(
      "guarantee-unmet",
      "Additional native source metadata requires separate format evidence.",
    );
  return { entries: rows, header };
}
export function codexNativeId(history: NativeHistory): string {
  return string(object(history.header.payload)?.id) ?? "";
}
export function normalizeCodex(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const payload = object(entry.original.payload);
  const type = payload?.type;
  const response = entry.original.type === "response_item";
  const knownCall = response && (type === "function_call" || type === "custom_tool_call");
  const knownResult =
    response && (type === "function_call_output" || type === "custom_tool_call_output");
  const callId = knownCall || knownResult ? string(payload?.call_id) : null;
  const unknown = (): Relation => ({
    basis: "unknown",
    originalPaths: [],
    ruleId: null,
    state: "unknown",
    targets: [],
  });
  const targets: Reference[] = callId
    ? [
        {
          kind: "tool-call",
          nativeId: callId,
          position: null,
          scope: { conversationId, harness: "codex", location: null, sourceKey: "source-0" },
        },
      ]
    : [];
  const parts: Part[] = [];
  if (knownCall || knownResult)
    parts.push({
      contentStatus: "included",
      kind: knownCall ? "tool-call" : "tool-result",
      originalPath: ["payload"],
      text: knownResult ? string(payload?.output) : null,
      toolCallId: callId,
      toolName: knownCall ? string(payload?.name) : null,
    });
  if (response && type === "message" && Array.isArray(payload?.content))
    payload.content.forEach((content, index) => {
      const block = object(content);
      parts.push({
        contentStatus: string(block?.text) !== null ? "included" : "unknown",
        kind: string(block?.text) !== null ? "text" : "unknown",
        originalPath: ["payload", "content", index],
        text: string(block?.text),
        toolCallId: null,
        toolName: null,
      });
    });
  const role = response && type === "message" ? string(payload?.role) : null;
  return {
    kind: "record",
    nativeId: response ? string(payload?.id) : null,
    normalized: {
      kind: knownResult
        ? "tool-result"
        : response && type === "message"
          ? "message"
          : entry.original.type === "compacted"
            ? "compaction"
            : "unknown",
      parts,
      relationships: {
        "branch-origin": unknown(),
        "first-kept-entry": unknown(),
        "parent-conversation": unknown(),
        "parent-entry": unknown(),
        "tool-call": callId
          ? {
              basis: "native-field",
              originalPaths: [["payload", "call_id"]],
              ruleId: null,
              state: "known",
              targets,
            }
          : unknown(),
      },
      role: knownResult
        ? "tool"
        : role === "user" || role === "assistant" || role === "system" || role === "developer"
          ? role === "developer"
            ? "custom"
            : role
          : role === null
            ? null
            : "unknown",
      timestamp: null,
    },
    original: entry.original,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}
