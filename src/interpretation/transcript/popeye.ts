import { POPEYE_TRANSCRIPT_EVIDENCE } from "../../knowledge/transcript/popeye.js";
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
import { nativeReference, nativeRelation, unknownRelation } from "./relations.js";

const JOURNAL_VERSION = 1;

const unwrapLine = (original: JsonObject): JsonObject | null => {
  const payload = object(original.payload);
  if (payload === null) return null;
  if (!equalsInteger(original.v, JOURNAL_VERSION)) return null;
  return payload;
};

export function parsePopeyeHistory(text: string | Uint8Array): NativeHistory {
  const entries: NativeEntry[] = [];
  let header: JsonObject | null = null;
  const ids = new Set<string>();
  for (const { original, offset } of nativeEntries(text)) {
    const line = unwrapLine(original);
    if (line === null)
      throw new TranscriptError("source-malformed", "Popeye journal lines must be v1 envelopes.");
    if (!header) {
      if (line.type !== "journal_header" || line.format !== "popeye_journal")
        throw new TranscriptError(
          "guarantee-unmet",
          "The source is not a verified Popeye journal.",
        );
      if (!equalsInteger(line.version, JOURNAL_VERSION) || !string(line.sessionId))
        throw new TranscriptError("source-malformed", "The native conversation header is invalid.");
      header = line;
    } else {
      const item = object(line.item);
      const id = string(item?.id);
      if (
        !id ||
        ids.has(id) ||
        line.type === "journal_header" ||
        (line.type !== "entry" && line.type !== "record") ||
        string(line.sessionId) !== string(header.sessionId)
      )
        throw new TranscriptError(
          "source-malformed",
          "Invalid or duplicate native entry identity.",
        );
      ids.add(id);
      entries.push({ offset, original: line });
    }
  }
  if (!header)
    throw new TranscriptError(
      "source-malformed",
      "A complete native conversation header is required.",
    );
  return { entries, identityRecord: header, headers: [header] };
}

export function reference(
  kind: "entry" | "tool-call" | "conversation",
  id: string,
  conversationId: string,
): Reference {
  return nativeReference(kind, id, {
    conversationId,
    harness: "popeye",
    location: null,
    sourceKey: "source-0",
  });
}

function relation(
  id: string | null,
  path: readonly (string | number)[],
  kind: "entry" | "tool-call",
  conversationId: string,
): Relation {
  return nativeRelation(id ? reference(kind, id, conversationId) : null, path);
}

type NormalizedKind = RecordEnvelope["normalized"]["kind"];
type NormalizedRole = RecordEnvelope["normalized"]["role"];

const entryKind = (type: string, kind: string, role: string | null): NormalizedKind => {
  if (type === "record") return "metadata";
  if (kind === "compaction") return "compaction";
  if (kind === "session_root") return "metadata";
  if (role === "toolResult") return "tool-result";
  if (kind === "message") return "message";
  return "unknown";
};

const entryRole = (role: string | null): NormalizedRole => {
  if (role === "toolResult") return "tool";
  if (role === "user" || role === "assistant" || role === "system") return role;
  return role === null ? null : "unknown";
};

export function normalizePopeye(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const original = entry.original;
  const type = string(original.type) ?? "";
  const item = object(original.item);
  const kind = string(item?.kind) ?? "";
  const payload = object(item?.payload);
  const role = string(payload?.role);
  const parts: Part[] = [];
  const content = payload === null || type === "record" ? undefined : payload.content;
  if (typeof content === "string" && content !== "")
    parts.push({
      contentStatus: "included",
      kind: "text",
      originalPath: ["item", "payload", "content"],
      text: content,
      toolCallId: null,
      toolName: null,
    });
  const toolCalls = payload === null ? undefined : payload.toolCalls;
  if (Array.isArray(toolCalls))
    toolCalls.forEach((call, index) => {
      const block = object(call);
      const id = string(block?.id);
      const name = string(block?.name);
      if (id === null && name === null) return;
      parts.push({
        contentStatus: "included",
        kind: "tool-call",
        originalPath: ["item", "payload", "toolCalls", index],
        text: null,
        toolCallId: id,
        toolName: name,
      });
    });
  const summary = string(payload?.summary);
  if (kind === "compaction" && summary !== null)
    parts.push({
      contentStatus: "included",
      kind: "text",
      originalPath: ["item", "payload", "summary"],
      text: summary,
      toolCallId: null,
      toolName: null,
    });
  const itemId = string(item?.id);
  const parentId = item?.parentId === null ? null : string(item?.parentId);
  const toolCallId = string(payload?.toolCallId);
  const retained = Array.isArray(payload?.retainedTailIds) ? payload?.retainedTailIds : [];
  const firstKept = typeof retained[0] === "string" ? (retained[0] as string) : null;
  const relationships: RelationshipMap = {
    "branch-origin": unknownRelation(),
    "first-kept-entry": relation(
      firstKept,
      ["item", "payload", "retainedTailIds", 0],
      "entry",
      conversationId,
    ),
    "parent-conversation": unknownRelation(),
    "parent-entry":
      parentId === null
        ? {
            basis: "native-field",
            originalPaths: [["item", "parentId"]],
            ruleId: null,
            state: "none",
            targets: [],
          }
        : relation(parentId, ["item", "parentId"], "entry", conversationId),
    "tool-call": relation(
      toolCallId,
      ["item", "payload", "toolCallId"],
      "tool-call",
      conversationId,
    ),
  };
  return {
    kind: "record",
    nativeId: itemId,
    normalized: {
      kind: entryKind(type, kind, role),
      parts,
      relationships,
      role: entryRole(role),
      timestamp: null,
    },
    original,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}

export function popeyeBranch(history: NativeHistory, conversationId: string): BranchObservation {
  const last = history.entries.at(-1);
  const item = object(last?.original.item);
  const nativeId = string(item?.id);
  return last && nativeId
    ? {
        evidence: [POPEYE_TRANSCRIPT_EVIDENCE],
        selection: reference("entry", nativeId, conversationId),
        state: "known",
        view: "saved",
      }
    : { evidence: [], selection: null, state: "unknown", view: "unknown" };
}
