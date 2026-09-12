import { codexNativeProviderRender } from "../knowledge/codex.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { resolveRender, tokensFor, UUID_SHAPE } from "../knowledge/descriptor.js";
import { NATIVE_SETTINGS_FINGERPRINT_SHAPE } from "../knowledge/native-settings.js";
import type { SpawnArgvOptions } from "./argv.js";
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

/** A verified source bypasses only the curated model catalog, never selector validation. */
export function renderVerifiedNativeSettings(
  h: HarnessDescriptor,
  opts: SpawnArgvOptions,
): string[] {
  const saved = opts.verifiedNativeSettings;
  if (!saved) return [];
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
