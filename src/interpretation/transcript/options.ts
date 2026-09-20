import type { HarnessName } from "../../knowledge/descriptor.js";
import { HARNESS_NAMES } from "../../knowledge/descriptor.js";
import type { Guarantee } from "../../knowledge/transcript/schema.js";
import { GUARANTEES } from "../../knowledge/transcript/schema.js";
import { validateBookmarkEncoding } from "./bookmark.js";
import { TranscriptError } from "./json.js";
import { utcTime } from "./time.js";

export interface TranscriptOptions {
  readonly acceptedLimits: readonly Guarantee[];
  readonly cwd: string | null;
  readonly file: string | null;
  readonly harness: HarnessName;
  readonly id: string | null;
  readonly limit: number | null;
  readonly since: string | null;
}
export interface TranscriptListOptions {
  readonly allWorkspaces: boolean;
  readonly cwd: string | null;
  /** The harnesses to list; empty means every harness with a listing method. */
  readonly harnesses: readonly HarnessName[];
  readonly headless: boolean;
  readonly limit: number | null;
  /** Admit only sources written at or after this UTC instant, or null for all
   * of them. Normalized to `YYYY-MM-DDTHH:MM:SS.mmmZ` so it compares against
   * a row's `lastWriteAt` directly. */
  readonly sinceTime: string | null;
}
export function transcriptHarness(value: string | undefined): HarnessName | null {
  return HARNESS_NAMES.find((name) => name === value) ?? null;
}
const LIST_VALUES = ["--cwd", "--harness", "--limit", "--since-time"];
const LIST_FLAGS = ["--all-workspaces", "--headless"];
export function parseTranscriptListOptions(raw: readonly string[]): TranscriptListOptions {
  const invalid = (): never => {
    throw new TranscriptError("invalid-option-value", "Invalid or repeated transcript option.");
  };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (token === undefined) break;
    if (LIST_FLAGS.includes(token)) {
      if (flags.has(token)) invalid();
      flags.add(token);
      continue;
    }
    const equal = token.indexOf("=");
    const key = equal < 0 ? token : token.slice(0, equal);
    const value = equal < 0 ? raw[++index] : token.slice(equal + 1);
    if (
      !LIST_VALUES.includes(key) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0") ||
      values.has(key)
    )
      invalid();
    values.set(key, value as string);
  }
  if (values.has("--cwd") && flags.has("--all-workspaces"))
    throw new TranscriptError(
      "mutually-exclusive-options",
      "Choose either --cwd or --all-workspaces.",
    );
  const limit = values.get("--limit");
  if (
    limit !== undefined &&
    (!/^[0-9]+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1)
  )
    throw new TranscriptError("invalid-option-value", "Invalid positive row limit.");
  const rawSince = values.get("--since-time");
  const sinceTime = rawSince === undefined ? null : utcTime(rawSince);
  if (rawSince !== undefined && sinceTime === null)
    throw new TranscriptError(
      "invalid-option-value",
      "--since-time takes a UTC instant, as YYYY-MM-DDTHH:MM:SS[.mmm]Z.",
    );
  const names = values.get("--harness")?.split(",") ?? [];
  if (names.some((name) => transcriptHarness(name) === null))
    throw new TranscriptError("invalid-option-value", "Unknown harness in --harness.");
  return {
    allWorkspaces: flags.has("--all-workspaces"),
    cwd: values.get("--cwd") ?? null,
    harnesses: HARNESS_NAMES.filter((name) => names.includes(name)),
    headless: flags.has("--headless"),
    limit: limit === undefined ? null : Number(limit),
    sinceTime,
  };
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
