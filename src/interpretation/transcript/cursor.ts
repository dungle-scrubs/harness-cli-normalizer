import type { Part, RecordEnvelope } from "../../knowledge/transcript/wire.js";
import { sha256Hex } from "../sha256.js";
import type { Json, JsonObject } from "./json.js";
import { encodeJson, object, parseNativeJson, string, TranscriptError } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { nativeEntries, position } from "./native.js";
import { nativeReference, unknownRelation as unknown } from "./relations.js";
import { SqliteImage } from "./sqlite.js";

const SCHEMA = new Map([
  ["blobs", "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)"],
  ["meta", "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"],
]);
const BLOB_ID = /^[0-9a-f]{64}$/;

function malformed(message: string): TranscriptError {
  return new TranscriptError("source-malformed", `Invalid native Cursor chat store: ${message}`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Field-1 blob references of a root blob, or null when the bytes are not a root. */
function rootReferences(bytes: Uint8Array): string[] | null {
  const ids: string[] = [];
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("long varint");
  };
  try {
    while (offset < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (field < 1) return null;
      if (wire === 0) varint();
      else if (wire === 1) offset += 8;
      else if (wire === 5) offset += 4;
      else if (wire === 2) {
        const length = varint();
        if (field === 1) {
          if (length !== 32) return null;
          ids.push(hex(bytes.subarray(offset, offset + 32)));
        }
        offset += length;
      } else return null;
      if (offset > bytes.length) return null;
    }
  } catch {
    return null;
  }
  return ids;
}

/** A message blob's JSON object with a role, or null for a non-message blob. */
function messageOf(data: Uint8Array): JsonObject | null {
  let parsed: JsonObject | null;
  try {
    parsed = object(parseNativeJson(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  } catch {
    return null;
  }
  if (parsed && !string(parsed.role)) throw malformed("message blob.");
  return parsed;
}

function text(value: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw malformed(`${what} encoding.`);
  }
}

/**
 * Projects one checkpointed Cursor chat store onto LF-framed JSON: an identity
 * line holding the agent ID, then one `{blobId, message}` line per message the
 * latest root references, in root order.
 */
export function frameCursorStore(bytes: Uint8Array): Uint8Array {
  const image = new SqliteImage(bytes);
  const tables = new Map(image.tables().map((table) => [table.name, table]));
  for (const [name, sql] of SCHEMA)
    if (tables.get(name)?.sql.replace(/\s+/g, " ").trim() !== sql)
      throw new TranscriptError(
        "guarantee-unmet",
        "The source is not an established Cursor chat store schema.",
      );
  const metaRows = image.rows(tables.get("meta")?.rootPage ?? 0);
  const metaValue = metaRows.find(([key]) => key === "0")?.[1];
  if (metaRows.length !== 1 || typeof metaValue !== "string" || !/^([0-9a-f]{2})+$/.test(metaValue))
    throw malformed("meta row.");
  const meta = object(
    parseNativeJson(
      text(
        Uint8Array.from(metaValue.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)),
        "meta",
      ),
    ),
  );
  const agentId = string(meta?.agentId);
  const latest = string(meta?.latestRootBlobId);
  if (!agentId || !latest || !BLOB_ID.test(latest)) throw malformed("meta identity.");
  const blobs = new Map<string, Uint8Array>();
  for (const [id, data] of image.rows(tables.get("blobs")?.rootPage ?? 0)) {
    if (typeof id !== "string" || !BLOB_ID.test(id) || blobs.has(id)) throw malformed("blob id.");
    if (!(data instanceof Uint8Array)) throw malformed("blob data.");
    // Content addressing detects a page mix from a checkpoint inside the clone window.
    if (sha256Hex(data) !== id) throw malformed("blob content does not match its ID.");
    blobs.set(id, data);
  }
  const messages = new Map<string, JsonObject>();
  const roots = new Map<string, string[]>();
  for (const [id, data] of blobs) {
    const message = messageOf(data);
    if (message) messages.set(id, message);
    else {
      const references = rootReferences(data);
      if (references?.length) roots.set(id, references);
    }
  }
  const order = roots.get(latest);
  if (!order) throw malformed("latest root.");
  for (const references of roots.values())
    if (references.some((id) => !messages.has(id))) throw malformed("unresolved root reference.");
  // Earlier roots stay in the store. Reading the latest one is complete only
  // while every earlier message list is a prefix of it.
  for (const [id, earlier] of roots)
    if (
      id !== latest &&
      (earlier.length > order.length || earlier.some((ref, index) => order[index] !== ref))
    )
      throw new TranscriptError(
        "guarantee-unmet",
        "An earlier Cursor root references messages the latest root does not retain in order.",
        "retrieval",
      );
  const lines = [encodeJson({ agentId })];
  for (const id of order)
    lines.push(`{"blobId":"${id}","message":${encodeJson(messages.get(id))}}`);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

export function parseCursorHistory(input: string | Uint8Array): NativeHistory {
  const [identity, ...entries] = nativeEntries(input);
  if (!identity || !string(identity.original.agentId)) throw malformed("projected identity.");
  for (const { original } of entries)
    if (!string(original.blobId) || !object(original.message))
      throw malformed("projected message.");
  return { entries, identityRecord: identity.original, headers: [] };
}

function part(item: Json | undefined, index: number): Part {
  const value = object(item);
  const path = ["content", index];
  const type = value?.type;
  const base = { originalPath: path, text: null, toolCallId: null, toolName: null };
  if (type === "text")
    return { ...base, contentStatus: "included", kind: "text", text: string(value?.text) };
  if (type === "reasoning")
    return { ...base, contentStatus: "included", kind: "thinking", text: string(value?.text) };
  if (type === "redacted-reasoning")
    return { ...base, contentStatus: "not-included", kind: "thinking" };
  if (type === "tool-call" || type === "tool-result")
    return {
      ...base,
      contentStatus: "included",
      kind: type,
      text: type === "tool-result" ? string(value?.result) : null,
      toolCallId: string(value?.toolCallId),
      toolName: string(value?.toolName),
    };
  if (type === "image") return { ...base, contentStatus: "included", kind: "image" };
  if (type === "file") return { ...base, contentStatus: "included", kind: "file-reference" };
  return { ...base, contentStatus: "unknown", kind: "unknown" };
}

export function normalizeCursor(entry: NativeEntry, conversationId: string): RecordEnvelope {
  const message = object(entry.original.message) ?? {};
  const role = message.role;
  const content = message.content;
  const parts: Part[] =
    typeof content === "string"
      ? [
          {
            contentStatus: "included",
            kind: "text",
            originalPath: ["content"],
            text: content,
            toolCallId: null,
            toolName: null,
          },
        ]
      : Array.isArray(content)
        ? content.map(part)
        : [];
  const calls = parts.flatMap((item) => (item.toolCallId ? [item] : []));
  return {
    kind: "record",
    nativeId: string(entry.original.blobId),
    normalized: {
      kind: role === "tool" ? "tool-result" : "message",
      parts,
      relationships: {
        "branch-origin": unknown(),
        "first-kept-entry": unknown(),
        "parent-conversation": unknown(),
        "parent-entry": unknown(),
        "tool-call": calls.length
          ? {
              basis: "native-field",
              originalPaths: calls.map((item) => [...item.originalPath, "toolCallId"]),
              ruleId: null,
              state: "known",
              targets: calls.map((item) =>
                nativeReference("tool-call", item.toolCallId ?? "", {
                  harness: "cursor",
                  conversationId,
                  location: null,
                  sourceKey: null,
                }),
              ),
            }
          : unknown(),
      },
      role:
        role === "user" || role === "assistant" || role === "system" || role === "tool"
          ? role
          : "unknown",
      timestamp: null,
    },
    original: message,
    originalKind: "saved-record",
    position: position(entry.offset),
    schemaVersion: 1,
    sourceKey: "source-0",
  };
}
