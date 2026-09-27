import { codexNativeProviderRender } from "../knowledge/codex.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { resolveRender, tokensFor, UUID_SHAPE } from "../knowledge/descriptor.js";
import {
  NATIVE_SETTINGS_FINGERPRINT_SHAPE,
  NATIVE_SETTINGS_SOURCES,
} from "../knowledge/native-settings.js";
import type { SpawnArgvOptions, TurnOptions } from "./argv.js";
import { isNativeFolder } from "./native-path.js";
import { ArgvRefusalError } from "./refusal.js";
import { CLEAN_SELECTOR, validateEffort } from "./vocabulary.js";

export const hasCompetingNativeSettingsOptions = (
  opts: Pick<SpawnArgvOptions, "model" | "effort" | "provider" | "passthrough">,
): boolean =>
  opts.model !== undefined ||
  opts.effort !== undefined ||
  opts.provider !== undefined ||
  (opts.passthrough !== undefined && opts.passthrough.length > 0);

/** RFC 35: what may ride beside a Pi settings fingerprint. Pi restores its
 * own settings on a flagless resume, so every option that could change the
 * run refuses; an explicit extension file and hcn-owned behaviour pass.
 * Exhaustive over TurnOptions, so a new option must be classified here. */
const BESIDE_PI_FINGERPRINT = {
  prompt: true,
  questions: true,
  toolMap: true,
  extensions: true,
  isolation: false,
  tools: false,
  excludeTools: false,
  skills: false,
  model: false,
  autonomy: false,
  effort: false,
  sandbox: false,
  contextWindow: false,
  provider: false,
  agent: false,
  discovery: false,
  write: false,
  shell: false,
  memory: false,
  maxSteps: false,
  systemPrompt: false,
  appendSystemPrompt: false,
  access: false,
} as const satisfies Record<keyof TurnOptions, boolean>;

export const hasOptionsBesidePiFingerprint = (
  opts: Partial<TurnOptions> & Pick<SpawnArgvOptions, "passthrough">,
): boolean =>
  (opts.passthrough !== undefined && opts.passthrough.length > 0) ||
  Object.entries(BESIDE_PI_FINGERPRINT).some(
    ([key, allowed]) => !allowed && (opts as unknown as Record<string, unknown>)[key] !== undefined,
  );

/** A Pi settings fingerprint puts the prompt after Pi's `--`. */
export const promptAfterSeparator = (opts: Pick<SpawnArgvOptions, "verifiedNativeSettings">) =>
  opts.verifiedNativeSettings?.source === "pi-session-v1";

/** A verified source bypasses only the curated model catalog, never selector validation. */
export function renderVerifiedNativeSettings(
  h: HarnessDescriptor,
  opts: SpawnArgvOptions,
): string[] {
  const saved = opts.verifiedNativeSettings;
  if (!saved) return [];
  if (saved.source === "pi-session-v1") {
    // Flagless resume: Pi restores the settings the snapshot read (RFC 35).
    if (
      NATIVE_SETTINGS_SOURCES[h.name] !== saved.source ||
      saved.harness !== h.name ||
      saved.status !== "available" ||
      saved.v !== 1 ||
      !UUID_SHAPE.test(saved.sessionId) ||
      opts.resume !== saved.sessionId ||
      !isNativeFolder(saved.cwd) ||
      !NATIVE_SETTINGS_FINGERPRINT_SHAPE.test(saved.fingerprint) ||
      hasOptionsBesidePiFingerprint(opts)
    )
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: h.name,
        detail:
          "Pi native settings require an exact resume with no settings options or passthrough",
        supported: ["freshly verified native settings for this exact saved session"],
      });
    return [];
  }
  const effort = h.turnOptions.effort;
  const effortRender = effort?.kind === "effort" ? resolveRender(effort, "resume") : null;
  if (
    h.name !== "codex" ||
    saved.harness !== h.name ||
    saved.source !== "codex-rollout-v1" ||
    saved.status !== "available" ||
    saved.v !== 1 ||
    !UUID_SHAPE.test(saved.sessionId) ||
    opts.resume !== saved.sessionId ||
    !isNativeFolder(saved.cwd) ||
    !NATIVE_SETTINGS_FINGERPRINT_SHAPE.test(saved.fingerprint) ||
    !CLEAN_SELECTOR.test(saved.model) ||
    !CLEAN_SELECTOR.test(saved.provider) ||
    !validateEffort(h, saved.effort).ok ||
    !effortRender ||
    hasCompetingNativeSettingsOptions(opts)
  ) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      detail:
        "native settings require exact Codex resume with no competing selectors or passthrough",
      supported: ["freshly verified native settings for this exact saved session"],
    });
  }
  return [
    ...tokensFor({ kind: "flag-value", flag: h.vocabulary.modelFlag }, saved.model),
    ...tokensFor(effortRender, saved.effort),
    ...tokensFor(codexNativeProviderRender, saved.provider),
  ];
}
