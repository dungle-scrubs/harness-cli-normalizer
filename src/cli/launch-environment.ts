/**
 * Launch environment fallback (issue #446): the user-config
 * `claudeConfigDir` setting selects a CLAUDE_CONFIG_DIR for Claude run and
 * session launches, fresh and resumed, so a login performed against that
 * directory reaches the spawned CLI from automated callers that strip the
 * variable.
 *
 * The setting is a FALLBACK, never an override: an inherited
 * CLAUDE_CONFIG_DIR - including one set to the empty string - keeps native
 * behavior, and a per-run `--env CLAUDE_CONFIG_DIR=...` entry outranks it,
 * including the empty-value delete. No variable is added when no setting
 * exists, and other harnesses are unchanged.
 *
 * Pure over its inputs (the CLI layer passes process.env); it reads no
 * files, checks no existence, and touches no credentials. The resolved
 * entries merge UNDER whatever per-call overrides the spawn already
 * carries, through the same mergeEnvironment delete-on-empty rule the
 * spawn adapter applies.
 */
import type { ProvenanceEntry } from "../interpretation/resolve-options.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export const CLAUDE_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

export interface LaunchEnvironment {
  /** Spawn-env entries the fallback contributes (empty when none apply). */
  readonly env: Readonly<Record<string, string>>;
  readonly provenance: readonly ProvenanceEntry[];
}

const NONE: LaunchEnvironment = { env: {}, provenance: [] };

/** Resolve the Claude launch fallback once, without mutating any input.
 * `userConfig` is the parsed user config tier (narrow shape so tests and
 * callers need not build a full ConfigTier); `inherited` is the process
 * environment the child would otherwise receive; `callEnv` is the
 * per-call `--env` override record, whose CLAUDE_CONFIG_DIR entry -
 * value or empty delete - always wins. */
export const resolveLaunchEnvironment = (
  h: HarnessDescriptor,
  userConfig: Readonly<{ readonly claudeConfigDir?: string }> | undefined,
  inherited: Readonly<Record<string, string | undefined>>,
  callEnv: Readonly<Record<string, string>> = {},
): LaunchEnvironment => {
  const setting = userConfig?.claudeConfigDir;
  if (setting === undefined) return NONE;
  if (h.name !== "claude") return NONE;
  // An inherited variable - including a set-but-empty one - is the caller's
  // own choice of configuration directory; the setting must not replace it.
  if (inherited[CLAUDE_CONFIG_DIR] !== undefined) return NONE;
  // A per-call entry (including the empty delete) has the highest
  // precedence; applying the fallback underneath it would resurrect what
  // the caller explicitly deleted.
  if (callEnv[CLAUDE_CONFIG_DIR] !== undefined) return NONE;
  return {
    env: { [CLAUDE_CONFIG_DIR]: setting },
    provenance: [{ key: "claudeConfigDir", value: setting, tier: "user-config" }],
  };
};
