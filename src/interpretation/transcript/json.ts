import type { Issue, Requirement } from "../../knowledge/transcript/wire.js";
export class JsonNumber {
  constructor(readonly text: string) {}
}
export type Json = null | boolean | string | JsonNumber | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export class TranscriptError extends Error {
  cleanupFailed = false;
  constructor(
    readonly issue: Issue,
    message: string,
    readonly requirement: Requirement | null = null,
  ) {
    super(message);
    this.name = "TranscriptError";
  }
}
export function object(value: Json | undefined): JsonObject | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
    ? value
    : null;
}
export function string(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse numbers as decimal tokens and reject duplicate decoded member names. */
export function parseNativeJson(text: string): Json {
  let offset = 0;
  const bad = (): never => {
    throw new TranscriptError("source-malformed", "Invalid native JSON value.");
  };
  const whitespace = (): void => {
    while (/[\t\n\r ]/.test(text[offset] ?? "!")) offset++;
  };
  const quoted = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") {
        offset++;
        continue;
      }
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return bad();
        }
      }
    }
    return bad();
  };
  const value = (): Json => {
    whitespace();
    const char = text[offset];
    if (char === '"') return quoted();
    if (char === "{") {
      offset++;
      whitespace();
      const result: JsonObject = Object.create(null) as JsonObject;
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset++;
        return result;
      }
      while (offset < text.length) {
        whitespace();
        if (text[offset] !== '"') return bad();
        const key = quoted();
        if (keys.has(key)) return bad();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") return bad();
        result[key] = value();
        whitespace();
        const end = text[offset++];
        if (end === "}") return result;
        if (end !== ",") return bad();
      }
      return bad();
    }
    if (char === "[") {
      offset++;
      whitespace();
      const result: Json[] = [];
      if (text[offset] === "]") {
        offset++;
        return result;
      }
      while (offset < text.length) {
        result.push(value());
        whitespace();
        const end = text[offset++];
        if (end === "]") return result;
        if (end !== ",") return bad();
      }
      return bad();
    }
    for (const [word, item] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, offset)) {
        offset += word.length;
        return item;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (number) {
      offset += number[0].length;
      return new JsonNumber(number[0]);
    }
    return bad();
  };
  const result = value();
  whitespace();
  if (offset !== text.length) return bad();
  return result;
}

export function encodeJson(value: unknown): string {
  if (value instanceof JsonNumber) return value.text;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${encodeJson(item)}`)
      .join(",")}}`;
  }
  throw new TranscriptError("output-failed", "Protocol value cannot be encoded.");
}

/** Compare metadata integers without rounding a native decimal into another format/version. */
export function equalsInteger(value: Json | undefined, expected: number): boolean {
  if (!(value instanceof JsonNumber) || !Number.isSafeInteger(expected)) return false;
  const canonical = (text: string): string => {
    const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
    const negative = mantissa.startsWith("-");
    const unsigned = negative ? mantissa.slice(1) : mantissa;
    const point = unsigned.indexOf(".");
    const decimals = point < 0 ? 0 : unsigned.length - point - 1;
    const digits = unsigned.replace(".", "").replace(/^0+/, "");
    if (!digits) return "0";
    const significant = digits.replace(/0+$/, "");
    const scale = BigInt(exponent) - BigInt(decimals) + BigInt(digits.length - significant.length);
    return `${negative ? "-" : ""}${significant}e${scale}`;
  };
  return canonical(value.text) === canonical(String(expected));
}
