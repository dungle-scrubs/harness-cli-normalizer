/**
 * Override loading (D-006): code defaults plus a validated override file;
 * the override wins, and a malformed file - structurally OR semantically -
 * throws with the file path and offending harness in the message. A silent
 * fallback to defaults, or a garbage value flowing onward, would ship an
 * override bug invisibly. Pure over TEXT: the caller reads the file and
 * passes its content; nothing here touches the filesystem.
 *
 * Merge semantics: recursive to full depth for plain-object sections (a
 * partial nested override keeps its sibling keys); arrays replace
 * wholesale; every leaf is type-checked against the code default's shape,
 * closed string vocabularies are enforced, and any path whose default
 * carries a RegExp cannot be overridden from JSON.
 */
import { claudeCode } from "./claude-code.js";
import { codexCli } from "./codex.js";
import {
  HARNESS_NAMES,
  type HarnessDescriptor,
  type HarnessName,
  SESSION_INPUT_KINDS,
} from "./descriptor.js";
import { museCode } from "./muse.js";
import { piCli } from "./pi.js";

export type DescriptorSet = Partial<Record<HarnessName, HarnessDescriptor>>;

const SHARED_DESCRIPTORS: DescriptorSet = {
  claude: claudeCode,
  codex: codexCli,
  pi: piCli,
  muse: museCode,
};

export const defaultDescriptors = (): DescriptorSet => SHARED_DESCRIPTORS;

/** Tracks which descriptors were produced by an override file and what their
 * matcher counts are, so the execution layer can emit `matcherOverrides` on
 * the spawn boundary event without re-deriving it. */
export const matcherOverridesOf = new WeakMap<HarnessDescriptor, { limit: number; auth: number }>();

export class OverrideRefusalError extends Error {
  constructor(
    readonly path: string,
    detail: string,
    readonly harness?: string,
  ) {
    super(
      `invalid harness override file ${path}: ${harness === undefined ? "" : `harness ${JSON.stringify(harness)}: `}${detail}`,
    );
    this.name = "OverrideRefusalError";
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RegExp);

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const hasRegExpDeep = (value: unknown): boolean => {
  if (value instanceof RegExp) return true;
  if (Array.isArray(value)) return value.some(hasRegExpDeep);
  if (isPlain(value)) return Object.values(value).some(hasRegExpDeep);
  return false;
};

/** Closed string vocabularies by descriptor path - a typo like "Verbatim"
 * must refuse loudly, not collapse every store path into one directory. */
const enumAt = (keyPath: readonly string[]): readonly string[] | null => {
  if (keyPath[0] === "capabilities" && keyPath[1] === "streamingByMode") {
    return ["token", "message", "none"];
  }
  switch (keyPath.join(".")) {
    case "stdin":
      return ["inherit", "close-required"];
    case "store.cwdSlug":
      return ["dash-separators", "pi-dash-wrapped", "verbatim"];
    case "resume.style":
      return ["flag", "positional"];
    case "identity.authority":
      return ["caller-assigned", "harness-minted"];
    case "output.floor":
      return ["token", "message", "none"];
    case "launch.promptStyle":
      return ["positional"];
    case "sessionMode.input.kind":
      return SESSION_INPUT_KINDS;
    default:
      return null;
  }
};

const mergeValue = (
  base: unknown,
  override: unknown,
  keyPath: readonly string[],
  refuse: (detail: string) => never,
): unknown => {
  const at = keyPath.length === 0 ? "descriptor" : `section ${JSON.stringify(keyPath.join("."))}`;
  if (base instanceof RegExp) {
    refuse(`${at} carries a regular expression and cannot be overridden from JSON`);
  }
  if (base === null) {
    if (override === null) return null;
    refuse(`${at} defaults to null - there is no shape to validate an override against`);
  }
  if (isPlain(base)) {
    if (!isPlain(override)) refuse(`${at} must be an object`);
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (FORBIDDEN_KEYS.has(key)) refuse(`${at} key ${JSON.stringify(key)} is not allowed`);
      if (keyPath.length === 0 && key === "name") {
        refuse(`the "name" field is the registry key and cannot be overridden`);
      }
      if (!Object.hasOwn(base, key)) {
        refuse(`${at} has no field ${JSON.stringify(key)} to override`);
      }
      merged[key] = mergeValue(base[key], value, [...keyPath, key], refuse);
    }
    return merged;
  }
  if (Array.isArray(base)) {
    if (hasRegExpDeep(base)) {
      refuse(`${at} carries regular expressions and cannot be overridden from JSON`);
    }
    if (!Array.isArray(override)) refuse(`${at} must be an array`);
    const element = base[0];
    if (element === undefined) {
      // Every empty-default array in the descriptor is a string list.
      if (override.some((v) => typeof v !== "string")) {
        refuse(`${at} must be an array of strings`);
      }
      return override;
    }
    if (isPlain(element)) {
      // Object elements (output.pins) validate recursively against the
      // default element's shape - null or wrong-shaped entries must refuse
      // here, not crash a consumer later.
      return override.map((v, i) => mergeValue(element, v, [...keyPath, String(i)], refuse));
    }
    if (override.some((v) => typeof v !== typeof element || v === null)) {
      refuse(`${at} must be an array of ${typeof element}s`);
    }
    return override;
  }
  if (typeof override !== typeof base) {
    refuse(`${at} must be a ${typeof base}, got ${typeof override}`);
  }
  const allowed = enumAt(keyPath);
  if (allowed !== null && !allowed.includes(override as string)) {
    refuse(`${at} must be one of ${allowed.join(", ")}, got ${JSON.stringify(override)}`);
  }
  return override;
};

const validateMatcherPattern = (
  pattern: string,
  flags: string | undefined,
  path: string,
  harness: string,
): void => {
  const f = flags ?? "i";
  if (pattern.length > 200) {
    throw new OverrideRefusalError(
      path,
      `pattern over 200 characters: ${JSON.stringify(pattern.slice(0, 40))}`,
      harness,
    );
  }
  if (pattern.length === 0) {
    throw new OverrideRefusalError(path, `pattern must not be empty`, harness);
  }
  if (f.includes("g") || f.includes("y")) {
    throw new OverrideRefusalError(
      path,
      `flags must not contain g or y (got ${JSON.stringify(f)})`,
      harness,
    );
  }
  for (const ch of f) {
    if (!"imsu".includes(ch))
      throw new OverrideRefusalError(path, `flag ${JSON.stringify(ch)} outside imsu`, harness);
  }
  try {
    new RegExp(pattern, f);
  } catch (e) {
    throw new OverrideRefusalError(
      path,
      `uncompilable pattern ${JSON.stringify(pattern)}: ${(e as Error).message}`,
      harness,
    );
  }
};

const validateMatchers = (desc: HarnessDescriptor, path: string, harness: string): void => {
  const limitMatchers = (desc as unknown as { limitMatchers: readonly unknown[] }).limitMatchers;
  const authMatchers = (desc as unknown as { authMatchers: readonly unknown[] }).authMatchers;
  if (Array.isArray(limitMatchers)) {
    if (limitMatchers.length > 64) {
      throw new OverrideRefusalError(path, `more than 64 limit matchers`, harness);
    }
    for (const m of limitMatchers) {
      if (!isPlain(m as unknown as Record<string, unknown>)) {
        throw new OverrideRefusalError(path, `limit matcher must be an object`, harness);
      }
      const obj = m as Record<string, unknown>;
      if (typeof obj.pattern !== "string" || typeof obj.code !== "string") {
        throw new OverrideRefusalError(path, `limit matcher must have pattern and code`, harness);
      }
      validateMatcherPattern(obj.pattern, obj.flags as string | undefined, path, harness);
    }
  }
  if (Array.isArray(authMatchers)) {
    if (authMatchers.length > 64) {
      throw new OverrideRefusalError(path, `more than 64 auth matchers`, harness);
    }
    for (const m of authMatchers) {
      if (!isPlain(m as unknown as Record<string, unknown>)) {
        throw new OverrideRefusalError(path, `auth matcher must be an object`, harness);
      }
      const obj = m as Record<string, unknown>;
      if (typeof obj.pattern !== "string" || typeof obj.kind !== "string") {
        throw new OverrideRefusalError(path, `auth matcher must have pattern and kind`, harness);
      }
      validateMatcherPattern(obj.pattern, obj.flags as string | undefined, path, harness);
    }
  }
};

/** Parse an override document and merge it over the code defaults. */
export const parseOverrides = (jsonText: string, path: string): DescriptorSet => {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (cause) {
    throw new OverrideRefusalError(path, `not valid JSON (${(cause as Error).message})`);
  }
  if (!isPlain(doc)) {
    throw new OverrideRefusalError(path, "top level must be an object keyed by harness name");
  }

  const defaults = defaultDescriptors();
  const merged: DescriptorSet = { ...defaults };

  for (const [name, sections] of Object.entries(doc)) {
    const refuse = (detail: string): never => {
      throw new OverrideRefusalError(path, detail, name);
    };
    if (!HARNESS_NAMES.includes(name as HarnessName)) {
      refuse(`unknown harness; known: ${HARNESS_NAMES.join(", ")}`);
    }
    const base = defaults[name as HarnessName];
    if (base === undefined) {
      refuse("this harness has no code defaults to override yet");
    }
    const next = mergeValue(base, sections, [], refuse) as HarnessDescriptor;
    if (next.store.template.includes("..")) {
      refuse('store.template must not contain ".."');
    }
    // Validate matcher compilation at load time, not at first line
    validateMatchers(next, path, name);
    // Record matcher counts for the spawn boundary event when this descriptor was overridden
    const defaultsForHarness = defaults[name as HarnessName] as HarnessDescriptor;
    const limitChanged =
      (next.limitMatchers as unknown as ReadonlyArray<unknown>).length !==
        (defaultsForHarness.limitMatchers as unknown as ReadonlyArray<unknown>).length ||
      JSON.stringify(next.limitMatchers) !== JSON.stringify(defaultsForHarness.limitMatchers);
    const authChanged =
      (next.authMatchers as unknown as ReadonlyArray<unknown>).length !==
        (defaultsForHarness.authMatchers as unknown as ReadonlyArray<unknown>).length ||
      JSON.stringify(next.authMatchers) !== JSON.stringify(defaultsForHarness.authMatchers);
    if (limitChanged || authChanged) {
      matcherOverridesOf.set(next, {
        limit: (next.limitMatchers as unknown as ReadonlyArray<unknown>).length,
        auth: (next.authMatchers as unknown as ReadonlyArray<unknown>).length,
      });
    }
    merged[name as HarnessName] = next;
  }
  return merged;
};
