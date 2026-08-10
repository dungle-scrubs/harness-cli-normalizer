/**
 * Model/effort vocabulary: pure checks of a caller's selector against the
 * descriptor's curated vocabulary, resolving aliases to the harness's own
 * spelling. Rejections name the accepted vocabulary so the refusal is
 * actionable without reading the descriptor. Resolution lives in ONE place
 * (resolveModel) so validation and capability claims cannot drift.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export type Validated = { readonly ok: true; readonly id: string } | ValidationRefusal;

export interface ValidationRefusal {
  readonly ok: false;
  readonly reason: string;
}

/** The selector grammar an extensible registry still demands: pi documents
 * models as provider/id[:thinking], so word characters plus the few real
 * separators - never whitespace, shell metacharacters, or control/format
 * characters, and bounded like session ids. */
const CLEAN_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export interface ResolvedModel {
  readonly id: string;
  readonly curated: boolean;
}

/** Alias-resolve a model selector. Object.hasOwn guards the alias lookup -
 * "__proto__" must resolve to itself, not to Object.prototype. */
export const resolveModel = (h: HarnessDescriptor, model: string): ResolvedModel => {
  const trimmed = model.trim();
  const aliased = Object.hasOwn(h.vocabulary.aliases, trimmed)
    ? h.vocabulary.aliases[trimmed]
    : undefined;
  const id = aliased ?? trimmed;
  return { id, curated: h.vocabulary.models.includes(id) };
};

export const validateModel = (h: HarnessDescriptor, model: string): Validated => {
  const { id, curated } = resolveModel(h, model);
  if (curated) return { ok: true, id };
  if (h.vocabulary.extensible) {
    // D-008: the registry is runtime-extensible - accept any CLEAN unknown
    // selector; capability claims for it degrade separately.
    if (CLEAN_SELECTOR.test(id)) return { ok: true, id };
    return {
      ok: false,
      reason: `model selector ${JSON.stringify(model)} for ${h.bin} is blank, flag-shaped, over-long, or carries whitespace/control/shell characters`,
    };
  }
  return {
    ok: false,
    reason: `unknown ${h.bin} model ${JSON.stringify(model)}; accepted: ${h.vocabulary.models.join(", ")} (aliases: ${Object.keys(h.vocabulary.aliases).join(", ")})`,
  };
};

/** Validate an effort against the ladder that applies to the pick: the
 * model's own ladder where the harness constrains per model (codex), else
 * the harness-wide ladder. */
export const validateEffort = (h: HarnessDescriptor, effort: string, model?: string): Validated => {
  let ladder = h.vocabulary.efforts;
  if (model !== undefined && h.vocabulary.effortsByModel !== undefined) {
    const { id } = resolveModel(h, model);
    const perModel = Object.hasOwn(h.vocabulary.effortsByModel, id)
      ? h.vocabulary.effortsByModel[id]
      : undefined;
    if (perModel !== undefined) ladder = perModel;
  }
  if (ladder.includes(effort)) return { ok: true, id: effort };
  return {
    ok: false,
    reason: `unknown ${h.bin} effort ${JSON.stringify(effort)}${model === undefined ? "" : ` for model ${JSON.stringify(model)}`}; ladder: ${ladder.join(" < ")}`,
  };
};
