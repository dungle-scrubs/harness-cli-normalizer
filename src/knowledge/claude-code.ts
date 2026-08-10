/**
 * The claude-code descriptor: facts about the `claude` CLI as data, verified
 * against claude 2.1.226 and the 00-chat-substrate spike evidence (A-001,
 * A-002, A-005). No process logic lives here.
 */
import type { HarnessDescriptor } from "./descriptor.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Descriptors are process-wide defaults shared by reference into merged
 * override sets - freezing makes an accidental in-place edit throw instead
 * of corrupting every consumer. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

export const claudeCode: HarnessDescriptor = deepFreeze({
  name: "claude",
  bin: "claude",
  launch: {
    baseFlags: ["-p"],
    promptStyle: "positional",
    toolsFlag: "--allowedTools",
    // A headless turn launches with the full stream-json output set so the
    // runner can decode identity/limits and stream token deltas; bare -p
    // (granularity none) is a degraded invocation this builder never emits.
    streamFlags: ["--output-format", "stream-json", "--verbose", "--include-partial-messages"],
  },
  resume: {
    // A-005: claude resumes are id-stable - the caller-assigned id survives
    // every resume, so there is no rotation handling and forking is only the
    // explicit --fork-session flag (deliberate branching, never a default).
    style: "flag",
    flag: "--resume",
    aliases: ["-r"],
    idShape: UUID_SHAPE,
  },
  sessionMode: {
    // A-001: one process, many turns; `result` delimits turns; mid-turn sends
    // queue. --setting-sources project isolates the child from user-level
    // hooks (D-025). Token deltas require this exact output flag set.
    flags: [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "project",
    ],
    idFlag: "--session-id",
  },
  output: {
    // --output-format/--include-partial-messages only work with --print, so
    // -p is part of the pin, not an accident of the builders.
    tokenFlagSet: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ],
    fallback: "none",
    flagAliases: { "--print": "-p" },
  },
  identity: {
    authority: "caller-assigned",
    announce: { match: { type: "system", subtype: "init" }, idField: "session_id" },
  },
  limitMatchers: [
    // Observed phrasings from the live CLI (ported from lucid v1's limits.ts):
    // "You've hit your session limit · resets 6:30pm"
    [/you'?ve hit your session limit/i, "session-limit"],
    // "You've hit your weekly limit · resets 2am (Asia/Bangkok)"
    [/you'?ve hit your weekly limit/i, "weekly-limit"],
    [/you'?ve hit your usage limit/i, "usage-limit"],
    [/usage limit (?:reached|exceeded)/i, "usage-limit"],
  ],
  authMatchers: [
    // Ported from lucid v1: a detached process cannot read Keychain creds,
    // and misreading that as "not logged in" sends the human to redo a login
    // that was never broken.
    [/oauth session expired|could not be refreshed/i, "expired"],
    [/failed to authenticate/i, "expired"],
    [/not logged in|please run \/login/i, "not-logged-in"],
    [/invalid api key/i, "invalid-key"],
  ],
  autonomy: { flag: "--dangerously-skip-permissions" },
  vocabulary: {
    modelFlag: "--model",
    models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    aliases: {
      fable: "claude-fable-5",
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5-20251001",
    },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // Effort is an in-session command for claude, not a launch flag.
    effortFlag: null,
  },
  store: {
    // Verified against the A-001 fixture's memory_paths slug and real
    // ~/.claude/projects entries: '/', '.' -> '-'; '_' preserved.
    template: "{home}/.claude/projects/{cwdSlug}/{sessionId}.jsonl",
    cwdSlug: "dash-separators",
  },
  contextHook: {
    // claude statusline payload: { context_window: { used_percentage } }.
    // This arrives on the statusline channel, never on stream-json stdout -
    // route accordingly, do not call per stdout line.
    object: "context_window",
    usedPctField: "used_percentage",
  },
  resumeLast: null,
  provider: null,
  stdin: "inherit",
  // D-025: project-only setting sources is claude's discovery-isolation
  // spelling; the child loads no user-level hooks or skills.
  discoveryDisableFlags: ["--setting-sources", "project"],
  presence: {
    headlessMarkers: ["-p", "--print"],
  },
  capabilities: {
    vision: true,
    images: true,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "token",
      interactive: "message",
    },
    session: true,
  },
});
