/**
 * Skills registry resolution (issue #38): --skills names resolve against
 * the caller's deployed root. The delegating agent's judgment picked the
 * names; this only maps them to paths and refuses unknowns loudly -
 * a typo silently loading nothing is the failure this prevents.
 *
 * Root: $HCN_SKILLS_ROOT, else ~/.agents/skills (the deployed shared
 * registry; ~/.claude/skills symlinks to it, so claude's complement
 * narrowing and pi's loads see the same set).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessName } from "../knowledge/descriptor.js";

export const skillsRoot = (): string =>
  process.env.HCN_SKILLS_ROOT ?? join(homedir(), ".agents", "skills");

const skillDir = (root: string, name: string): string => join(root, name);

export const listKnownSkills = (): string[] => {
  const root = skillsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => {
    try {
      return statSync(skillDir(root, n)).isDirectory();
    } catch {
      return false;
    }
  });
};

export const resolveSkillNames = (
  names: readonly string[],
  harness: HarnessName = "claude",
): string[] => {
  const root = skillsRoot();
  const known = new Set(listKnownSkills());
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness,
      option: "skills",
      supported:
        known.size > 0
          ? [`registry at ${root}`, [...known].join(", ")]
          : [`registry at ${root} (empty)`],
      detail: `unknown skill name(s): ${unknown.join(", ")}`,
    });
  }
  return names.map((n) => skillDir(root, n));
};
