import { dirname, isAbsolute, resolve } from "node:path";
import { cursorCli } from "../knowledge/cursor.js";
import type { HarnessName } from "../knowledge/descriptor.js";
import { resolveStoreRoot } from "./resume-guard.js";

/** The transcript store root for one harness, resolved impurely from the
 * environment. Single source for `transcript.ts` and the resume-last CLI
 * guard: both must name the same directory the harness files sessions
 * under, so the branches live here once rather than copied per caller.
 * Cursor carries its own root table (`store.rootEnv` / `store.defaultRoot`),
 * so its branch reads that descriptor data; the others are fixed home paths. */
export const transcriptStoreRoot = (
  harness: HarnessName,
  opts: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
    readonly home: string;
    /** How store-root env values resolve. The default (`process-cwd`) is
     * the legacy transcript behavior: a relative value anchors at the hcn
     * process cwd and a set-but-empty value counts as set. `hcn
     * transcript` keeps that behavior deliberately and passes nothing
     * here, so its behavior is unchanged. The resume-last diagnostic and
     * absent-directory check pass `spawn-cwd`: a relative value anchors
     * at the spawn cwd and a set-but-empty value counts as unset, the
     * same precedence `resolveStoreRoot` uses. */
    readonly envAnchor?: "process-cwd" | "spawn-cwd";
  },
): string => {
  const spawnCwd = opts.envAnchor === "spawn-cwd";
  const isSet = (value: string | undefined): value is string =>
    value !== undefined && (!spawnCwd || value !== "");
  const at = (value: string): string =>
    spawnCwd && !isAbsolute(value) ? resolve(opts.cwd, value) : resolve(value);
  if (harness === "codex") {
    const value = opts.env.CODEX_HOME;
    return isSet(value) ? at(value) : resolve(opts.home, ".codex");
  }
  if (harness === "claude") {
    const value = opts.env.CLAUDE_CONFIG_DIR;
    return isSet(value)
      ? resolve(at(value), "projects")
      : resolve(opts.home, ".claude", "projects");
  }
  if (harness === "muse") {
    const value = opts.env.XDG_DATA_HOME;
    return isSet(value)
      ? resolve(at(value), "muse", "sessions")
      : resolve(opts.home, ".local", "share", "muse", "sessions");
  }
  if (harness === "pi") {
    const value = opts.env.PI_CODING_AGENT_DIR;
    const base = isSet(value) ? at(value) : resolve(opts.home, ".pi", "agent");
    return resolve(
      base,
      "sessions",
      `--${opts.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    );
  }
  if (harness === "antigravity") {
    return resolve(opts.home, ".gemini", "antigravity-cli", "brain");
  }
  if (harness === "cursor") {
    // Cursor's root follows its descriptor precedence table (probes 44-54).
    const root = resolveStoreRoot(cursorCli, opts);
    if (root === undefined) throw new Error("cursor descriptor declares no store root");
    return root;
  }
  if (harness === "popeye") {
    // Flat <sessionDir>/<sessionId>.jsonl; the default session dir is
    // cwd-relative. POPEYE_SESSION_DIR is not a popeye feature; the
    // spawn cwd names the directory the child uses.
    return resolve(opts.cwd, ".popeye", "sessions");
  }
  const exhaustive: never = harness;
  throw new Error(`transcriptStoreRoot: unreachable harness ${String(exhaustive)}`);
};

/** The directory `transcript ls` walks for one harness.
 *
 * Four harnesses list from the same directory they read from. Pi files each
 * session under a per-workspace directory, and Antigravity keeps the
 * conversation index that names each workspace beside its `brain` directory,
 * so both list from one level up. The branch stays here rather than in
 * `transcriptStoreRoot`, which keeps naming the directory a read resolves in. */
export const transcriptListingRoot = (
  harness: HarnessName,
  opts: Parameters<typeof transcriptStoreRoot>[1],
): string =>
  harness === "pi" || harness === "antigravity"
    ? dirname(transcriptStoreRoot(harness, opts))
    : transcriptStoreRoot(harness, opts);
