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
    models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    aliases: {},
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    // Codex constrains ladders per model generation (v1 registry).
    effortsByModel: {
      // https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-06).
      "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
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
  contextInspection: null,
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
  // Escalation provenance transcribed from test/fixtures/phase7-questions/,
  // committed 2026-08-19. `model` is empty because no fixture on that stream
  // records a model id - absence of evidence, not an unset field.
  escalation: {
    supported: true,
    observedOn: { harness: "codex", model: "", version: "0.146.1", date: "2026-08-19" },
  },
  turnOptions: {
    // Codex config reference; accepted as an integer on CLI 0.153.4.
    // Native compaction uses this window; hcn does not count request tokens.
    contextWindow: {
      kind: "integer",
      min: 1,
      max: 272000,
      render: { kind: "config-kv", flag: "-c", key: "model_context_window" },
    },
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
      // Spike A-001, resolved 2026-08-23 on 0.147.0 (issue #72): `codex exec
      // resume` still rejects --sandbox, but `-c sandbox_mode=<mode>` on the
      // resume grammar is ENFORCED, not merely accepted. A thread that wrote
      // a file under workspace-write was resumed under -c sandbox_mode=
      // "read-only" and could not write (model reported BLOCKED, no file);
      // the same thread resumed under workspace-write wrote again. So the
      // sandbox dimension is expressible on resume through the config-kv
      // spelling, and a resumed turn no longer silently runs wider than the
      // caller asked.
      resumeRender: { kind: "config-kv", flag: "-c", key: "sandbox_mode" },
    },
    // The preset maps onto the sandbox dimension and therefore CLAIMS it:
    // an explicit --sandbox alongside --access refuses, and the profile's
    // sandbox default yields. Data here, not a harness-name branch.
    // On resume the preset rides the same config-kv spelling the sandbox
    // dimension uses (issue #72 evidence above): `codex exec resume`
    // rejects --sandbox, and -c sandbox_mode is enforced there.
    access: {
      kind: "access",
      claims: "sandbox",
      renders: {
        read: {
          render: { kind: "flag-value", flag: "--sandbox" },
          resumeRender: { kind: "config-kv", flag: "-c", key: "sandbox_mode" },
          value: "read-only",
        },
        write: {
          render: { kind: "flag-value", flag: "--sandbox" },
          resumeRender: { kind: "config-kv", flag: "-c", key: "sandbox_mode" },
          value: "workspace-write",
        },
      },
    },
  },
  // Tools: no built-in name lists; control is feature booleans
  // (reachable per-call via -c key=value), sandbox, and approval policy.
  // MCP servers do have per-tool keys (mcp_servers.<id>.tools.<tool>)
  // but built-ins do not.
  // Skills (verified 2026-08-22, codex 0.147.0, --strict-config probes):
  // per-skill disable via config-kv array -c skills.config=[{path=...,
  // enabled=false}] (selector path or name, validated per entry); also
  // -c skills.bundled.enabled=false. No global skills.enabled switch.
  skills: { loadFlag: null, overridesVia: "config-skills-array" },
  tools: {
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    builtins: [],
    categories: [
      { key: "shell", disableFlag: null, configKey: "features.shell_tool", canonical: [] },
      { key: "exec", disableFlag: null, configKey: "features.unified_exec", canonical: [] },
      { key: "web", disableFlag: null, configKey: "web_search", canonical: [] },
      { key: "view-image", disableFlag: null, configKey: "tools.view_image", canonical: [] },
    ],
    denySemantics: "no-lists",
  },
});
