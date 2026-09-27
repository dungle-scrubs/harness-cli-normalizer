import { isAbsolute, join, resolve } from "node:path";
import { expandRoot } from "../interpretation/store.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

/** RFC-05: resolve the store root impurely from the environment, through
 * the descriptor's precedence table instead of a harness-name branch.
 * First set entry wins; set-but-empty counts as unset (probe 53);
 * relative values resolve against the spawn cwd (probe 54; the
 * process-cwd split is unverified, so the resolved spawn cwd anchors
 * it); else defaultRoot with {home} expanded. Descriptors without
 * rootEnv and defaultRoot (the four existing harnesses) yield undefined
 * and their paths compute exactly as today. */
export const resolveStoreRoot = (
  h: HarnessDescriptor,
  opts: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly home: string;
  },
): string | undefined => {
  for (const entry of h.store.rootEnv ?? []) {
    const value = opts.env[entry.name];
    if (value === undefined || value === "") continue;
    const suffix = expandRoot(h, entry.suffix, opts.home, opts.cwd);
    const rooted = suffix === "" ? value : join(value, suffix);
    return isAbsolute(rooted) ? rooted : resolve(opts.cwd, rooted);
  }
  // {cwd} names a spawn-relative root (popeye's session dir defaults to
  // the spawn cwd); {home} keeps the existing home-anchored behavior.
  return h.store.defaultRoot === undefined
    ? undefined
    : expandRoot(h, h.store.defaultRoot, opts.home, opts.cwd);
};
