/**
 * The cursor descriptor: facts about the Cursor CLI (`agent`) as data,
 * verified against agent 2026.09.15-d2fe57e (re-capture:
 * test/fixtures/cursor-2026.09.15-d2fe57e; original spike corpus on
 * 2026.09.10-fd3934a, probes 01-55). The v1 scars this encodes: identity is harness-minted (no
 * caller-assigned id flag; the hidden --new-session-id is not used), an
 * untrusted workspace refuses unless --force bypasses the trust gate per
 * run, effort resolves into the --model slug via effortSlugs, and sessions
 * file under chats/<md5-of-cwd> below a root that follows CURSOR_CONFIG_DIR
 * / XDG_CONFIG_HOME.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { CURSOR_TRANSCRIPT } from "./transcript/cursor.js";

export const cursorCli: HarnessDescriptor = deepFreeze({
  name: "cursor",
  transcript: CURSOR_TRANSCRIPT,
  bin: "agent",
  verifiedAgainst: "2026.09.15-d2fe57e",
  // Re-verified 2026-09-17: smoke:seven (6 pass / 1 n/a) and
  // smoke:questions pass on this version, the decoding corpus is
  // re-captured in test/fixtures/cursor-2026.09.15-d2fe57e, and `agent
  // models` lists the same 223 slugs (only the "(current)" marker moved).
  // Phase 5 (same version) re-probed the sandbox: no confinement.
  // No npm package exists (script install only), so drift detection falls
  // back to the local `agent --version`, skipped where absent.
  //
  // This anchor is not stable under the CLI's own updater. On 2026-09-22 the
  // binary behind `agent` moved from 2026.09.15-d2fe57e to 2026.09.18-9a7762b
  // mid-probe, between two runs minutes apart, with no way found to turn the
  // updater off (docs/research/2026-09-22-compaction-signals/cursor). So a
  // later `agent --version` can disagree with the version that served an
  // earlier run, and `verifiedAgainst` names the version the facts were
  // verified on, not necessarily the one a given run used. `versionSource`
  // has no field for that, so it is recorded here.
  versionSource: { kind: "installed" },
  launch: {
    // Every headless probe runs `-p` (print mode, with write and shell).
    baseFlags: ["-p"],
    // No subcommand: the prompt is positional.
    subcommands: [],
    promptStyle: "positional",
    // Passthrough placement (ADR 0003, probed 2026-09-17 on
    // 2026.09.15-d2fe57e): the RFC-05 prompt-joins verdict (probes 40/41)
    // was the `--` separator's doing. With the separator gone, appended
    // native flags parse: an appended `--model gpt-5-mini` switches the
    // run's model and a bogus flag is rejected natively as an unknown
    // option. The tail renders past hcn's own argv with no separator.
    passthrough: "after-argv",
    // Token-granular stream: the partial flag adds per-fragment deltas and
    // changes nothing else (probes 11, 11b, 43).
    streamFlags: ["--output-format", "stream-json", "--stream-partial-output"],
    // No caller-assigned id flag in the documented surface; the hidden
    // --new-session-id is not used (owner decision).
    idFlag: null,
  },
  resume: {
    // `-p --resume <id>` re-enters headless under the same session_id
    // with turn-1 facts recalled (probes 21a/21b).
    style: "flag",
    flag: "--resume",
    aliases: [],
    // `--resume not-a-uuid` fails fast: ids must be UUIDs (probe 25).
    idShape: UUID_SHAPE,
    // Resume never inherits launch flags, so -p rides along; --model, the
    // stream flags and --force render through the normal paths.
    extraFlags: ["-p"],
    // An unknown UUID returns exit 0 and files a fresh session under the
    // given id (probe 24): create, not error.
    onMissing: "create",
  },
  sessionMode: null,
  output: {
    // Partial deltas are token events; bare stream-json carries full-text
    // assistant records plus thinking events (probes 11, 11b).
    pins: [
      {
        flags: ["--output-format", "stream-json", "--stream-partial-output"],
        granularity: "token",
      },
      { flags: ["--output-format", "stream-json"], granularity: "message" },
    ],
    // `text` emits only the final text; `json` one terminal object
    // (probe 09).
    floor: "none",
    flagAliases: {},
  },
  identity: {
    authority: "harness-minted",
    // init carries session_id, re-emitted on every line including resumes
    // (probes 03, 11, 21/22). `model` is the display name (Composer 2.5
    // Fast, GPT-5.2 Medium), never the slug.
    announce: { match: { type: "system", subtype: "init" }, idField: "session_id" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [
    // Documented mechanism with research-observed strings; the spike ran
    // logged in throughout, so Phase 4 re-verifies both on logged-out runs.
    { pattern: "Authentication required. Please run 'agent login' first", kind: "not-logged-in" },
    { pattern: "The provided API key is invalid", kind: "invalid-key" },
    ...SHARED_AUTH_MATCHERS,
  ],
  trustMatchers: [
    // An untrusted workspace without bypass exits 1 with empty stdout and
    // this stderr text (probes 01/02).
    { pattern: "Workspace Trust Required", flags: "i" },
  ],
  // --force runs edits and non-allowlisted shell with no approval lines
  // and bypasses the trust gate per run without persisting anything
  // (probes 16/17, 31/32). --yolo is the same bypass; hcn renders --force.
  autonomy: { flag: "--force" },
  vocabulary: {
    modelFlag: "--model",
    // Full slug list transcribed from models.txt at verifiedAgainst
    // (227 lines: 223 entries plus header, blank, and tip lines). The file
    // is not sorted, so the snapshot test compares as sets.
    models: [
      "auto",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-low-fast",
      "gpt-5.3-codex",
      "gpt-5.3-codex-fast",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-high-fast",
      "gpt-5.3-codex-xhigh",
      "gpt-5.3-codex-xhigh-fast",
      "gpt-5.2",
      "cursor-grok-4.6-high-fast",
      "composer-2.5",
      "claude-opus-5-thinking-high",
      "claude-opus-5-thinking-high-fast",
      "gpt-5.6-sol-high",
      "gpt-5.6-sol-high-fast",
      "gpt-5.6-sol-xhigh",
      "gpt-5.6-sol-xhigh-fast",
      "claude-fable-5-thinking-high",
      "claude-fable-5-thinking-xhigh",
      "cursor-grok-4.5-high",
      "cursor-grok-4.5-high-fast",
      "gemini-3.7-flash-high",
      "claude-sonnet-5-thinking-high",
      "claude-sonnet-5-thinking-xhigh",
      "gpt-5.6-luna-high",
      "cursor-grok-4.6-low",
      "cursor-grok-4.6-low-fast",
      "cursor-grok-4.6-medium",
      "cursor-grok-4.6-medium-fast",
      "cursor-grok-4.6-high",
      "cursor-grok-4.6-xhigh",
      "cursor-grok-4.6-xhigh-fast",
      "composer-2.5-fast",
      "claude-opus-5-low",
      "claude-opus-5-low-fast",
      "claude-opus-5-medium",
      "claude-opus-5-medium-fast",
      "claude-opus-5-high",
      "claude-opus-5-high-fast",
      "claude-opus-5-thinking-low",
      "claude-opus-5-thinking-low-fast",
      "claude-opus-5-thinking-medium",
      "claude-opus-5-thinking-medium-fast",
      "claude-opus-5-thinking-xhigh",
      "claude-opus-5-thinking-xhigh-fast",
      "claude-opus-5-thinking-max",
      "claude-opus-5-thinking-max-fast",
      "claude-opus-4-8-low",
      "claude-opus-4-8-low-fast",
      "claude-opus-4-8-medium",
      "claude-opus-4-8-medium-fast",
      "claude-opus-4-8-high",
      "claude-opus-4-8-high-fast",
      "claude-opus-4-8-xhigh",
      "claude-opus-4-8-xhigh-fast",
      "claude-opus-4-8-max",
      "claude-opus-4-8-max-fast",
      "claude-opus-4-8-thinking-low",
      "claude-opus-4-8-thinking-low-fast",
      "claude-opus-4-8-thinking-medium",
      "claude-opus-4-8-thinking-medium-fast",
      "claude-opus-4-8-thinking-high",
      "claude-opus-4-8-thinking-high-fast",
      "claude-opus-4-8-thinking-xhigh",
      "claude-opus-4-8-thinking-xhigh-fast",
      "claude-opus-4-8-thinking-max",
      "claude-opus-4-8-thinking-max-fast",
      "gpt-5.6-sol-none",
      "gpt-5.6-sol-none-fast",
      "gpt-5.6-sol-low",
      "gpt-5.6-sol-low-fast",
      "gpt-5.6-sol-medium",
      "gpt-5.6-sol-medium-fast",
      "gpt-5.6-sol-max",
      "gpt-5.6-sol-max-fast",
      "gpt-5.5-none",
      "gpt-5.5-none-fast",
      "gpt-5.5-low",
      "gpt-5.5-low-fast",
      "gpt-5.5-medium",
      "gpt-5.5-medium-fast",
      "gpt-5.5-high",
      "gpt-5.5-high-fast",
      "gpt-5.5-extra-high",
      "gpt-5.5-extra-high-fast",
      "claude-fable-5-1-low",
      "claude-fable-5-1-medium",
      "claude-fable-5-1-high",
      "claude-fable-5-1-xhigh",
      "claude-fable-5-1-max",
      "claude-fable-5-1-thinking-low",
      "claude-fable-5-1-thinking-medium",
      "claude-fable-5-1-thinking-high",
      "claude-fable-5-1-thinking-xhigh",
      "claude-fable-5-1-thinking-max",
      "claude-fable-5-low",
      "claude-fable-5-medium",
      "claude-fable-5-high",
      "claude-fable-5-xhigh",
      "claude-fable-5-max",
      "claude-fable-5-thinking-low",
      "claude-fable-5-thinking-medium",
      "claude-fable-5-thinking-max",
      "cursor-grok-4.5-low",
      "cursor-grok-4.5-low-fast",
      "cursor-grok-4.5-medium",
      "cursor-grok-4.5-medium-fast",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-high",
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
      "muse-spark-1.3-minimal",
      "muse-spark-1.3-low",
      "muse-spark-1.3-medium",
      "muse-spark-1.3-high",
      "muse-spark-1.3-xhigh",
      "muse-spark-1.3-max",
      "gpt-5.6-terra-none",
      "gpt-5.6-terra-none-fast",
      "gpt-5.6-terra-low",
      "gpt-5.6-terra-low-fast",
      "gpt-5.6-terra-medium",
      "gpt-5.6-terra-medium-fast",
      "gpt-5.6-terra-high",
      "gpt-5.6-terra-high-fast",
      "gpt-5.6-terra-xhigh",
      "gpt-5.6-terra-xhigh-fast",
      "gpt-5.6-terra-max",
      "gpt-5.6-terra-max-fast",
      "claude-sonnet-5-low",
      "claude-sonnet-5-medium",
      "claude-sonnet-5-high",
      "claude-sonnet-5-xhigh",
      "claude-sonnet-5-max",
      "claude-sonnet-5-thinking-low",
      "claude-sonnet-5-thinking-medium",
      "claude-sonnet-5-thinking-max",
      "claude-4.6-sonnet-medium",
      "claude-4.6-sonnet-medium-thinking",
      "claude-opus-4-7-low",
      "claude-opus-4-7-low-fast",
      "claude-opus-4-7-medium",
      "claude-opus-4-7-medium-fast",
      "claude-opus-4-7-high",
      "claude-opus-4-7-high-fast",
      "claude-opus-4-7-xhigh",
      "claude-opus-4-7-xhigh-fast",
      "claude-opus-4-7-max",
      "claude-opus-4-7-max-fast",
      "claude-opus-4-7-thinking-low",
      "claude-opus-4-7-thinking-low-fast",
      "claude-opus-4-7-thinking-medium",
      "claude-opus-4-7-thinking-medium-fast",
      "claude-opus-4-7-thinking-high",
      "claude-opus-4-7-thinking-high-fast",
      "claude-opus-4-7-thinking-xhigh",
      "claude-opus-4-7-thinking-xhigh-fast",
      "claude-opus-4-7-thinking-max",
      "claude-opus-4-7-thinking-max-fast",
      "gpt-5.4-low",
      "gpt-5.4-medium",
      "gpt-5.4-medium-fast",
      "gpt-5.4-high",
      "gpt-5.4-high-fast",
      "gpt-5.4-xhigh",
      "gpt-5.4-xhigh-fast",
      "claude-4.6-opus-high",
      "claude-4.6-opus-max",
      "claude-4.6-opus-high-thinking",
      "claude-4.6-opus-max-thinking",
      "claude-4.5-opus-high",
      "claude-4.5-opus-high-thinking",
      "gpt-5.2-low",
      "gpt-5.2-low-fast",
      "gpt-5.2-fast",
      "gpt-5.2-high",
      "gpt-5.2-high-fast",
      "gpt-5.2-xhigh",
      "gpt-5.2-xhigh-fast",
      "gpt-5.6-luna-none",
      "gpt-5.6-luna-none-fast",
      "gpt-5.6-luna-low",
      "gpt-5.6-luna-low-fast",
      "gpt-5.6-luna-medium",
      "gpt-5.6-luna-medium-fast",
      "gpt-5.6-luna-high-fast",
      "gpt-5.6-luna-xhigh",
      "gpt-5.6-luna-xhigh-fast",
      "gpt-5.6-luna-max",
      "gpt-5.6-luna-max-fast",
      "gemini-3.6-flash-minimal",
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.1-pro",
      "gpt-5.4-mini-none",
      "gpt-5.4-mini-low",
      "gpt-5.4-mini-medium",
      "gpt-5.4-mini-high",
      "gpt-5.4-mini-xhigh",
      "gpt-5.4-nano-none",
      "gpt-5.4-nano-low",
      "gpt-5.4-nano-medium",
      "gpt-5.4-nano-high",
      "gpt-5.4-nano-xhigh",
      "claude-4.5-sonnet",
      "claude-4.5-sonnet-thinking",
      "gpt-5.1-low",
      "gpt-5.1",
      "gpt-5.1-high",
      "gemini-3-flash",
      "gemini-3.5-flash",
      "claude-4-sonnet",
      "claude-4-sonnet-thinking",
      "gpt-5-mini",
      "kimi-k3-low",
      "kimi-k3-high",
      "kimi-k3-max",
      "kimi-k2.7-code",
      "glm-5.2-high",
      "glm-5.2-max",
    ],
    aliases: {},
    // Union of hcn effort words offered anywhere; resolution runs through
    // effortSlugs below.
    efforts: ["minimal", "none", "low", "medium", "high", "xhigh", "max"],
    // Stem rows produced by applying the Stem rule to out/models.txt:
    // bare slugs with variants are the medium tier (probes 29/48/49),
    // -extra-high reads as xhigh, each thinking form is its own stem, and
    // -fast twins are not row members (they pin effort by idempotence).
    effortSlugs: {
      "claude-4.5-opus": {
        high: "claude-4.5-opus-high",
      },
      "claude-4.5-opus-thinking": {
        high: "claude-4.5-opus-high-thinking",
      },
      "claude-4.6-opus": {
        high: "claude-4.6-opus-high",
        max: "claude-4.6-opus-max",
      },
      "claude-4.6-opus-thinking": {
        high: "claude-4.6-opus-high-thinking",
        max: "claude-4.6-opus-max-thinking",
      },
      "claude-4.6-sonnet": {
        medium: "claude-4.6-sonnet-medium",
      },
      "claude-4.6-sonnet-thinking": {
        medium: "claude-4.6-sonnet-medium-thinking",
      },
      "claude-fable-5": {
        low: "claude-fable-5-low",
        medium: "claude-fable-5-medium",
        high: "claude-fable-5-high",
        xhigh: "claude-fable-5-xhigh",
        max: "claude-fable-5-max",
      },
      "claude-fable-5-1": {
        low: "claude-fable-5-1-low",
        medium: "claude-fable-5-1-medium",
        high: "claude-fable-5-1-high",
        xhigh: "claude-fable-5-1-xhigh",
        max: "claude-fable-5-1-max",
      },
      "claude-fable-5-1-thinking": {
        low: "claude-fable-5-1-thinking-low",
        medium: "claude-fable-5-1-thinking-medium",
        high: "claude-fable-5-1-thinking-high",
        xhigh: "claude-fable-5-1-thinking-xhigh",
        max: "claude-fable-5-1-thinking-max",
      },
      "claude-fable-5-thinking": {
        low: "claude-fable-5-thinking-low",
        medium: "claude-fable-5-thinking-medium",
        high: "claude-fable-5-thinking-high",
        xhigh: "claude-fable-5-thinking-xhigh",
        max: "claude-fable-5-thinking-max",
      },
      "claude-opus-4-7": {
        low: "claude-opus-4-7-low",
        medium: "claude-opus-4-7-medium",
        high: "claude-opus-4-7-high",
        xhigh: "claude-opus-4-7-xhigh",
        max: "claude-opus-4-7-max",
      },
      "claude-opus-4-7-thinking": {
        low: "claude-opus-4-7-thinking-low",
        medium: "claude-opus-4-7-thinking-medium",
        high: "claude-opus-4-7-thinking-high",
        xhigh: "claude-opus-4-7-thinking-xhigh",
        max: "claude-opus-4-7-thinking-max",
      },
      "claude-opus-4-8": {
        low: "claude-opus-4-8-low",
        medium: "claude-opus-4-8-medium",
        high: "claude-opus-4-8-high",
        xhigh: "claude-opus-4-8-xhigh",
        max: "claude-opus-4-8-max",
      },
      "claude-opus-4-8-thinking": {
        low: "claude-opus-4-8-thinking-low",
        medium: "claude-opus-4-8-thinking-medium",
        high: "claude-opus-4-8-thinking-high",
        xhigh: "claude-opus-4-8-thinking-xhigh",
        max: "claude-opus-4-8-thinking-max",
      },
      "claude-opus-5": {
        low: "claude-opus-5-low",
        medium: "claude-opus-5-medium",
        high: "claude-opus-5-high",
      },
      "claude-opus-5-thinking": {
        low: "claude-opus-5-thinking-low",
        medium: "claude-opus-5-thinking-medium",
        high: "claude-opus-5-thinking-high",
        xhigh: "claude-opus-5-thinking-xhigh",
        max: "claude-opus-5-thinking-max",
      },
      "claude-sonnet-5": {
        low: "claude-sonnet-5-low",
        medium: "claude-sonnet-5-medium",
        high: "claude-sonnet-5-high",
        xhigh: "claude-sonnet-5-xhigh",
        max: "claude-sonnet-5-max",
      },
      "claude-sonnet-5-thinking": {
        low: "claude-sonnet-5-thinking-low",
        medium: "claude-sonnet-5-thinking-medium",
        high: "claude-sonnet-5-thinking-high",
        xhigh: "claude-sonnet-5-thinking-xhigh",
        max: "claude-sonnet-5-thinking-max",
      },
      "cursor-grok-4.5": {
        low: "cursor-grok-4.5-low",
        medium: "cursor-grok-4.5-medium",
        high: "cursor-grok-4.5-high",
      },
      "cursor-grok-4.6": {
        low: "cursor-grok-4.6-low",
        medium: "cursor-grok-4.6-medium",
        high: "cursor-grok-4.6-high",
        xhigh: "cursor-grok-4.6-xhigh",
      },
      "gemini-3.6-flash": {
        minimal: "gemini-3.6-flash-minimal",
        low: "gemini-3.6-flash-low",
        medium: "gemini-3.6-flash-medium",
        high: "gemini-3.6-flash-high",
      },
      "gemini-3.7-flash": {
        low: "gemini-3.7-flash-low",
        medium: "gemini-3.7-flash-medium",
        high: "gemini-3.7-flash-high",
      },
      "gemini-3.8-flash": {
        low: "gemini-3.8-flash-low",
        medium: "gemini-3.8-flash-medium",
        high: "gemini-3.8-flash-high",
      },
      "glm-5.2": {
        high: "glm-5.2-high",
        max: "glm-5.2-max",
      },
      "gpt-5.1": {
        low: "gpt-5.1-low",
        medium: "gpt-5.1",
        high: "gpt-5.1-high",
      },
      "gpt-5.2": {
        low: "gpt-5.2-low",
        medium: "gpt-5.2",
        high: "gpt-5.2-high",
        xhigh: "gpt-5.2-xhigh",
      },
      "gpt-5.3-codex": {
        low: "gpt-5.3-codex-low",
        medium: "gpt-5.3-codex",
        high: "gpt-5.3-codex-high",
        xhigh: "gpt-5.3-codex-xhigh",
      },
      "gpt-5.4": {
        low: "gpt-5.4-low",
        medium: "gpt-5.4-medium",
        high: "gpt-5.4-high",
        xhigh: "gpt-5.4-xhigh",
      },
      "gpt-5.4-mini": {
        none: "gpt-5.4-mini-none",
        low: "gpt-5.4-mini-low",
        medium: "gpt-5.4-mini-medium",
        high: "gpt-5.4-mini-high",
        xhigh: "gpt-5.4-mini-xhigh",
      },
      "gpt-5.4-nano": {
        none: "gpt-5.4-nano-none",
        low: "gpt-5.4-nano-low",
        medium: "gpt-5.4-nano-medium",
        high: "gpt-5.4-nano-high",
        xhigh: "gpt-5.4-nano-xhigh",
      },
      "gpt-5.5": {
        none: "gpt-5.5-none",
        low: "gpt-5.5-low",
        medium: "gpt-5.5-medium",
        high: "gpt-5.5-high",
        xhigh: "gpt-5.5-extra-high",
      },
      "gpt-5.6-luna": {
        none: "gpt-5.6-luna-none",
        low: "gpt-5.6-luna-low",
        medium: "gpt-5.6-luna-medium",
        high: "gpt-5.6-luna-high",
        xhigh: "gpt-5.6-luna-xhigh",
        max: "gpt-5.6-luna-max",
      },
      "gpt-5.6-sol": {
        none: "gpt-5.6-sol-none",
        low: "gpt-5.6-sol-low",
        medium: "gpt-5.6-sol-medium",
        high: "gpt-5.6-sol-high",
        xhigh: "gpt-5.6-sol-xhigh",
        max: "gpt-5.6-sol-max",
      },
      "gpt-5.6-terra": {
        none: "gpt-5.6-terra-none",
        low: "gpt-5.6-terra-low",
        medium: "gpt-5.6-terra-medium",
        high: "gpt-5.6-terra-high",
        xhigh: "gpt-5.6-terra-xhigh",
        max: "gpt-5.6-terra-max",
      },
      "kimi-k3": {
        low: "kimi-k3-low",
        high: "kimi-k3-high",
        max: "kimi-k3-max",
      },
      "muse-spark-1.3": {
        minimal: "muse-spark-1.3-minimal",
        low: "muse-spark-1.3-low",
        medium: "muse-spark-1.3-medium",
        high: "muse-spark-1.3-high",
        xhigh: "muse-spark-1.3-xhigh",
        max: "muse-spark-1.3-max",
      },
    },
    // Unknown slugs are refused pre-flight with the full slug list on
    // stderr (probe 26).
    extensible: false,
  },
  store: {
    // chats/<md5-of-cwd>: md5 over the UTF-8 bytes of the physical
    // absolute cwd, no trailing slash (probes 30, 36-38, 44-46). Vectors:
    // ws-main files as 6fd4032ededd13cf85abaa78342f2203, and ws-café
    // (UTF-8 realpath) as 4fe2ebd9c22e4f5f59adc829aef37279. A --workspace
    // trailing slash normalizes to the same md5 (probe 38).
    template: "{root}/chats/{cwdSlug}",
    cwdSlug: "md5-hex",
    // CURSOR_CONFIG_DIR wins over XDG_CONFIG_HOME (probe 44); with neither
    // set the store lives under {home}/.cursor (probe 45). Set-but-empty
    // counts as unset (probe 53); relative values resolve against the cwd
    // (probe 54).
    rootEnv: [
      { name: "CURSOR_CONFIG_DIR", suffix: "" },
      { name: "XDG_CONFIG_HOME", suffix: "cursor" },
    ],
    defaultRoot: "{home}/.cursor",
  },
  // The `preCompact` hook declares `context_usage_percent`, `context_tokens`
  // and `context_window_size`, and the harness reports all three as `0` on
  // every automatic compaction (11/11 captures, both 2026.09.15-d2fe57e and
  // 2026.09.18-9a7762b; docs/research/2026-09-22-compaction-signals/cursor).
  // The occupancy triple is dead, and the `message_count` /
  // `messages_to_compact` fields that ARE populated are a per-compaction
  // notification, not a usage readout. No occupancy readout exists to
  // inspect.
  contextInspection: null,
  // Automatic compaction observed live in headless-turn, 11 times on
  // 2026-09-22 against this anchor version, with one cross-version replication
  // on the auto-updated 2026.09.18-9a7762b
  // (docs/research/2026-09-22-compaction-signals/cursor). The stream itself
  // carries no compaction record - the print-mode emitter has no such code
  // path - so this is a curated fact, not a decoded signal. result.usage token
  // counts exist (probe 10) but no window size is known, and the harness
  // reports it as 0, so no usedPct can be computed.
  nativeContextManagement: { kind: "auto-compaction", modes: ["headless-turn"] },
  // `-p --continue` resumes the most recently touched session (probe 22;
  // observed on 2026.09.15-d2fe57e, 2026-09-17). RFC-06 Phase 5 renders headless after RFC-05
  // landed (merge to main).
  // Cursor compacts automatically - 11 times on the anchor version - and
  // emits nothing on stream-json stdout for it. Null, so a caller knows
  // silence here is absence of reporting, not absence of compaction.
  compactionReporting: null,
  resumeLast: {
    flag: "--continue",
    headless: true,
    warning:
      "hcn: --resume-last resumes the most-recent cursor session in {cwd}; the most recent session may be a killed, failed, or unrelated run's session; cursor errors with exit 1 when no session is resumable, and the same error means the store root resolved away from the session; a run from inside a live cursor session in the same directory re-enters that session",
  },
  // A positional prompt plus open stdin emits `result` then never exits,
  // so stdin is closed at spawn (notes 07).
  stdin: "close-required",
  presence: {
    headlessMarkers: ["-p"],
  },
  capabilities: {
    // No image or vision surface was probed; curated claims stay
    // conservative (false until observed).
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
  // smoke:questions on 2026.09.15-d2fe57e showed the block (the model
  // asked which environment to write, and the turn ended awaiting-input);
  // test/fixtures/cursor-2026.09.15-d2fe57e/questions.snapshot.json.
  escalation: {
    supported: true,
    observedOn: { harness: "cursor", model: "", version: "2026.09.15-d2fe57e", date: "2026-09-17" },
  },
  turnOptions: {
    // No effort flag exists on cursor: effort resolves into the --model
    // slug via effortSlugs. No other turn option is expressed in v1, and
    // no sandbox spelling confines headless (probes 60-61, 70-71), so an
    // explicit --sandbox refuses unsupported-option.
    effort: { kind: "effort-in-model", render: { kind: "in-model" } },
  },
  // No per-skill CLI surface (config trust scoping only).
  skills: null,
  tools: {
    // Allow/deny lists live in config files only (default allow Shell(ls)
    // observed); hcn can neither grant nor deny per call, so --tools
    // refuses instead of pretending.
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    builtins: [],
    categories: [],
    denySemantics: "no-lists",
  },
});
