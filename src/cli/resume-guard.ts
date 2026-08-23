import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { storePath } from "../interpretation/store.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface ResumeStoreCheck {
  /** The store path hcn expects for this cwd and id, or null when the
   * descriptor cannot compute one. */
  readonly path: string | null;
  readonly exists: boolean;
}

/** Where a harness that creates sessions on an unknown id (pi, muse) would
 * have filed this session. The cwd is resolved to its real path first: the
 * harness slugs the directory it actually ran in, and on macOS a temp
 * directory reached through /var is really under /private/var - slugging
 * the unresolved path refused valid resumes. */
export const resumeStore = (
  h: HarnessDescriptor,
  opts: { readonly cwd: string; readonly home: string; readonly sessionId: string },
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
    path = storePath(h, { home: opts.home, cwd, sessionId: opts.sessionId });
  } catch {
    path = null;
  }
  return { path, exists: path !== null && sessionExistsAt(path, opts.sessionId) };
};

/** A store template that resolves to a FILE names the session directly and
 * existence is the file's. One that resolves to a DIRECTORY names where the
 * harness files every session for this cwd, and the session is one entry in
 * it whose name carries the id somewhere - pi writes `<timestamp>_<id>.jsonl`,
 * so the id's position is not a template. Checking only that the directory
 * exists reported every id as present once any session had ever run in the
 * cwd, which made the guard pass unknown ids on pi and, once `origin` rode
 * on it, reported a brand-new session as resumed. */
const sessionExistsAt = (path: string, sessionId: string): boolean => {
  if (!existsSync(path)) return false;
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return false;
  }
  if (!isDir) return true;
  try {
    return readdirSync(path).some((name) => name.includes(sessionId));
  } catch {
    return false;
  }
};
