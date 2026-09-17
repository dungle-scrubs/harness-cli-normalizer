/**
 * The resume-last pre-spawn guard (RFC-06 Safety item 4), computed in the
 * CLI layer: one fixed warning text carrying no id, a diagnostic line
 * naming the resolved store root for the scope, and - where a per-cwd
 * directory check exists - a warn (never refuse) when that directory is
 * absent. The check cannot catch the stranger case, where the directory
 * exists and holds the wrong session.
 *
 * Roots resolve through the descriptor's precedence table first
 * (`resolveStoreRoot`: cursor in v1), else through the shared
 * transcript-style roots (`transcriptStoreRoot`: the fixed home-path
 * harnesses) - the same directory `transcript.ts` reads. The caller
 * passes the child's effective environment (`effectiveGuardEnv`: --env
 * merged over the process env with the spawn's delete rule, plus the
 * descriptor turn env), so a --env store relocation moves the guard with
 * the child. The rendered lines travel to `streamTurn` as plain option
 * data (ADR 0005); execution only emits them.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resumeLastWarning } from "../interpretation/resume-last.js";
import { slugFor, storePath } from "../interpretation/store.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { resolveStoreRoot } from "./resume-guard.js";
import { transcriptStoreRoot } from "./store-root.js";

export interface ResumeLastNoticeInputs {
  /** The child's effective environment (see `effectiveGuardEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The spawn cwd (raw; realpath'd here). */
  readonly cwd: string;
  /** Home for root expansion; defaults to the env, else the process home. */
  readonly home?: string;
}

/** The store root for the scope: descriptor data first, the shared
 * transcript-style root elsewhere. The choice keys on descriptor data
 * (whether a rootEnv/defaultRoot table exists), never on a name. The
 * transcript-style roots resolve with the spawn-cwd anchor (relative env
 * values anchor at the spawn cwd, empty counts as unset - the same
 * precedence `resolveStoreRoot` uses); `hcn transcript` keeps the legacy
 * process-cwd behavior and never passes through here. */
export const resumeLastStoreRoot = (
  h: HarnessDescriptor,
  opts: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly home: string;
  },
): string =>
  resolveStoreRoot(h, { env: opts.env, cwd: opts.cwd, home: opts.home }) ??
  transcriptStoreRoot(h.name, {
    env: opts.env,
    cwd: opts.cwd,
    home: opts.home,
    envAnchor: "spawn-cwd",
  });

/** A session id that passes the store-path shape check, used only to
 * resolve a template down to its per-cwd directory - the id itself is
 * never read back out. */
const SCOPE_PROBE_ID = "scope-probe";

/** The per-cwd scope directory whose absence warns, or null where no
 * check exists. Derived purely from the store template: a template with
 * no `{cwdSlug}` (codex, muse) files no per-cwd directory; one whose
 * per-cwd directory also files session entries (pi: no `{sessionId}`
 * and no `{root}`) is the resolved root itself; one with a `{root}`
 * per-cwd directory (cursor) resolves through the template; one filing
 * one entry per session under the slug (claude) is the slug joined under
 * the resolved root. */
export const resumeLastScopeDir = (
  h: HarnessDescriptor,
  opts: { readonly root: string; readonly cwd: string; readonly home: string },
): string | null => {
  const template = h.store.template;
  if (!template.includes("{cwdSlug}")) return null;
  if (template.includes("{sessionId}")) return join(opts.root, slugFor(h, opts.cwd));
  if (!template.includes("{root}")) return opts.root;
  return storePath(h, {
    home: opts.home,
    cwd: opts.cwd,
    sessionId: SCOPE_PROBE_ID,
    root: opts.root,
  });
};

export interface ResumeLastNotices {
  /** The realpath scope the texts name. */
  readonly cwd: string;
  /** The resolved store root the diagnostic line names. */
  readonly root: string;
  /** The pre-spawn messages in emit order: the fixed warning, the
   * resolved-root diagnostic, then the absent-directory warn when the
   * per-cwd directory is missing (never a refusal: the absent case is
   * also the legitimate first run in a new cwd). */
  readonly messages: readonly string[];
}

/** The realpath of the spawn cwd: the harnesses slug the physical path
 * (the claude project directory carries the -private-tmp- prefix). A cwd
 * that does not exist yet resolves to itself. */
export const resumeLastScopeCwd = (cwd: string): string => {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
};

/** The full pre-spawn guard for one resume-last turn. Read-only against
 * the filesystem (one realpath, at most one existence check); never
 * refuses. */
export const resumeLastNoticesFor = (
  h: HarnessDescriptor,
  opts: ResumeLastNoticeInputs,
): ResumeLastNotices => {
  const home = opts.home ?? opts.env.HOME ?? opts.env.USERPROFILE ?? homedir();
  const cwd = resumeLastScopeCwd(opts.cwd);
  const root = resumeLastStoreRoot(h, { env: opts.env, cwd, home });
  const messages: string[] = [
    resumeLastWarning(h, cwd),
    `hcn: --resume-last store root ${root} for scope ${cwd}`,
  ];
  const dir = resumeLastScopeDir(h, { root, cwd, home });
  if (dir !== null && !existsSync(dir)) {
    messages.push(
      `hcn: --resume-last found no store directory for scope ${cwd} (${dir}); a first run in a new directory looks the same, so this warns instead of refusing`,
    );
  }
  return { cwd, root, messages };
};
