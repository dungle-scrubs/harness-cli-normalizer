import { equalsInteger, JsonNumber, object, parseNativeJson, TranscriptError } from "./json.js";

export interface Bookmark {
  readonly bookmarkVersion: number;
  readonly conversationId: string;
  readonly digest: string;
  readonly entries: number;
  readonly methodId: string;
  readonly offset: number;
}
export function validateBookmarkEncoding(token: string): void {
  try {
    if (!token || token.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const base = token.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base);
    if (btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") !== token)
      throw new Error();
    const json = object(
      parseNativeJson(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(binary, (char) => char.charCodeAt(0)),
        ),
      ),
    );
    const version = json?.bookmarkVersion;
    if (
      !(version instanceof JsonNumber) ||
      !equalsInteger(version, Number(version.text)) ||
      Number(version.text) < 1
    )
      throw new Error();
  } catch {
    throw new TranscriptError("invalid-option-value", "Invalid bookmark encoding or envelope.");
  }
}
export function decodeBookmark(token: string, methodId: string): Bookmark {
  const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
  const value: unknown = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("bookmarkVersion" in value) ||
    value.bookmarkVersion !== 1 ||
    !("methodId" in value) ||
    value.methodId !== methodId ||
    !("conversationId" in value) ||
    typeof value.conversationId !== "string" ||
    !("digest" in value) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !("offset" in value) ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    !("entries" in value) ||
    typeof value.entries !== "number" ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 0
  )
    throw new TranscriptError("fresh-read-required", "Unrecognized or incompatible bookmark.");
  return value as Bookmark;
}
export function encodeBookmark(bookmark: Bookmark): string {
  const bytes = new TextEncoder().encode(JSON.stringify(bookmark));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
