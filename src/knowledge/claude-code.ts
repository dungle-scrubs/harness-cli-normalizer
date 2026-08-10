/**
 * The claude-code descriptor: facts about the `claude` CLI as data, verified
 * against claude 2.1.226 and the 00-chat-substrate spike evidence (A-001,
 * A-002, A-005). No process logic lives here.
 */
import type { HarnessDescriptor } from "./descriptor.js";

export const claudeCode: HarnessDescriptor = {
  name: "claude",
  bin: "claude",
  launch: {
    baseFlags: ["-p"],
    promptStyle: "positional",
    toolsFlag: "--allowedTools",
  },
  resume: {
    // A-005: claude resumes are id-stable - the caller-assigned id survives
    // every resume, so there is no rotation handling and forking is only the
    // explicit --fork-session flag (deliberate branching, never a default).
    style: "flag",
    flag: "--resume",
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
    tokenFlagSet: ["--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    fallback: "none",
  },
  identity: {
    authority: "caller-assigned",
    announce: { type: "system", subtype: "init", idField: "session_id" },
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
  },
  store: {
    // Verified against the A-001 fixture's memory_paths slug:
    // /Users/kevin/dev/lucid-v2/spikes -> -Users-kevin-dev-lucid-v2-spikes
    template: "{home}/.claude/projects/{cwdSlug}/{sessionId}.jsonl",
    cwdSlug: "dash-separators",
  },
  contextHook: {
    // claude statusline payload: { context_window: { used_percentage } }
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
};
