/**
 * Caller-directed skills allowlist rendering (issue #38), descriptor-driven
 * (RFC-02 change 2). The delegating agent picks the subset from its own
 * registry; the CLI supplies the resolved picks and the registry's known
 * names; this module turns them into per-harness argv tokens by reading
 * the descriptor's `skills` field:
 *
 * - a load flag (pi): the discovery.skills facet off, then one load per
 *   pick - the allowlist is exact, only the caller's picks load.
 * - overrides via settings (claude): no per-skill load flag; the registry
 *   is already present, so the allowlist renders as the complement OFF -
 *   `--settings '{"skillOverrides":{"<name>":"off",...}}'` for every known
 *   skill except the picks.
 * - overrides via a config array (codex): the complement OFF plus the
 *   picks restated ON through `-c skills.config=[...]`. Each skill gets
 *   TWO entries, one per selector shape codex resolves, because each
 *   covers a hazard the other misses (issue #209, verified against codex
 *   0.155.1 and 0.157.1 with `codex debug prompt-input`):
 *   path - `path="<root>/<n>/SKILL.md"`, the root taken from the picks
 *   (all share one); works even when a skill's frontmatter `name`
 *   differs from its registry basename, but matches only that exact
 *   file, so a second copy of the skill at another path stays enabled
 *   (observed with the synced `<uuid>/<name>` layout of the shared
 *   registry).
 *   name - `name="<n>"`; matches every discovered copy of the name, but
 *   no-ops when the frontmatter name differs from hcn's basename.
 *   The picks are rendered `enabled=true` alongside the disabled
 *   complement: `skills.config` is a disable-set (unlisted skills stay
 *   enabled), but user-level `config.toml` `[[skills.config]]` disables
 *   sit in a lower-precedence layer than the per-call overrides, and
 *   layers replace entries per selector - restating the pick under both
 *   selectors shields it from a user disable of either shape and keeps
 *   at least one enabled entry for every non-empty selection.
 * - null (muse): refuse, with the support list derived like every other
 *   refusal's.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { tokensFor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { hintFor } from "./hints.js";
import { ArgvRefusalError } from "./refusal.js";
import { supportedBy } from "./support.js";

/** The skills turn option: the caller's resolved picks (absolute paths)
 * and every skill name in the registry they came from. */
export interface SkillsSelection {
  readonly picks: readonly string[];
  readonly known: readonly string[];
}

export const basenameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};

const dirnameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/** The known names that are not picks, in registry order. */
const complementOf = (skills: SkillsSelection): readonly string[] => {
  const picks = new Set(skills.picks.map(basenameOf));
  return skills.known.filter((name) => !picks.has(name));
};

const settingsOverrides = (skills: SkillsSelection): readonly string[] => {
  const offs: Record<string, string> = {};
  for (const name of complementOf(skills)) offs[name] = "off";
  return ["--settings", JSON.stringify({ skillOverrides: offs })];
};

const configSkillsArray = (skills: SkillsSelection): readonly string[] => {
  const root = skills.picks.length > 0 ? dirnameOf(skills.picks[0] as string) : "";
  const pathOf = (name: string): string => (root ? `${root}/${name}/SKILL.md` : `${name}/SKILL.md`);
  const entry = (name: string, enabled: boolean): string =>
    `{path=${JSON.stringify(pathOf(name))}, enabled=${enabled}}, {name=${JSON.stringify(name)}, enabled=${enabled}}`;
  const picks = [...new Set(skills.picks.map(basenameOf))];
  const entries = [
    ...picks.map((name) => entry(name, true)),
    ...complementOf(skills).map((name) => entry(name, false)),
  ];
  return entries.length === 0 ? [] : ["-c", `skills.config=[${entries.join(", ")}]`];
};

export const renderSkillsSelection = (
  h: HarnessDescriptor,
  skills: SkillsSelection,
): readonly string[] => {
  if (skills.picks.length === 0) return [];

  if (h.skills === null) {
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: h.name,
      option: "skills",
      supported: ["caller-directed skill sets"],
      supportedBy: supportedBy(defaultDescriptors(), "skills"),
      // Popeye's --skills takes plugin names, not registry paths; other
      // null-skills harnesses (muse) name their stay-on-harness surface.
      hint:
        h.name === "popeye"
          ? hintFor(h.name, "skills")
          : "muse scopes skills by workspace trust with no per-skill surface - include the skill content in the prompt or use --trust-workspace for the whole registry",
    });
  }

  if (h.skills.loadFlag !== null) {
    // Discovery off so ONLY the picks load; the off spelling is the
    // descriptor's own discovery.skills facet render.
    const facet =
      h.turnOptions.discovery?.kind === "discovery"
        ? h.turnOptions.discovery.facets.skills
        : undefined;
    const tokens: string[] = facet === undefined ? [] : [...tokensFor(facet.render)];
    for (const path of skills.picks) tokens.push(h.skills.loadFlag, path);
    return tokens;
  }

  switch (h.skills.overridesVia) {
    case "settings-skilloverrides":
      return settingsOverrides(skills);
    case "config-skills-array":
      return configSkillsArray(skills);
    case null:
      return [];
    default: {
      const exhaustive: never = h.skills.overridesVia;
      return exhaustive;
    }
  }
};
