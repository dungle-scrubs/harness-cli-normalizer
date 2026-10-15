import type {
  JsonObject,
  JsonSettingsFragment,
  JsonValue,
  OptionRender,
  Quoting,
} from "../knowledge/descriptor.js";
import { tokensFor } from "../knowledge/descriptor.js";

export interface ArgvParts {
  readonly tokens: readonly string[];
  readonly settings: readonly JsonSettingsFragment[];
}

export const renderArgvParts = (
  render: OptionRender,
  value?: string,
  quoting: Quoting = "toml",
): ArgvParts =>
  render.kind === "json-settings"
    ? { tokens: render.extraFlags ?? [], settings: [render] }
    : { tokens: tokensFor(render, value, quoting), settings: [] };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeObjects = (left: JsonObject, right: JsonObject): JsonObject => {
  const merged = new Map(Object.entries(left));
  for (const [key, value] of Object.entries(right)) {
    const previous = merged.get(key);
    merged.set(key, isObject(previous) && isObject(value) ? mergeObjects(previous, value) : value);
  }
  return Object.fromEntries(merged);
};

/** Only hcn-owned objects enter here. Native passthrough and settings files
 * retain the harness's own parsing and precedence. */
export const renderInlineSettings = (fragments: readonly JsonSettingsFragment[]): string[] => {
  const settings = new Map<string, JsonObject>();
  for (const { flag, value } of fragments) {
    settings.set(flag, mergeObjects(settings.get(flag) ?? {}, value));
  }
  return [...settings].flatMap(([flag, value]) =>
    tokensFor({ kind: "json-settings", flag, value }),
  );
};
