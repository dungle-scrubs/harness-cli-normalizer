import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { mergeEnvironment } from "../execution/environment.js";
import { storePath } from "../interpretation/store.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface ResumeStoreCheck {
  /** The store path hcn expects for this cwd and id, or null when the
   * descriptor cannot compute one. */
  readonly path: string | null;
  readonly exists: boolean;
}

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
    const rooted = entry.suffix === "" ? value : join(value, entry.suffix);
    return isAbsolute(rooted) ? rooted : resolve(opts.cwd, rooted);
  }
  // {cwd} names a spawn-relative root (popeye's session dir defaults to
  // the spawn cwd); {home} keeps the existing home-anchored behavior.
  return h.store.defaultRoot
    ?.replaceAll("{home}", () => opts.home)
    .replaceAll("{cwd}", () => opts.cwd);
};

/** The environment the child will run with, for the pre-spawn store
 * check: per-call `--env` over the inherited environment, the
 * descriptor-derived turn env over that, with the spawn's delete-on-empty
 * rule. This is the same merge the spawn adapter applies
 * (`mergeEnvironment`), so the guard resolves the same store root the
 * child files the session under. */
export const effectiveGuardEnv = (
  inherited: Readonly<Record<string, string | undefined>>,
  callEnv: Readonly<Record<string, string>>,
  turnEnv: Readonly<Record<string, string>> = {},
): Record<string, string> => mergeEnvironment(inherited, { ...callEnv, ...turnEnv });

/** Where a harness that creates sessions on an unknown id would
 * have filed this session. The cwd is resolved to its real path first: the
 * harness slugs the directory it actually ran in, and on macOS a temp
 * directory reached through /var is really under /private/var - slugging
 * the unresolved path refused valid resumes. */
export const resumeStore = (
  h: HarnessDescriptor,
  opts: {
    readonly cwd: string;
    readonly home: string;
    readonly sessionId: string;
    /** Environment to resolve rootEnv through; defaults to the process
     * environment. Injectable so tests pin precedence without mutating it. */
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): ResumeStoreCheck => {
  let cwd = opts.cwd;
  try {
    cwd = realpathSync.native(opts.cwd);
  } catch {
    // A cwd that does not exist yet resolves to itself; the harness will
    // create it and slug whatever it created.
  }
  let path: string | null = null;
  try {
    const root = resolveStoreRoot(h, {
      env: opts.env ?? process.env,
      cwd,
      home: opts.home,
    });
    path = storePath(h, {
      home: opts.home,
      cwd,
      sessionId: opts.sessionId,
      ...(root !== undefined ? { root } : {}),
    });
  } catch {
    path = null;
  }
  return { path, exists: path !== null && sessionExistsAt(path, opts.sessionId) };
};

/** A store template that resolves to a FILE names the session directly and
 * existence is the file's. One that resolves to a DIRECTORY names where the
 * harness files every session, and the session is an entry somewhere under it
 * whose name carries the id - not at a position a template can express:
 *
 *   pi    <root>/<cwdSlug>/<timestamp>_<id>.jsonl        one level down
 *   muse  <root>/YYYY/MM/DD/<id>/session.jsonl          three levels down
 *
 * The first version of this search looked one level only, written against
 * pi, and refused every muse resume (#103) for a session that was right
 * there. It now walks the tree, bounded: the id's own directory is a match
 * and is not descended, and depth is capped so a pathological store cannot
 * turn a pre-spawn check into a crawl. */
const MAX_STORE_DEPTH = 4;

const sessionExistsAt = (path: string, sessionId: string): boolean => {
  if (!existsSync(path)) return false;
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return false;
  }
  if (!isDir) return true;
  return containsSessionId(path, sessionId, 0);
};

const containsSessionId = (dir: string, sessionId: string, depth: number): boolean => {
  if (depth > MAX_STORE_DEPTH) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.includes(sessionId)) return true;
  }
  for (const name of entries) {
    const child = join(dir, name);
    let childIsDir = false;
    try {
      childIsDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (childIsDir && containsSessionId(child, sessionId, depth + 1)) return true;
  }
  return false;
};
