/**
 * User-level config: ~/.config/hcn/config.json (or $HCN_CONFIG_DIR for
 * tests). Hard-fail discipline: unknown keys, malformed JSON, and schema
 * version mismatches exit 2 naming the offender - a config that silently
 * no-ops is a safety hole in a tool whose config can tighten a sandbox.
 *
 * Schema is intentionally minimal and mirrors the normalized option
 * surface; it grows as dimensions ratify. The parser validates SHAPE
 * (key known, value type plausible); value legality (effort in ladder,
 * model in vocabulary) is enforced by the same renderers as args, so
 * config and CLI can never disagree about what is legal.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TurnOptions } from "../interpretation/argv.js";

const SCHEMA_VERSION = 1;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const userConfigPath = (): string =>
  join(process.env.HCN_CONFIG_DIR ?? join(homedir(), ".config", "hcn"), "config.json");

type MutableTurnOptions = {
  [K in keyof TurnOptions]?: TurnOptions[K];
};

const KNOWN_KEYS = new Set([
  "effort",
  "model",
  "provider",
  "sandbox",
  "tools",
  "excludeTools",
  "autonomy",
  "write",
  "shell",
  "maxSteps",
]);

const LIST_KEYS = new Set(["tools", "excludeTools"]);
const BOOL_KEYS = new Set(["autonomy", "write", "shell"]);

/** Parse + validate config text. Throws ConfigError with the offending key
 * named on any violation - never warns and continues. */
export const parseUserConfig = (text: string): Partial<TurnOptions> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config root must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version === undefined) {
    throw new ConfigError("config missing required field: version");
  }
  if (obj.version !== SCHEMA_VERSION) {
    throw new ConfigError(
      `config version ${JSON.stringify(obj.version)} not supported (expected ${SCHEMA_VERSION})`,
    );
  }
  delete obj.version;

  const out: MutableTurnOptions = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(`unknown config key: ${JSON.stringify(key)}`);
    }
    if (LIST_KEYS.has(key)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new ConfigError(`config key ${JSON.stringify(key)} must be an array of strings`);
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (BOOL_KEYS.has(key)) {
      if (typeof value !== "boolean") {
        throw new ConfigError(`config key ${JSON.stringify(key)} must be a boolean`);
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new ConfigError(
        `config key ${JSON.stringify(key)} must be a string or number, got ${typeof value}`,
      );
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out as Partial<TurnOptions>;
};

/** Load the user config if the file exists; absent file is an empty config
 * (no tiers engaged), unreadable or invalid file is a hard error. */
export const loadUserConfig = (): { config: Partial<TurnOptions>; path: string } | null => {
  const path = userConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new ConfigError(`cannot read config at ${path}: ${(e as Error).message}`);
  }
  return { config: parseUserConfig(text), path };
};
