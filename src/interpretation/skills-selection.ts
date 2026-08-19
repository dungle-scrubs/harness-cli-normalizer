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
 * - codex/muse: refuse (structural) with the standard hint shape.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { ArgvRefusalError } from "./refusal.js";

export const basenameOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
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
      ],
      hint:
        h.name === "codex"
          ? "codex discovers skills from its own directory with no call-time surface - stage the skills into $CODEX_HOME/skills or pass their content in the prompt"
          : "muse scopes skills by workspace trust with no per-skill surface - include the skill content in the prompt or use --trust-workspace for the whole registry",
    });
  }

  if (h.skills.loadFlag !== null) {
    // pi: discovery off so ONLY the picks load.
    const tokens: string[] = ["-ns"];
    for (const path of skills) tokens.push(h.skills.loadFlag, path);
    return tokens;
  }

  // claude: complement-off via settings JSON. Names are the skill dir
  // basenames; unknown names in knownSkills would be turned off
  // pointlessly, so the caller passes exactly the known set.
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
