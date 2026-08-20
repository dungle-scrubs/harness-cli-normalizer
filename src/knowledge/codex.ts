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
  verifiedAgainst: "0.147.0",
  versionSource: { kind: "npm", package: "@openai/codex" },
  launch: {
    // exec --json emits structured item events; without --json, identity
    // discovery is blind (v1: requiredArgument "--json").
    // --skip-git-repo-check: codex exec refuses to run outside a trusted
    // git dir without it (verified 0.147.0). cwd targeting is the spawner's
    // job (spawn opts.cwd), not descriptor data.
    // Sandbox is now per-call via turnOptions.sandbox with default
    // workspace-write, not a hardcoded base flag.
    baseFlags: ["exec", "--json", "--skip-git-repo-check"],
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
  authMatchers: [
    { pattern: "run codex login", flags: "i", kind: "not-logged-in" },
    ...SHARED_AUTH_MATCHERS,
  ],
  // Accepted by codex 0.147.0 as a hidden alias (not in --help).
  autonomy: { flag: "--yolo" },
  vocabulary: {
    modelFlag: "--model",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    aliases: {},
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    // Codex constrains ladders per model generation (v1 registry).
    effortsByModel: {
      "gpt-5.5": ["minimal", "low", "medium", "high"],
      "gpt-5.6-sol": ["medium", "high", "xhigh", "max"],
      "gpt-5.6-terra": ["medium", "high", "xhigh", "max"],
      "gpt-5.6-luna": ["medium", "high", "xhigh", "max"],
    },
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
  // codex exec appends piped stdin as a <stdin> block and can block on an
  // open stdin - close it (verified 0.147.0: "Reading additional input
  // from stdin...").
  stdin: "close-required",
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
  turnOptions: {
    effort: {
      kind: "effort",
      render: { kind: "config-kv", flag: "-c", key: "model_reasoning_effort" },
    },
    // issue #48, live-verified 0.146.1 under --strict-config: the config key
    // `instructions` accepts BOTH a literal string (LITERAL-OK probe) and a
    // file path (FILE-OK probe); hcn passes the value verbatim and codex
    // validates. `model_instructions` / `experimental_instructions_file`
    // are refused by codex (probed) - wrong spellings, not alternates.
    systemPrompt: {
      kind: "prompt-text",
      render: { kind: "config-kv", flag: "-c", key: "instructions" },
    },
    sandbox: {
      kind: "enum",
      values: ["read-only", "workspace-write", "danger-full-access"],
      default: "workspace-write",
      render: { kind: "flag-value", flag: "--sandbox" },
      resumeRender: null,
    },
  },
  // Phase 0 fixtures: codex-tool-surface.md. No name lists anywhere -
  // not on the CLI, not in config.toml. Control is feature booleans
  // (reachable per-call via -c key=value / --enable/--disable FEATURE),
  // sandbox, and approval policy. MCP servers do have per-tool keys
  // (mcp_servers.<id>.tools.<tool>) but built-ins do not.
  skills: null,
  tools: {
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    composable: false,
    builtins: [],
    categories: [
      { key: "shell", disableFlag: null, configKey: "features.shell_tool" },
      { key: "exec", disableFlag: null, configKey: "features.unified_exec" },
      { key: "web", disableFlag: null, configKey: "web_search" },
      { key: "view-image", disableFlag: null, configKey: "tools.view_image" },
    ],
    denySemantics: "no-lists",
  },
});
