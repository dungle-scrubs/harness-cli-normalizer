/**
 * Installed pi model pairs: pure projection of pi's two store files into
 * provider/model pairs (RFC-27 ticket 01). The custom registry
 * (`models.json`) holds user-registered providers; the built-in store
 * (`models-store.json`) holds pi's own providers. Both carry the same
 * `{ providers: { <name>: { models: [{ id }] } } }` shape. Pure so the
 * projection is unit-pinnable; file reads stay in the CLI layer, which
 * the purity gate does not cover.
 */
import { CLEAN_SELECTOR } from "./vocabulary.js";

export interface InstalledModelPair {
  readonly provider: string;
  readonly model: string;
}

export interface InstalledModelStores {
  readonly custom: unknown;
  readonly builtin: unknown;
}

/** Project both stores into pairs. Per-entry drops are silent: an entry
 * that fails the clean-selector shape is skipped, never served. The
 * custom registry nests providers under a `providers` key; the built-in
 * store maps provider names to entries directly. A store of any other
 * shape contributes nothing. */
export const installedModelPairs = (stores: InstalledModelStores): InstalledModelPair[] => {
  const pairs: InstalledModelPair[] = [];
  const collect = (providers: unknown): void => {
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return;
    for (const [provider, entry] of Object.entries(providers as Record<string, unknown>)) {
      if (!CLEAN_SELECTOR.test(provider)) continue;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const models = (entry as { models?: unknown }).models;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (model === null || typeof model !== "object" || Array.isArray(model)) continue;
        const id = (model as { id?: unknown }).id;
        if (typeof id !== "string" || !CLEAN_SELECTOR.test(id)) continue;
        pairs.push({ provider, model: id });
      }
    }
  };
  for (const store of [stores.custom, stores.builtin]) {
    if (store === null || typeof store !== "object" || Array.isArray(store)) continue;
    const nested = (store as { providers?: unknown }).providers;
    // The built-in store maps providers directly; the custom registry
    // nests them. A top-level `models` array is neither - skip it rather
    // than read a shape no store writes.
    if (nested !== undefined) collect(nested);
    else if (!Array.isArray((store as { models?: unknown }).models)) collect(store);
  }
  return pairs;
};
