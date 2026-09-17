import { isAbsolute, resolve } from "node:path";
import type { HarnessName } from "../knowledge/descriptor.js";

/** The transcript store root for one harness, resolved impurely from the
 * environment. Single source for `transcript.ts` and the resume-last CLI
 * guard: both must name the same directory the harness files sessions
 * under, so the branches live here once rather than copied per caller.
 * Where a descriptor carries its own root table (`store.rootEnv` /
 * `store.defaultRoot`, cursor in v1) the guard prefers that descriptor
 * data; this helper covers the fixed home-path harnesses. */
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
  // Cursor never reaches here: `transcript.ts` refuses cursor
  // (`transcript: null`) before root computation, and the resume-last
  // guard resolves cursor through the descriptor table first. Throw
  // rather than silently handing cursor a pi root.
  if (harness === "cursor") {
    throw new Error(
      "cursor store root resolves through the descriptor table (resolveStoreRoot), never here",
    );
  }
  const exhaustive: never = harness;
  throw new Error(`transcriptStoreRoot: unreachable harness ${String(exhaustive)}`);
};
