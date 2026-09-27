import { piCli } from "../knowledge/pi.js";
import { isNativeFolder } from "./native-path.js";
import { asRecord } from "./shape.js";
import { CLEAN_SELECTOR } from "./vocabulary.js";

/**
 * One Pi session line reduced to what settings restoration reads. Message
 * content is dropped here, line by line, so conversation text never reaches
 * the settings snapshot or stays in memory.
 */
export type PiSettingsLine =
  | {
      readonly kind: "header";
      readonly cwd: string;
      readonly sessionId: string;
      readonly version: number;
    }
  | {
      readonly kind: "entry";
      readonly id: string | null;
      readonly parentId: string | null;
      readonly model?: { readonly provider: string; readonly model: string };
      readonly effort?: string;
    };

const selector = (value: unknown): value is string =>
  typeof value === "string" && CLEAN_SELECTOR.test(value);
const entryId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

/** Null is a line hcn cannot trust; the whole read is then unavailable. */
export function parsePiSettingsLine(value: unknown): PiSettingsLine | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;
  if (record.type === "session") {
    if (!entryId(record.id) || !isNativeFolder(record.cwd)) return null;
    const version = record.version === undefined ? 1 : record.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
    return { kind: "header", cwd: record.cwd, sessionId: record.id, version };
  }
  const id = record.id === undefined ? null : record.id;
  const parentId = record.parentId === undefined ? null : record.parentId;
  if ((id !== null && !entryId(id)) || (parentId !== null && !entryId(parentId))) return null;
  const base = { kind: "entry" as const, id, parentId };
  if (record.type === "model_change") {
    if (!selector(record.provider) || !selector(record.modelId)) return null;
    return { ...base, model: { provider: record.provider, model: record.modelId } };
  }
  if (record.type === "thinking_level_change") {
    if (typeof record.thinkingLevel !== "string") return null;
    return { ...base, effort: record.thinkingLevel };
  }
  if (record.type === "message") {
    const message = asRecord(record.message);
    if (message?.role === "assistant") {
      if (!selector(message.provider) || !selector(message.model)) return null;
      return { ...base, model: { provider: message.provider, model: message.model } };
    }
  }
  return base;
}

export interface PiSessionSettings {
  readonly cwd: string;
  readonly effort: string;
  /** The entries that set the values, for the fingerprint. */
  readonly effortEntry: string | null;
  readonly model: string;
  readonly modelEntry: string;
  readonly provider: string;
  readonly sessionId: string;
}

/**
 * Pi's own restoration rule (Pi 0.87.1, `dist/core/session-manager.js`).
 * `_buildIndex` makes the last non-header entry the leaf; `buildSessionPath`
 * walks `parentId` links from it and stops at a missing parent;
 * `getSessionContextSettings` lets each `model_change` and assistant message
 * replace the model, and each `thinking_level_change` replace the thinking
 * level, which starts at `off`. A version 1 file has no ids: Pi's migration
 * chains its entries in file order.
 */
export function piSessionSettings(
  lines: readonly PiSettingsLine[],
): PiSessionSettings | "session-unavailable" | "settings-unavailable" {
  const header = lines[0];
  if (header?.kind !== "header") return "session-unavailable";
  if (lines.slice(1).some((line) => line.kind === "header")) return "session-unavailable";
  const entries = lines.slice(1) as readonly Extract<PiSettingsLine, { kind: "entry" }>[];
  let path: readonly Extract<PiSettingsLine, { kind: "entry" }>[];
  if (header.version < 2) {
    path = entries;
  } else {
    const byId = new Map<string, Extract<PiSettingsLine, { kind: "entry" }>>();
    for (const entry of entries) {
      if (entry.id === null) return "settings-unavailable";
      byId.set(entry.id, entry);
    }
    const walked: Extract<PiSettingsLine, { kind: "entry" }>[] = [];
    const seen = new Set<string>();
    let current = entries.at(-1);
    while (current) {
      if (current.id === null || seen.has(current.id)) return "settings-unavailable";
      seen.add(current.id);
      walked.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    path = walked.reverse();
  }
  let model: { readonly provider: string; readonly model: string; readonly entry: string } | null =
    null;
  let effort = "off";
  let effortEntry: string | null = null;
  path.forEach((entry, index) => {
    const id = entry.id ?? `line-${index + 1}`;
    if (entry.model) model = { ...entry.model, entry: id };
    if (entry.effort !== undefined) {
      effort = entry.effort;
      effortEntry = id;
    }
  });
  const selected = model as { provider: string; model: string; entry: string } | null;
  if (!selected || !piCli.vocabulary.efforts.includes(effort)) return "settings-unavailable";
  return {
    cwd: header.cwd,
    effort,
    effortEntry,
    model: selected.model,
    modelEntry: selected.entry,
    provider: selected.provider,
    sessionId: header.sessionId,
  };
}
