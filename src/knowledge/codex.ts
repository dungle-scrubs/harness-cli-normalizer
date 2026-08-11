/**
 * The codex descriptor: facts about the `codex` CLI as data, verified
 * against codex-cli 0.147.0 and lucid v1's registry. Descriptor groundwork
 * only (D-003): not exercised through the chat protocol until the claude
 * vertical slice is green.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

export const codexCli: HarnessDescriptor = deepFreeze({
  name: "codex",
  bin: "codex",
  launch: {
    // exec --json emits structured item events; without --json, identity
    // discovery is blind (v1: requiredArgument "--json"). The sandbox grant
    // is v1's proven spawn shape - codex's built-in default is read-only,
    // under which a non-autonomy turn cannot write files.
    // --skip-git-repo-check: codex exec refuses to run outside a trusted
    // git dir without it (verified 0.147.0). cwd targeting is the spawner's
    // job (spawn opts.cwd), not descriptor data.
    baseFlags: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"],
    subcommands: ["exec"],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
    // Codex mints its own thread id; there is nothing to assign at launch.
    idFlag: null,
  },
  resume: {
    // `codex exec resume <id> [--json] <prompt>` - the resume word is a
    // subcommand of exec (verified: `codex exec resume --help`).
    style: "positional",
    flag: "resume",
    aliases: [],
    idShape: UUID_SHAPE,
    onMissing: "error",
    // `codex exec resume` accepts --json and --skip-git-repo-check but
    // REJECTS --sandbox (verified 0.147.0: "unexpected argument").
    extraFlags: ["--json", "--skip-git-repo-check"],
  },
  sessionMode: null,
  output: {
    // exec --json emits item-level events (message granularity); a bare
    // exec emits nothing structured at all.
    pins: [{ flags: ["--json"], granularity: "message" }],
    floor: "none",
    flagAliases: {},
  },
  identity: {
    // Codex mints its own thread id and announces it on stdout-jsonl.
    authority: "harness-minted",
    announce: { match: { type: "thread.started" }, idField: "thread_id" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [[/run codex login/i, "not-logged-in"], ...SHARED_AUTH_MATCHERS],
  // Accepted by codex 0.147.0 as a hidden alias (not in --help).
  autonomy: { flag: "--yolo" },
  vocabulary: {
    modelFlag: "--model",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    aliases: {},
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    // Codex constrains ladders per model generation (v1 registry).
    effortsByModel: {
      "gpt-5.5": ["minimal", "low", "medium", "high"],
      "gpt-5.6-sol": ["medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-terra": ["medium", "high", "xhigh", "max", "ultra"],
      "gpt-5.6-luna": ["medium", "high", "xhigh", "max", "ultra"],
    },
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
  // Valid only in the `exec resume` context: `codex exec resume --last`.
  resumeLast: { flag: "--last" },
  provider: null,
  // codex exec appends piped stdin as a <stdin> block and can block on an
  // open stdin - close it (verified 0.147.0: "Reading additional input
  // from stdin...").
  stdin: "close-required",
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
});
