/**
 * Model/effort vocabulary: pure checks of a caller's selector against the
 * descriptor's curated vocabulary, resolving aliases to the harness's own
 * spelling. Rejections name the accepted vocabulary so the refusal is
 * actionable without reading the descriptor. Resolution lives in ONE place
 * (resolveModel) so validation and capability claims cannot drift.
 */
import { ACCESS_VALUES, type HarnessDescriptor } from "../knowledge/descriptor.js";
import { ArgvRefusalError } from "./refusal.js";

export type Validated = { readonly ok: true; readonly id: string } | ValidationRefusal;

export interface ValidationRefusal {
  readonly ok: false;
  readonly reason: string;
}

/** The one selector grammar for model ids, tool names, and toolMap keys
 * (RFC-02 change 9): pi documents models as provider/id[:thinking], so
 * word characters plus the few real separators - never whitespace, shell
 * metacharacters, or control/format characters, and bounded like session
 * ids. */
export const CLEAN_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

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

/** The access preset takes one of the closed ACCESS_VALUES. */
export const validateAccess = (value: string): Validated => {
  if ((ACCESS_VALUES as readonly string[]).includes(value)) return { ok: true, id: value };
  return {
    ok: false,
    reason: `unknown access ${JSON.stringify(value)}; accepted: ${ACCESS_VALUES.join(", ")}`,
  };
};

/** Reverse-index one slug to the (stem, effort) pair whose row value it
 * is, or null when no row lists it. First match wins; rows never share a
 * value in the transcribed table. */
const reverseIndexEffort = (
  table: Readonly<Record<string, Readonly<Record<string, string>>>>,
  slug: string,
): { readonly stem: string; readonly effort: string } | null => {
  for (const [stem, row] of Object.entries(table)) {
    for (const [effort, value] of Object.entries(row)) {
      if (value === slug) return { stem, effort };
    }
  }
  return null;
};

/** Resolve a cursor model plus effort to the slug that runs (RFC-05).
 * The ONE owner of the family, stem, variant, and fast rules; the single
 * call site is the plan-turn resolve step. Rules apply in
 * order, first match wins, model checks before effort checks:
 * unknown-model for a selector naming no slug and no stem (supported
 * follows the unknown-model convention) and for a bare stem with no
 * effort (supported is that stem's row slugs); stem plus effort resolves
 * through the row (missing effort refuses unknown-effort with the stem
 * ladder); a variant or -fast slug pins its effort (same effort passes
 * through, a conflict refuses invalid-option-value, nothing is ever
 * composed); effort with no model or with a bare-only model refuses
 * unknown-effort with empty supported; a word outside the union ladder
 * refuses unknown-effort with the union. Returns undefined only when
 * both inputs are absent. */
export const resolveEffortSlug = (
  h: HarnessDescriptor,
  model: string | undefined,
  effort: string | undefined,
): string | undefined => {
  const table = h.vocabulary.effortSlugs ?? {};
  if (model === undefined) {
    if (effort === undefined) return undefined;
    throw new ArgvRefusalError({
      issue: "unknown-effort",
      harness: h.name,
      option: "effort",
      supported: [],
      detail: effort,
    });
  }
  const { id } = resolveModel(h, model);
  const isSlug = h.vocabulary.models.includes(id);
  const row = Object.hasOwn(table, id)
    ? (table[id] as Readonly<Record<string, string>>)
    : undefined;
  if (!isSlug && row === undefined) {
    throw new ArgvRefusalError({
      issue: "unknown-model",
      harness: h.name,
      supported: [...h.vocabulary.models, ...Object.keys(h.vocabulary.aliases)],
      detail: model,
    });
  }
  if (effort === undefined) {
    if (row !== undefined && !isSlug) {
      throw new ArgvRefusalError({
        issue: "unknown-model",
        harness: h.name,
        supported: [...Object.values(row)],
        detail: model,
      });
    }
    return id;
  }
  if (!h.vocabulary.efforts.includes(effort)) {
    throw new ArgvRefusalError({
      issue: "unknown-effort",
      harness: h.name,
      option: "effort",
      supported: [...h.vocabulary.efforts],
      detail: effort,
    });
  }
  // The stem-key rule precedes the variant rule: a value that is also a
  // stem key (gpt-5.2 is its row's medium value) still resolves here.
  if (row !== undefined) {
    const target = Object.hasOwn(row, effort) ? row[effort] : undefined;
    if (target === undefined) {
      throw new ArgvRefusalError({
        issue: "unknown-effort",
        harness: h.name,
        option: "effort",
        supported: [...Object.keys(row)],
        detail: `${model} offers no ${effort}`,
      });
    }
    return target;
  }
  const pinned = reverseIndexEffort(table, id);
  if (pinned !== null) {
    if (pinned.effort === effort) return id;
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      option: "effort",
      supported: [pinned.effort],
      detail: `${model} pins effort ${pinned.effort}`,
    });
  }
  if (id.endsWith("-fast")) {
    const base = reverseIndexEffort(table, id.slice(0, -"-fast".length));
    if (base === null) {
      throw new ArgvRefusalError({
        issue: "unknown-effort",
        harness: h.name,
        option: "effort",
        supported: [],
        detail: model,
      });
    }
    if (base.effort === effort) return id;
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      option: "effort",
      supported: [base.effort],
      detail: `${model} pins effort ${base.effort}`,
    });
  }
  throw new ArgvRefusalError({
    issue: "unknown-effort",
    harness: h.name,
    option: "effort",
    supported: [],
    detail: model,
  });
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
