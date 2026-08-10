/**
 * The pi descriptor: facts about the `pi` CLI as data. Descriptor
 * groundwork only (D-003). The load-bearing scars: pi reads stdin even in
 * -p mode (a backgrounded call without `< /dev/null` hangs forever), it
 * auto-discovers instruction files/skills/extensions unless disabled, and
 * its model registry is runtime-extensible (D-008) - the curated list here
 * is a baseline, never a refusal authority.
 */
import type { HarnessDescriptor } from "./descriptor.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const piCli: HarnessDescriptor = {
  name: "pi",
  bin: "pi",
  launch: {
    baseFlags: ["-p"],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
  },
  resume: {
    // Caller-assigned: the same --session-id re-enters the session.
    style: "flag",
    flag: "--session-id",
    aliases: [],
    idShape: UUID_SHAPE,
  },
  // An RPC session mode reportedly exists but is unverified against a live
  // pi; per the truthfulness rule it stays null until a spike proves the
  // flag set (the claude slice is the proven vertical anyway - D-003).
  sessionMode: null,
  output: {
    tokenFlagSet: [],
    fallback: "none",
    flagAliases: {},
  },
  identity: {
    authority: "caller-assigned",
    announce: { match: { type: "session" }, idField: "session_id" },
  },
  limitMatchers: [
    // google-family (pi's default provider) quota errors
    [/resource_exhausted|quota exceeded|exceeded your current quota/i, "quota"],
    [/usage limit (?:reached|exceeded)/i, "usage-limit"],
  ],
  authMatchers: [],
  autonomy: null,
  vocabulary: {
    modelFlag: "--model",
    models: ["zai/glm-5.2"],
    aliases: {},
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    effortFlag: "--thinking",
    // D-008: providers register models at runtime (~/.pi/models.json), so
    // the vocabulary is open - validation accepts clean unknown selectors
    // and capability claims degrade to unknown instead.
    extensible: true,
  },
  store: {
    template: "{home}/.pi/agent/sessions",
    cwdSlug: "verbatim",
  },
  contextHook: null,
  resumeLast: null,
  provider: { flag: "--provider" },
  stdin: "close-required",
  discoveryDisableFlags: ["-nt", "-nc", "-ne", "-ns"],
  presence: {
    headlessMarkers: ["-p"],
  },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "none",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
};
