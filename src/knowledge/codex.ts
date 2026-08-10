/**
 * The codex descriptor: facts about the `codex` CLI as data, ported from
 * lucid v1's registry and harness-store knowledge. Descriptor groundwork
 * only (D-003): not exercised through the chat protocol until the claude
 * vertical slice is green.
 */
import type { HarnessDescriptor } from "./descriptor.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const codexCli: HarnessDescriptor = {
  name: "codex",
  bin: "codex",
  launch: {
    // exec --json emits structured item events; without --json, identity
    // discovery is blind (v1: requiredArgument "--json").
    baseFlags: ["exec", "--json"],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
  },
  resume: {
    // `codex exec resume <id>` - the resume word is positional, after the
    // exec subcommand (v1 anchor: \bresume\s+<uuid>).
    style: "positional",
    flag: "resume",
    aliases: [],
    idShape: UUID_SHAPE,
  },
  sessionMode: null,
  output: {
    // Codex has no token-delta mode: exec --json emits item-level events,
    // so message granularity is the ceiling and there is no pin to satisfy.
    tokenFlagSet: [],
    fallback: "message",
    flagAliases: {},
  },
  identity: {
    // Codex mints its own thread id and announces it on stdout-jsonl.
    authority: "harness-minted",
    announce: { match: { type: "thread.started" }, idField: "thread_id" },
  },
  limitMatchers: [
    // codex: "You've hit your usage limit. ... try again at Jul 29th ..."
    [/you'?ve hit your usage limit/i, "usage-limit"],
    [/usage limit (?:reached|exceeded)/i, "usage-limit"],
    [/purchase more credits|insufficient credits|out of credits/i, "credits"],
  ],
  authMatchers: [
    [/run codex login/i, "not-logged-in"],
    [/401 unauthorized/i, "expired"],
  ],
  autonomy: { flag: "--yolo" },
  vocabulary: {
    modelFlag: "--model",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    aliases: {},
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    // Reasoning effort is a config key (-c model_reasoning_effort=...), not
    // a plain flag; argv-level insertion has no spelling to use.
    effortFlag: null,
    extensible: false,
  },
  store: {
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<threadId>.jsonl - the
    // date/stamp components need a store scan, so the template names the
    // sessions root; the execution layer resolves the rollout file.
    template: "{home}/.codex/sessions",
    cwdSlug: "verbatim",
  },
  contextHook: null,
  resumeLast: { flag: "--last" },
  provider: null,
  stdin: "inherit",
  discoveryDisableFlags: [],
  presence: {
    headlessMarkers: ["exec"],
  },
  capabilities: {
    vision: true,
    images: true,
    streamingByMode: {
      "headless-turn": "message",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
};
