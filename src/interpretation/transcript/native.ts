import type { Position } from "../../knowledge/transcript/wire.js";
import type { JsonObject } from "./json.js";
import { object, parseNativeJson, TranscriptError } from "./json.js";

export interface NativeEntry {
  readonly offset: number;
  readonly original: JsonObject;
}
export interface NativeHistory {
  readonly entries: NativeEntry[];
  readonly identityRecord: JsonObject;
  readonly headers: readonly JsonObject[];
}
export function position(offset: number): Position {
  return { sourceKey: "source-0", unit: "byte-offset", value: String(offset) };
}
export function* nativeEntries(input: string | Uint8Array): Generator<NativeEntry> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    let line: string;
    try {
      line = decoder.decode(bytes.subarray(offset, end));
    } catch {
      throw new TranscriptError("source-malformed", "Invalid source encoding.");
    }
    const original = object(parseNativeJson(line));
    if (!original) throw new TranscriptError("source-malformed", "Native entries must be objects.");
    yield { offset, original };
    offset = end + 1;
  }
}

export interface NativeBase {
  readonly nativeId: string;
  readonly offset: number;
  readonly ordinal: number;
}
