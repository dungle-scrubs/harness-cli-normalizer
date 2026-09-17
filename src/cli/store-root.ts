import { resolve } from "node:path";
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
  },
): string => {
  if (harness === "codex") return resolve(opts.env.CODEX_HOME ?? resolve(opts.home, ".codex"));
  if (harness === "claude")
    return resolve(opts.env.CLAUDE_CONFIG_DIR ?? resolve(opts.home, ".claude"), "projects");
  if (harness === "muse")
    return resolve(
      opts.env.XDG_DATA_HOME ?? resolve(opts.home, ".local", "share"),
      "muse",
      "sessions",
    );
  return resolve(
    opts.env.PI_CODING_AGENT_DIR ?? resolve(opts.home, ".pi", "agent"),
    "sessions",
    `--${opts.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
};
