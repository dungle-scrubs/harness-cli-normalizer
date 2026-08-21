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
 *
 * toolMap: { pi: { "web-search": "web_search" } } - extensible canonical
 * vocabulary per harness; unknown harness, harness with no allowlist
 * (codex, muse), non-string/empty values, or invalid selector canonical
 * keys hard-fail naming the key path. hcn cannot verify native names exist
 * at run time; a wrong name reaches the harness as an unknown tool.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TurnOptions } from "../interpretation/argv.js";

const SCHEMA_VERSION = 1;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const userConfigPath = (): string =>
  join(
    process.env.HCN_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hcn"),
    "config.json",
  );

/** Project config: `.hcn/config.json` at the git root (P4 ratified as A -
 * auto-discover, no trust gate; the config is code-reviewed like AGENTS.md
 * and every project-tier provenance line names its path). Null outside a
 * repo or when the repo declares none. */
export const projectConfigPath = (startDir: string = process.cwd()): string | null => {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".hcn", "config.json"))) return join(dir, ".hcn", "config.json");
    const parent = dirname(dir);
    if (parent === dir) return null;
    // stop at the git root: above it is not this project
    if (existsSync(join(dir, ".git")) && !existsSync(join(parent, ".git"))) {
      return null;
    }
    dir = parent;
  }
};

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
  "toolsets",
  "timeout",
  // issue #41: question escalation (behavior instruction, not a turn
  // option - it rides the prompt preamble, never a harness flag).
  "escalateQuestions",
  // issue #48: payload-stripping dimensions (opt-in-only, no profile
  // entry by ratification).
  "systemPrompt",
  "appendSystemPrompt",
  "toolMap",
  "access",
]);

const LIST_KEYS = new Set(["tools", "excludeTools"]);
const BOOL_KEYS = new Set(["autonomy", "write", "shell", "escalateQuestions"]);

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
    if (key === "toolMap") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(
          'config key "toolMap" must be an object of harness -> canonical -> native',
        );
      }
      const toolMapObj = value as Record<string, unknown>;
      const SEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
      const harnessNames = ["claude", "codex", "pi", "muse"] as const;
      const noAllowlistHarnesses = new Set(["codex", "muse"]);
      for (const [harness, inner] of Object.entries(toolMapObj)) {
        if (!(harnessNames as readonly string[]).includes(harness)) {
          throw new ConfigError(`unknown config key: ${JSON.stringify(`toolMap.${harness}`)}`);
        }
        if (noAllowlistHarnesses.has(harness)) {
          throw new ConfigError(`unknown config key: ${JSON.stringify(`toolMap.${harness}`)}`);
        }
        if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
          throw new ConfigError(
            `config key ${JSON.stringify(`toolMap.${harness}`)} must be an object of canonical -> native string`,
          );
        }
        const innerObj = inner as Record<string, unknown>;
        for (const [canonical, nativeVal] of Object.entries(innerObj)) {
          if (!SEL.test(canonical)) {
            throw new ConfigError(
              `config key ${JSON.stringify(`toolMap.${harness}.${canonical}`)} must match ${SEL.source}`,
            );
          }
          if (typeof nativeVal !== "string") {
            throw new ConfigError(
              `config key ${JSON.stringify(`toolMap.${harness}.${canonical}`)} must be a non-empty string, got ${typeof nativeVal}`,
            );
          }
          if (nativeVal.trim() === "") {
            throw new ConfigError(
              `config key ${JSON.stringify(`toolMap.${harness}.${canonical}`)} must be a non-empty string`,
            );
          }
        }
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (key === "toolsets") {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([, v]) => !Array.isArray(v) || v.some((t) => typeof t !== "string" || t.trim() === ""),
        )
      ) {
        throw new ConfigError(
          'config key "toolsets" must be an object of name -> non-empty string array',
        );
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (key === "timeout") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ConfigError(
          'config key "timeout" must be a whole number of seconds, >= 0 (0 disables)',
        );
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    if (key === "access") {
      if (value !== "read" && value !== "write") {
        throw new ConfigError('config key "access" must be "read" or "write"');
      }
      (out as Record<string, unknown>)[key] = value;
      continue;
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
export const loadUserConfig = (): { config: Partial<TurnOptions>; path: string } | null =>
  loadConfigAt(userConfigPath());

/** Load the project config (git-root auto-discovery, ratified A). */
export const loadProjectConfig = (
  startDir?: string,
): { config: Partial<TurnOptions>; path: string } | null => {
  const path = projectConfigPath(startDir);
  if (path === null) return null;
  return loadConfigAt(path);
};

const loadConfigAt = (path: string): { config: Partial<TurnOptions>; path: string } | null => {
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
