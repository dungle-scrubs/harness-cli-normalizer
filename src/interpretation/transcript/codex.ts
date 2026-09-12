import { CODEX_TRANSCRIPT_EVIDENCE } from "../../knowledge/transcript/codex.js";
import type { Part, RecordEnvelope, Reference } from "../../knowledge/transcript/wire.js";
import type { Json } from "./json.js";
import { equalsInteger, JsonNumber, object, string, TranscriptError } from "./json.js";
import type { NativeBase, NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";
import { nativeReference, unknownRelation as unknown } from "./relations.js";

export function parseCodexHistory(text: string | Uint8Array): NativeHistory {
  const rows = [...nativeEntries(text)];
  const first = rows.shift();
  const header = first?.original;
  const metadata = object(header?.payload);
  if (header?.type !== "session_meta" || !metadata || !string(metadata.id))
    throw new TranscriptError("source-malformed", "Missing native rollout identity.");
  if (
    metadata.cli_version !== CODEX_TRANSCRIPT_EVIDENCE.appliesTo.writerBuilds[0]?.version ||
    (metadata.history_mode !== undefined &&
      metadata.history_mode !== "legacy" &&
      metadata.history_mode !== "paginated") ||
    (metadata.history_mode !== "paginated" &&
      metadata.history_base !== undefined &&
      metadata.history_base !== null)
  )
    throw new TranscriptError(
      "guarantee-unmet",
      "The selected rollout has an unsupported writer version or history mode.",
    );
  if (rows.some((row) => row.original.type === "session_meta"))
    throw new TranscriptError(
      "guarantee-unmet",
      "Additional native source metadata requires separate format evidence.",
    );
  if (metadata.history_mode === "paginated") {
    const start =
      codexBase({ entries: rows, identityRecord: header, headers: [header] })?.ordinal ?? 0;
    for (const [index, row] of [first, ...rows].entries()) {
      if (!row || integer(row.original.ordinal) !== start + index)
        throw new TranscriptError(
          "guarantee-unmet",
          "Paginated ordinals must be contiguous and include metadata.",
        );
    }
    if (
      metadata.subagent_history_start_ordinal !== undefined &&
      metadata.subagent_history_start_ordinal !== null &&
      start + rows.length + 1 < integer(metadata.subagent_history_start_ordinal)
    )
      throw new TranscriptError(
        "guarantee-unmet",
        "Native subagent initialization has an incomplete inherited prefix.",
      );
  }
  return { entries: rows, identityRecord: header, headers: [header] };
}
function integer(value: Json | undefined): number {
  if (
    value instanceof JsonNumber &&
    equalsInteger(value, Number(value.text)) &&
    Number(value.text) >= 0
  )
    return Number(value.text);
  throw new TranscriptError("guarantee-unmet", "Invalid or unaddressable native ordinal/offset.");
}
export function codexBase(history: NativeHistory): NativeBase | null {
  const metadata = object(history.identityRecord.payload);
  if (metadata?.history_base === null || metadata?.history_base === undefined) return null;
  const base = object(metadata.history_base);
  const nativeId = string(base?.thread_id);
  if (!nativeId)
    throw new TranscriptError("guarantee-unmet", "Invalid native history base identity.");
  const offset = integer(base?.end_byte_offset);
  const ordinal = integer(base?.end_ordinal_exclusive);
  if (!offset || !ordinal)
    throw new TranscriptError("guarantee-unmet", "Empty native history base boundary.");
  return { nativeId, offset, ordinal };
}
export function validateCodexBase(history: NativeHistory, base: NativeBase): void {
  const last = history.entries.at(-1)?.original ?? history.identityRecord;
  if (
    object(history.identityRecord.payload)?.history_mode !== "paginated" ||
    integer(last.ordinal) + 1 !== base.ordinal
  )
    throw new TranscriptError("guarantee-unmet", "Native base ordinal and byte cutoff disagree.");
}
export function codexNativeId(history: NativeHistory): string {
  return string(object(history.identityRecord.payload)?.id) ?? "";
}
export function normalizeCodex(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const payload = object(entry.original.payload);
  const type = payload?.type;
  const response = entry.original.type === "response_item";
  const knownCall = response && (type === "function_call" || type === "custom_tool_call");
  const knownResult =
    response && (type === "function_call_output" || type === "custom_tool_call_output");
  const callId = knownCall || knownResult ? string(payload?.call_id) : null;
  const targets: Reference[] = callId
    ? [
        nativeReference("tool-call", callId, {
          conversationId,
          harness: "codex",
          location: null,
          sourceKey: null,
        }),
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
