/**
 * Override loading (D-006): code defaults plus a validated override file;
 * the override wins per section, and a malformed file throws with the path
 * and offending harness in the message - a silent fallback to defaults
 * would ship an override bug invisibly. Pure over TEXT: the caller reads
 * the file and passes its content; nothing here touches the filesystem.
 */
import { claudeCode } from "./claude-code.js";
import type { HarnessDescriptor, HarnessName } from "./descriptor.js";

export type DescriptorSet = Partial<Record<HarnessName, HarnessDescriptor>>;

export const defaultDescriptors = (): DescriptorSet => ({
  claude: claudeCode,
});

export class OverrideRefusalError extends Error {
  constructor(path: string, detail: string) {
    super(`invalid harness override file ${path}: ${detail}`);
    this.name = "OverrideRefusalError";
  }
}

const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "pi", "muse"];

/**
 * Parse an override document and merge it over the code defaults. The
 * merge is per top-level descriptor section (one level deep): an override
 * section replaces the default section wholesale, untouched sections keep
 * their defaults. RegExp-bearing sections (limitMatchers, authMatchers,
 * resume.idShape) cannot be expressed in JSON and are refused.
 */
export const parseOverrides = (jsonText: string, path: string): DescriptorSet => {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (cause) {
    throw new OverrideRefusalError(path, `not valid JSON (${(cause as Error).message})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new OverrideRefusalError(path, "top level must be an object keyed by harness name");
  }

  const defaults = defaultDescriptors();
  const merged: DescriptorSet = { ...defaults };

  for (const [name, sections] of Object.entries(doc)) {
    if (!HARNESS_NAMES.includes(name as HarnessName)) {
      throw new OverrideRefusalError(
        path,
        `unknown harness ${JSON.stringify(name)}; known: ${HARNESS_NAMES.join(", ")}`,
      );
    }
    const base = defaults[name as HarnessName];
    if (base === undefined) {
      throw new OverrideRefusalError(
        path,
        `harness ${JSON.stringify(name)} has no code defaults to override yet`,
      );
    }
    if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
      throw new OverrideRefusalError(
        path,
        `harness ${JSON.stringify(name)}: override must be an object of descriptor sections`,
      );
    }
    const next: Record<string, unknown> = { ...base };
    for (const [section, value] of Object.entries(sections)) {
      if (!(section in base)) {
        throw new OverrideRefusalError(
          path,
          `harness ${JSON.stringify(name)}: unknown descriptor section ${JSON.stringify(section)}`,
        );
      }
      if (section === "limitMatchers" || section === "authMatchers" || section === "resume") {
        throw new OverrideRefusalError(
          path,
          `harness ${JSON.stringify(name)}: section ${JSON.stringify(section)} carries regular expressions and cannot be overridden from JSON`,
        );
      }
      const baseSection = (base as unknown as Record<string, unknown>)[section];
      next[section] =
        typeof baseSection === "object" &&
        baseSection !== null &&
        !Array.isArray(baseSection) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
          ? { ...baseSection, ...value }
          : value;
    }
    merged[name as HarnessName] = next as unknown as HarnessDescriptor;
  }
  return merged;
};
