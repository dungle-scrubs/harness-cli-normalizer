/**
 * Caller-directed skills allowlist rendering (issue #38). The delegating
 * agent picks the subset from its own registry; this module turns the
 * resolved paths into per-harness argv tokens.
 *
 * - pi: `-ns` (discovery off) + one `--skill <path>` per entry - the
 *   allowlist is exact: only the caller's picks load.
 * - claude: no per-skill load flag; the registry is already present via
 *   the personal skills dir, so the allowlist renders as the complement
 *   OFF - `--settings '{"skillOverrides":{"<name>":"off",...}}'` for every
 *   known skill except the picks. Known set comes from the caller's root
 *   listing (same source that resolved the names).
 * - codex: per-skill disable via config-kv array `-c
 *   skills.config=[{path="...", enabled=false}]` for every known skill
 *   except the picks (complement-off, same inversion as claude). Uses
 *   `path` selector rather than `name` because a skill's frontmatter
 *   `name` need not equal its directory basename, and `path` is exact.
 *   The path for skill <n> under root <root> is <root>/<n>/SKILL.md.
 *   No global `skills.enabled` switch exists. Requires the known set
 *   and the resolved picks (root derived from picks via dirname).
 * - muse: refuse (structural) with the standard hint shape.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { ArgvRefusalError } from "./refusal.js";

export const basenameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

const dirnameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

export const renderSkillsSelection = (
  h: HarnessDescriptor,
  skills: readonly string[],
): readonly string[] => {
  if (skills.length === 0) return [];

  if (h.skills === null) {
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: h.name,
      option: "skills",
      supported: ["caller-directed skill sets"],
      supportedBy: [
        { harness: "pi", spelling: "--skill" },
        { harness: "claude", spelling: "skillOverrides" },
        { harness: "codex", spelling: "-c skills.config" },
      ],
      hint: "muse scopes skills by workspace trust with no per-skill surface - include the skill content in the prompt or use --trust-workspace for the whole registry",
    });
  }

  if (h.skills.loadFlag !== null) {
    // pi: discovery off so ONLY the picks load.
    const tokens: string[] = ["-ns"];
    for (const path of skills) tokens.push(h.skills.loadFlag, path);
    return tokens;
  }

  // claude and codex: complement-off via CLI layer (settings JSON / config
  // array). The descriptor-level render returns [] and tokens append in
  // stream-turn / CLI.
  return [];
};

/** The claude complement form, given the full known registry: every known
 * name except the picks gets "off". Exported for the CLI layer, which owns
 * the registry listing (an fs read - never in interpretation). */
export const claudeSkillOverridesArg = (
  knownSkills: readonly string[],
  pickedPaths: readonly string[],
): string[] => {
  const picks = new Set(pickedPaths.map(basenameOf));
  const offs: Record<string, string> = {};
  for (const name of knownSkills) {
    if (!picks.has(name)) offs[name] = "off";
  }
  const json = JSON.stringify({ skillOverrides: offs });
  return ["--settings", json];
};

/** Codex complement form: every known skill except the picks gets
 * `{path="<root>/<name>/SKILL.md>", enabled=false}` via `-c
 * skills.config=[...]`. Uses `path` (exact) over `name` because
 * frontmatter name may diverge from directory basename. Root is derived
 * from the picks' dirname (all picks share the same root); if picks is
 * empty the complement cannot be rooted and we return [] (caller picks
 * nothing - no integration point needs this, and the CLI layer never
 * calls with empty picks). Empty complement returns [] (no flag). */
export const codexSkillConfigArg = (
  knownSkills: readonly string[],
  pickedPaths: readonly string[],
): string[] => {
  const picks = new Set(pickedPaths.map(basenameOf));
  // Derive root from first pick's dirname; all picks are under same root
  // (skills-root guarantees this). Fall back to "" if no picks.
  const root = pickedPaths.length > 0 ? dirnameOf(pickedPaths[0] as string) : "";
  const entries: string[] = [];
  for (const name of knownSkills) {
    if (!picks.has(name)) {
      const absPath = root ? `${root}/${name}/SKILL.md` : `${name}/SKILL.md`;
      entries.push(`{path=${JSON.stringify(absPath)}, enabled=false}`);
    }
  }
  if (entries.length === 0) return [];
  return ["-c", `skills.config=[${entries.join(", ")}]`];
};
