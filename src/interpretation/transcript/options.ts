import type { HarnessName } from "../../knowledge/descriptor.js";
import { HARNESS_NAMES } from "../../knowledge/descriptor.js";
import type { Guarantee } from "../../knowledge/transcript/schema.js";
import { GUARANTEES } from "../../knowledge/transcript/schema.js";
import { validateBookmarkEncoding } from "./bookmark.js";
import { TranscriptError } from "./json.js";

export interface TranscriptOptions {
  readonly acceptedLimits: readonly Guarantee[];
  readonly cwd: string | null;
  readonly file: string | null;
  readonly harness: HarnessName;
  readonly id: string | null;
  readonly limit: number | null;
  readonly since: string | null;
}
export function transcriptHarness(value: string | undefined): HarnessName | null {
  return HARNESS_NAMES.find((name) => name === value) ?? null;
}
export function parseTranscriptOptions(raw: readonly string[]): TranscriptOptions {
  const harness = transcriptHarness(raw[1]);
  if (raw[0] !== "read" || !harness)
    throw new TranscriptError(
      "invalid-option-value",
      "Expected transcript read and a supported harness.",
    );
  const values = new Map<string, string>();
  for (let index = 2; index < raw.length; index++) {
    const token = raw[index];
    if (token === undefined) break;
    const equal = token.indexOf("=");
    const key = equal < 0 ? token : token.slice(0, equal);
    const value = equal < 0 ? raw[++index] : token.slice(equal + 1);
    if (
      !["--file", "--id", "--cwd", "--accept-limits", "--limit", "--since"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0") ||
      values.has(key)
    )
      throw new TranscriptError("invalid-option-value", "Invalid or repeated transcript option.");
    values.set(key, value);
  }
  if (values.has("--file") && values.has("--id"))
    throw new TranscriptError("mutually-exclusive-options", "Choose either --id or --file.");
  if (!values.has("--file") && !values.has("--id"))
    throw new TranscriptError("invalid-option-value", "A native --id or --file is required.");
  const accepted = values.get("--accept-limits")?.split(",") ?? [];
  if (accepted.some((name) => !GUARANTEES.some((guarantee) => guarantee === name)))
    throw new TranscriptError(
      "invalid-option-value",
      "Unknown retrieval guarantee in --accept-limits.",
    );
  const limit = values.get("--limit");
  if (
    limit !== undefined &&
    (!/^[0-9]+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1)
  )
    throw new TranscriptError("invalid-option-value", "Invalid positive entry limit.");
  const since = values.get("--since") ?? null;
  if (since) validateBookmarkEncoding(since);
  return {
    limit: limit === undefined ? null : Number(limit),
    since,
    acceptedLimits: GUARANTEES.filter((name) => accepted.includes(name)),
    cwd: values.get("--cwd") ?? null,
    file: values.get("--file") ?? null,
    harness,
    id: values.get("--id") ?? null,
  };
}
