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
  // codex-only (the only harness with a sandbox dimension). Promotes the
  // descriptor's implicit workspace-write default into the visible
  // profile tier. On the other three the dimension is unrenderable and
  // reports as divergence.
  sandbox: "workspace-write",
  // Ratified: discovery fully ON. The harnesses' bare runs already
  // discover instruction files, skills, and extensions; the profile makes
  // that a stated contract. The off-spellings exist per harness
  // (-ns/-nc/-ne on pi, --setting-sources on claude) for callers who want
  // less.
  discovery: { tools: true, instructionFiles: true, extensions: true, skills: true },
  // Ratified: autonomy OFF. No bare run is unattended; --autonomy or a
  // config must say so deliberately.
  autonomy: false,
  // D9/D10, ratified round 2: write and shell ON - names current
  // behavior (emit-nothing on claude/codex/pi; muse omits its disable
  // flags). Completes the "what can a bare run do to the machine" row of
  // provenance.
  write: true,
  shell: true,
  // D13, ratified: equivalent-as-possible tool defaults. The marker
  // expands per descriptor at resolve time - pi gains its dormant
  // grep/find/ls; claude emits nothing (already everything); codex/muse
  // report divergence (no list surface). Project floors narrow it by
  // the normal precedence chain.
  tools: "all-known",
  // Model is PERMANENTLY out of profile scope (ratified round 2): no
  // cross-harness model namespace exists, pi's registry is
  // runtime-extensible and environment-dependent, and per-harness config
  // already covers "claude on X, pi on Y". Do not add a model entry.
  // timeout and maxSteps are likewise opt-in-only dimensions (D11/D12):
  // no harness ships a wall-clock cap, one prompt expands into an
  // unbounded turn loop, and a fixed default kills legitimate work. They
  // live in args/config only, never here.
} as const);

export type ProfileKey = keyof typeof DEFAULT_TURN_PROFILE;
