import { existsSync, realpathSync } from "node:fs";
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
  return { path, exists: path !== null && existsSync(path) };
};
