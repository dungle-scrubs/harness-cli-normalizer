/**
 * Cursor effort-table transcription helpers (test-only). These lived in
 * `src/knowledge/cursor.ts` until the implementation review (L6) moved
 * them here: the descriptor is pure data, and only the tests use the Stem
 * rule and the transcription guard. Production resolution lives in
 * `src/interpretation/vocabulary.ts` (`resolveEffortSlug`) and does its
 * own row lookup.
 */

/** Hcn effort words, for Stem-rule matching below. */
const EFFORT_WORDS: ReadonlySet<string> = new Set([
  "minimal",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** One Stem-rule key: the table stem, the hcn effort word (undefined for
 * bare forms), and whether the slug carries one trailing `-fast` suffix. */
export interface StemKey {
  readonly stem: string;
  readonly effort: string | undefined;
  readonly fast: boolean;
}

const wordOf = (match: RegExpExecArray | null, index: number): string | undefined => {
  if (match === null) return undefined;
  const word = match[index];
  return word === undefined || !EFFORT_WORDS.has(word) ? undefined : word;
};

/** The RFC-05 Stem rule, applied in order: strip one trailing `-fast`,
 * infixed `-thinking-<effort>`, suffixed `-<effort>-thinking`, bare
 * `-thinking` forms, `-<effort>` suffixes (`-extra-high` reads as `xhigh`),
 * else the slug is its own stem. Pure syntax: a bare slug with a table row
 * resolves to that row's medium value in checkEffortTable, not here. */
export const stemKeyOfSlug = (slug: string): StemKey => {
  let rest = slug;
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -"-fast".length);
  }
  const infixed = /^(.*)-thinking-([A-Za-z0-9]+)$/.exec(rest);
  const infixedEffort = wordOf(infixed, 2);
  if (infixed !== null && infixed[1] !== undefined && infixedEffort !== undefined) {
    return { stem: `${infixed[1]}-thinking`, effort: infixedEffort, fast };
  }
  const suffixed = /^(.*)-([A-Za-z0-9]+)-thinking$/.exec(rest);
  const suffixedEffort = wordOf(suffixed, 2);
  if (suffixed !== null && suffixed[1] !== undefined && suffixedEffort !== undefined) {
    return { stem: `${suffixed[1]}-thinking`, effort: suffixedEffort, fast };
  }
  if (rest.endsWith("-thinking")) {
    return { stem: rest, effort: undefined, fast };
  }
  if (rest.endsWith("-extra-high")) {
    return { stem: rest.slice(0, -"-extra-high".length), effort: "xhigh", fast };
  }
  const tailed = /^(.*)-([A-Za-z0-9]+)$/.exec(rest);
  const tailEffort = wordOf(tailed, 2);
  if (tailed !== null && tailed[1] !== undefined && tailEffort !== undefined) {
    return { stem: tailed[1], effort: tailEffort, fast };
  }
  return { stem: rest, effort: undefined, fast };
};

/** Transcription guard: every slug in `models` must be reachable from
 * exactly one `(stem, effort[, fast])` key through `effortSlugs`, or be a
 * bare-only stem with no row. A bare slug that shares its stem with an
 * explicit `-medium` slug throws rather than double-mapping medium, as
 * does any unreachable slug, duplicate key, or row value naming no listed
 * slug. The resolver owns the table's shape at runtime; this check owns
 * its transcription. */
export const checkEffortTable = (
  models: readonly string[],
  effortSlugs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void => {
  const modelSet = new Set(models);
  const seen = new Set<string>();
  const claim = (stem: string, effort: string, fast: boolean): void => {
    const id = `${stem} ${effort} ${fast ? "fast" : "plain"}`;
    if (seen.has(id)) throw new Error(`cursor effort table: duplicate key ${id}`);
    seen.add(id);
  };
  for (const slug of models) {
    const key = stemKeyOfSlug(slug);
    const row = Object.hasOwn(effortSlugs, key.stem)
      ? (effortSlugs[key.stem] as Readonly<Record<string, string>>)
      : undefined;
    if (key.effort === undefined) {
      const base = key.fast ? slug.slice(0, -"-fast".length) : slug;
      if (row === undefined) {
        if (!modelSet.has(base)) {
          throw new Error(
            `cursor effort table: ${slug} strips to ${base}, which is not a listed slug`,
          );
        }
        claim(key.stem, "-", key.fast);
        continue;
      }
      const medium = row.medium;
      const want = medium === undefined ? undefined : key.fast ? `${medium}-fast` : medium;
      if (slug !== want) {
        throw new Error(
          `cursor effort table: bare slug ${slug} shares its stem with an explicit -medium slug ${medium ?? "(none)"} - transcription must fail rather than double-map medium`,
        );
      }
      claim(key.stem, "medium", key.fast);
      continue;
    }
    const value = row?.[key.effort];
    const want = value === undefined ? undefined : key.fast ? `${value}-fast` : value;
    if (slug !== want) {
      throw new Error(
        `cursor effort table: ${slug} is not reachable from (${key.stem}, ${key.effort}${key.fast ? ", fast" : ""})`,
      );
    }
    claim(key.stem, key.effort, key.fast);
  }
  for (const [stem, row] of Object.entries(effortSlugs)) {
    for (const [effort, value] of Object.entries(row)) {
      if (!modelSet.has(value)) {
        throw new Error(
          `cursor effort table: row ${stem}/${effort} names ${value}, which is not a listed slug`,
        );
      }
    }
  }
};
