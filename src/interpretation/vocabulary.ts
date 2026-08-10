/**
 * Model/effort vocabulary validation: pure checks of a caller's selector
 * against the descriptor's curated vocabulary, resolving aliases to the
 * harness's own spelling. Rejections name the accepted vocabulary so the
 * refusal is actionable without reading the descriptor.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export type Validated = { readonly ok: true; readonly id: string } | ValidationRefusal;

export interface ValidationRefusal {
  readonly ok: false;
  readonly reason: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a selector are the injection oracle
const DIRTY_SELECTOR = /[\x00-\x1f\x7f]/;

export const validateModel = (h: HarnessDescriptor, model: string): Validated => {
  const resolved = h.vocabulary.aliases[model] ?? model;
  if (h.vocabulary.models.includes(resolved)) return { ok: true, id: resolved };
  if (h.vocabulary.extensible) {
    // D-008: the registry is runtime-extensible - accept any CLEAN unknown
    // selector; capability claims for it degrade separately.
    if (resolved.trim() !== "" && !resolved.startsWith("-") && !DIRTY_SELECTOR.test(resolved)) {
      return { ok: true, id: resolved };
    }
    return {
      ok: false,
      reason: `model selector ${JSON.stringify(model)} for ${h.bin} is blank, flag-shaped, or carries control characters`,
    };
  }
  return {
    ok: false,
    reason: `unknown ${h.bin} model ${JSON.stringify(model)}; accepted: ${h.vocabulary.models.join(", ")} (aliases: ${Object.keys(h.vocabulary.aliases).join(", ")})`,
  };
};

export const validateEffort = (h: HarnessDescriptor, effort: string): Validated => {
  if (h.vocabulary.efforts.includes(effort)) return { ok: true, id: effort };
  return {
    ok: false,
    reason: `unknown ${h.bin} effort ${JSON.stringify(effort)}; ladder: ${h.vocabulary.efforts.join(" < ")}`,
  };
};
