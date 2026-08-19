/**
 * The built-in default turn profile: hcn's curated defaults for a bare run,
 * decided in review (2026-08-18) and applied LAUNCH-ONLY, before user config
 * and args. Every entry here is a ratified dimension; unratified dimensions
 * stay absent and defer to the harness.
 *
 * effort: "medium" - the only value present in all four effort ladders
 * (claude/pi/muse/codex-per-model). Live probe on claude 2.1.233 showed the
 * internal default is above medium and nondeterministic (599-1482 thinking
 * tokens on identical tasks vs 436 at medium); pinning makes bare runs
 * cheaper on claude, uniform everywhere, and knowable from the outside.
 */
import { deepFreeze } from "./descriptor.js";

export const DEFAULT_TURN_PROFILE = deepFreeze({
  effort: "medium",
} as const);

export type ProfileKey = keyof typeof DEFAULT_TURN_PROFILE;
