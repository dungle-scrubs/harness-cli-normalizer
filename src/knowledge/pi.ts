/**
 * The pi descriptor: facts about the `pi` CLI as data, verified against
 * pi 0.84.2. Descriptor groundwork only (D-003). The load-bearing scars:
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
  verifiedAgainst: "0.84.2",
  versionSource: { kind: "npm", package: "@earendil-works/pi-coding-agent" },
  launch: {
    // -p --mode json: bare -p prints plain text; --mode json emits the
    // structured v3 records the runner decodes (verified 0.84.2; 0.84.2
    // additionally nests a usage object inside message_update alongside
    // assistantMessageEvent - additive, decoder unaffected).
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
  // --mode rpc exists on 0.84.2 and its session semantics are now VERIFIED
  // against a live run (2026-08-19 spike, evidence at
  // test/fixtures/pi-rpc-spike): JSONL both directions, agent_settled
  // delimits turns, steer/follow_up queue mid-run (hcn never needs them -
  // it queues sends itself), identity is silent at startup and readable
  // only via a get_state round trip, stdin EOF exits rc=0. The claude
  // slice remains the proven vertical (D-003); this entry is the second.
  sessionMode: {
    flags: ["--mode", "rpc"],
    // `--session <id>` requires an EXISTING id ("No session found" on a
    // fresh uuid - live-verified); fresh sessions omit it and pi mints
    // the id, readable only through the get_state probe.
    idFlag: null,
    input: { kind: "pi-rpc-prompt" },
    turnEnd: { type: "agent_settled" },
    identityProbe: { command: "get_state" },
  },
  output: {
    // pi -p prints plain text; --mode json emits structured v3 records
    // INCLUDING assistantMessageEvent text_delta tokens (verified 0.84.2),
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
    // D-008: providers register models at runtime (~/.pi/models.json), so
    // the vocabulary is open - validation accepts clean unknown selectors
    // and capability claims degrade to unknown instead.
    extensible: true,
  },
  store: {
    // Verified on pi 0.84.2: ~/.pi/sessions/<slug>/<ISO-stamp>_<uuid>.jsonl
    // where the slug is the cwd dash-flattened and dash-wrapped, dots
    // preserved (--Users-kevin-dev-x--). The stamp needs a store scan, so
    // the template names the per-cwd directory.
    template: "{home}/.pi/sessions/{cwdSlug}",
    cwdSlug: "pi-dash-wrapped",
  },
  contextHook: null,
  resumeLast: null,
  stdin: "close-required",
  presence: {
    headlessMarkers: ["-p", "--print"],
  },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      // rpc mode streams the same assistantMessageEvent deltas json mode
      // does (spike fixture 02: text/thinking deltas under message_update).
      "headless-session": "token",
      interactive: "none",
    },
    session: true,
  },
  turnOptions: {
    effort: { kind: "effort", render: { kind: "flag-value", flag: "--thinking" } },
    provider: { kind: "selector", render: { kind: "flag-value", flag: "--provider" } },
    // issue #48, live-verified 0.84.2: pi's --system-prompt replaces the
    // default coding-assistant prompt (PI-NAKED probe). No dynamic-section
    // exclusion exists - pi injects no such sections into a replaced prompt.
    systemPrompt: {
      kind: "prompt-text",
      render: { kind: "flag-value", flag: "--system-prompt" },
    },
    appendSystemPrompt: {
      kind: "prompt-text",
      render: { kind: "flag-value", flag: "--append-system-prompt" },
    },
    discovery: {
      kind: "discovery",
      facets: {
        tools: {
          polarity: "disables",
          render: { kind: "flag-list", flags: ["-nt"] },
        },
        instructionFiles: {
          polarity: "disables",
          render: { kind: "flag-list", flags: ["-nc"] },
        },
        extensions: {
          polarity: "disables",
          render: { kind: "flag-list", flags: ["-ne"] },
        },
        skills: {
          polarity: "disables",
          render: { kind: "flag-list", flags: ["-ns"] },
        },
      },
    },
  },
  // Phase 0 fixtures: pi-both-tool-flags.md. Both list flags legal at once;
  // exclude subtracts from include. --tools is strict over BUILT-INS but
  // does not strip MCP/extension registrations (additive over them);
  // -nbt (built-ins only off) exists but has no normalized spelling yet.
  skills: { loadFlag: "--skill", overridesVia: null },
  tools: {
    includeFlag: "--tools",
    excludeFlag: "--exclude-tools",
    includeIsStrictAllowlist: true,
    composable: true,
    builtins: [
      { name: "read", defaultEnabled: true },
      { name: "bash", defaultEnabled: true },
      { name: "edit", defaultEnabled: true },
      { name: "write", defaultEnabled: true },
      { name: "grep", defaultEnabled: false },
      { name: "find", defaultEnabled: false },
      { name: "ls", defaultEnabled: false },
    ],
    categories: [],
    denySemantics: "remove-from-set",
  },
});
