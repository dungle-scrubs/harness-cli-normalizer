/**
 * Antigravity CLI descriptor. Current Google documentation and authenticated
 * probes establish the argv, stream, permission, session, resume, model, and
 * escalation contracts. The anchor is 1.2.8: the capability tripwires, the
 * escalation probe and the compaction observation were run against that
 * binary (test/fixtures/antigravity-1.2.8). The permission, sandbox, store
 * and validation corpus behind the remaining claims was captured on 1.2.7
 * (test/fixtures/antigravity-1.2.7) and still stands.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { ANTIGRAVITY_TRANSCRIPT } from "./transcript/antigravity.js";

export const antigravityCli: HarnessDescriptor = deepFreeze({
  name: "antigravity",
  transcript: ANTIGRAVITY_TRANSCRIPT,
  bin: "agy",
  verifiedAgainst: "1.2.8",
  // The installed signed binary supplied the qualified version anchor.
  versionSource: { kind: "installed" },
  launch: {
    // --print consumes the immediately following positional prompt. Keep
    // stream flags after the prompt through the shared builder.
    baseFlags: ["--print"],
    subcommands: [],
    promptStyle: "positional",
    passthrough: "after-argv",
    streamFlags: ["--output-format", "stream-json"],
    idFlag: null,
  },
  resume: {
    style: "flag",
    flag: "--conversation",
    aliases: [],
    idShape: UUID_SHAPE,
    onMissing: "unknown",
    extraFlags: ["--print"],
  },
  sessionMode: {
    flags: ["--input-format", "stream-json", "--output-format", "stream-json"],
    idFlag: null,
    resumeFlag: "--conversation",
    input: { kind: "antigravity-stream-user" },
    turnEnd: { event: "result" },
    identityProbe: null,
  },
  output: {
    pins: [{ flags: ["--output-format", "stream-json"], granularity: "token" }],
    floor: "none",
    flagAliases: {},
  },
  identity: {
    authority: "harness-minted",
    announce: { match: { event: "init" }, idField: "conversation_id" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [
    { pattern: "authentication required", flags: "i", kind: "not-logged-in" },
    { pattern: "sign in", flags: "i", kind: "not-logged-in" },
    ...SHARED_AUTH_MATCHERS,
  ],
  autonomy: { flag: "--dangerously-skip-permissions" },
  vocabulary: {
    modelFlag: "--model",
    // Captured from `agy models` on the free Individual plan. Runtime
    // configuration and plan eligibility keep the selector open.
    models: [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ],
    aliases: {},
    efforts: ["low", "medium", "high"],
    extensible: true,
  },
  store: {
    template:
      "{home}/.gemini/antigravity-cli/brain/{sessionId}/.system_generated/logs/transcript.jsonl",
    cwdSlug: "verbatim",
  },
  // No headless occupancy readout exists. `/context` opens the interactive
  // context panel and is refused in print mode with a purpose-built error
  // (observed 2026-09-22 on 1.2.8), and no other command or stream field
  // reports a window size, a percentage or a remaining budget.
  contextInspection: null,
  // Native auto-compaction, observed live on 1.2.8, 2026-09-22
  // (docs/research/2026-09-22-compaction-signals/antigravity): four
  // compactions inside one 8-turn `--input-format stream-json` session, so
  // headless-session is evidenced. headless-turn is not claimed - a one-shot
  // turn has no second request to shrink, and none was probed.
  //
  // The stream says nothing while it runs and one bare record afterwards: a
  // `step_update` with `step_type: "checkpoint"`, `state: "DONE"` and a
  // `duration_seconds` that measures the pause (4.5 to 18 s observed). There
  // is no ACTIVE phase, no summary, no reason and no token count on it - the
  // summary is written to the brain store instead. hcn's antigravity reader
  // drops the record today; reporting it upward is ADR 0009's work, not this
  // descriptor's. 1.2.8 is also the release that resized the compaction
  // budgets from the model's full window, so these facts are anchored to
  // 1.2.8 and must not be read back onto 1.2.7.
  nativeContextManagement: { kind: "auto-compaction", modes: ["headless-session"] },
  // One `checkpoint` step in state DONE, carrying a duration and nothing
  // else: no start phase, no reason, and no token counts at all.
  compactionReporting: { source: "stream", states: ["compacted"], tokens: false },
  resumeLast: {
    flag: "--continue",
    headless: true,
    flagPlacement: "before-extra-flags",
    warning:
      "hcn: --resume-last resumes Antigravity CLI's most-recent conversation for {cwd}; the cached conversation may be failed or unrelated, and Antigravity starts a fresh conversation when its workspace cache is missing or stale",
  },
  // One-shot prompts travel in argv. Closing stdin keeps a missing-login
  // OAuth flow from waiting for an authorization code in an unattended run.
  stdin: "close-required",
  presence: { headlessMarkers: ["--print", "-p"] },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "token",
      interactive: "none",
    },
    session: true,
  },
  escalation: {
    supported: true,
    observedOn: {
      harness: "antigravity",
      model: "gemini-3.8-flash-medium",
      version: "1.2.8",
      date: "2026-09-22",
    },
  },
  turnOptions: {
    effort: {
      kind: "effort",
      argvPlacement: "after-prompt",
      render: { kind: "flag-value", flag: "--effort" },
    },
    // Antigravity exposes one boolean sandbox switch. workspace-write is
    // the only normalized HCN value that maps to the documented workspace
    // and temporary-directory boundary without inventing extra modes.
    sandbox: {
      kind: "enum",
      argvPlacement: "after-prompt",
      values: ["workspace-write"],
      render: { kind: "flag-list", flags: ["--sandbox"] },
    },
  },
  skills: null,
  tools: {
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    builtins: [],
    categories: [],
    denySemantics: "policy-gate",
  },
});
