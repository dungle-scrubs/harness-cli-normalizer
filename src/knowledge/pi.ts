/**
 * The pi descriptor: facts about the `pi` CLI as data, verified against
 * pi 0.84.1. Descriptor groundwork only (D-003). The load-bearing scars:
 * pi reads stdin even in -p mode (a backgrounded call without `< /dev/null`
 * hangs forever), it auto-discovers instruction files/skills/extensions
 * unless disabled, and its model registry is runtime-extensible (D-008) -
 * the curated list here is a baseline, never a refusal authority.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

export const piCli: HarnessDescriptor = deepFreeze({
  name: "pi",
  bin: "pi",
  verifiedAgainst: "0.84.1",
  launch: {
    // -p --mode json: bare -p prints plain text; --mode json emits the
    // structured v3 records the runner decodes (verified 0.84.1).
    baseFlags: ["-p", "--mode", "json"],
    subcommands: [],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
    idFlag: "--session-id",
  },
  resume: {
    // Caller-assigned: the same --session-id re-enters the session. Resume
    // carries the same structured-output flags launch does, or a resumed
    // turn would stream plain text the runner cannot decode.
    style: "flag",
    flag: "--session-id",
    aliases: [],
    idShape: UUID_SHAPE,
    onMissing: "create",
    extraFlags: ["-p", "--mode", "json"],
  },
  // --mode rpc exists on 0.84.1 but its session semantics are unverified
  // against a live run; per the truthfulness rule it stays null until a
  // spike proves the contract (the claude slice is the proven vertical -
  // D-003).
  sessionMode: null,
  output: {
    // pi -p prints plain text; --mode json emits structured v3 records
    // INCLUDING assistantMessageEvent text_delta tokens (verified 0.84.1),
    // so this invocation is token-granular, not merely message.
    pins: [{ flags: ["--mode", "json"], granularity: "token" }],
    floor: "none",
    flagAliases: {},
  },
  identity: {
    authority: "caller-assigned",
    // The v3 session record header: {"type":"session","version":3,"id":...}
    // - the field is `id`, observed in real transcripts under ~/.pi/sessions.
    announce: { match: { type: "session" }, idField: "id" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [...SHARED_AUTH_MATCHERS],
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
    // Verified on pi 0.84.1: ~/.pi/sessions/<slug>/<ISO-stamp>_<uuid>.jsonl
    // where the slug is the cwd dash-flattened and dash-wrapped, dots
    // preserved (--Users-kevin-dev-x--). The stamp needs a store scan, so
    // the template names the per-cwd directory.
    template: "{home}/.pi/sessions/{cwdSlug}",
    cwdSlug: "pi-dash-wrapped",
  },
  contextHook: null,
  resumeLast: null,
  provider: { flag: "--provider" },
  stdin: "close-required",
  discoveryDisableFlags: ["-nt", "-nc", "-ne", "-ns"],
  presence: {
    headlessMarkers: ["-p", "--print"],
  },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
});
