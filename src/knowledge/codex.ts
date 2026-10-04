/**
 * The codex descriptor: facts about the `codex` CLI as data, verified
 * against codex-cli 0.160.0. Native capability, question, and compaction
 * recordings live in test/fixtures/codex-0.160.0.
 */
import { deepFreeze, type HarnessDescriptor, type OptionRender, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { CODEX_TRANSCRIPT } from "./transcript/codex.js";

/** Saved native provider selector, verified through exec resume on 0.154.0.
 * Only the verified-settings path uses this render; ordinary --provider stays unsupported. */
export const codexNativeProviderRender: OptionRender = deepFreeze({
  kind: "config-kv",
  flag: "-c",
  key: "model_provider",
});

export const codexCli: HarnessDescriptor = deepFreeze({
  name: "codex",
  transcript: CODEX_TRANSCRIPT,
  bin: "codex",
  verifiedAgainst: "0.160.0",
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
    // Passthrough placement (ADR 0003, probed 2026-09-17 on 0.154.0):
    // appended native flags parse once hcn's bare `--` is gone (an
    // appended `-c model_reasoning_effort="medium"` is accepted; a bogus
    // flag is rejected natively as an unexpected argument - and a repeated
    // `--sandbox` errors "cannot be used multiple times", parsed as a flag,
    // not a positional). The tail renders past hcn's own argv, no separator.
    passthrough: "after-argv",
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
  // Persistent headless session: `codex app-server` (no subcommand) speaks
  // newline-delimited JSON-RPC over stdio (verified live 0.160.0,
  // test/fixtures/codex-0.160.0/session.ndjson). One process serves many turns.
  // The runner writes `initialize` then thread/start (fresh) or
  // thread/resume (resume) at spawn; the response's result.thread.id is
  // the harness-minted session id (equal to the rollout file's session id,
  // so the resume guard's store check binds it). A send maps to
  // turn/start when idle and turn/steer when a turn is running - steer
  // carries expectedTurnId, the tracked active turn id, and fails with a
  // JSON-RPC error when it does not match the currently active turn
  // (verified: -32600 "expected active turn id `x` but found `y`"; idle:
  // "no active turn to steer"). A steered send is consumed by the RUNNING
  // turn (its text appears as a userMessage item inside it), so hcn keeps
  // no pending-id queue for codex - there is no next turn to tag.
  // turn/start on a busy thread folds the input into the running turn and
  // returns the same turn, which is what makes the receipt-in-flight race
  // honest: a send written before the open response arrives is still
  // delivered. `codex queue --thread <id> --message <t>` parks a message
  // for the NEXT turn out-of-band (separate CLI process, no client
  // request in the protocol), so hcn cannot and does not reach it; the
  // disposition vocabulary stays started | rejected.
  // Resume is a protocol method choice, not a flag: the argv is identical
  // for fresh and resumed sessions, hence resumeFlag null (the type's
  // first null). The model rides argv as a config override, not --model
  // (app-server rejects --model), hence modelRender.
  sessionMode: {
    flags: ["app-server"],
    idFlag: null,
    resumeFlag: null,
    input: { kind: "codex-jsonrpc" },
    turnEnd: { method: "turn/completed" },
    identityProbe: { command: "thread/start", responseIdField: "result.thread.id" },
    modelRender: { kind: "config-kv", flag: "-c", key: "model" },
  },
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
    // Current native roster and effort probes: test/fixtures/codex-0.160.0
    // (2026-10-03). Native "ultra" and "none" remain outside hcn's closed
    // effort vocabulary; the curated ladders stop at max.
    models: [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ],
    aliases: {},
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    // Codex constrains ladders per model generation (v1 registry).
    effortsByModel: {
      // https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-06).
      "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
      "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
      "gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
      "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
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
  contextInspection: null,
  // Codex core/session/turn.rs runs native automatic compaction; live
  // compaction and later-process recall captured on 0.160.0.
  nativeContextManagement: { kind: "auto-compaction", modes: ["headless-turn"] },
  // Valid only in the `exec resume` context: `codex exec resume --last`
  // (re-verified on 0.154.0, 2026-09-17). No fork mechanism is probed on
  // codex, so none is rendered.
  // Codex compacts natively and reports nothing hcn can read: no record
  // on its stream marks the boundary. Null, so a caller knows silence
  // here is absence of reporting, not absence of compaction.
  compactionReporting: null,
  resumeLast: {
    flag: "--last",
    headless: true,
    warning:
      "hcn: --resume-last resumes the most-recent codex session in {cwd}; the most recent session may be a killed, failed, or unrelated run's session; codex starts a fresh session with exit 0 when no session is resumable in {cwd}; a run from inside a live codex session in the same directory re-enters that session",
  },
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
      // Session mode streams whole items (item/completed carries the
      // full agentMessage text; the item/agentMessage/delta notification
      // exists in the schema but never fired against ollama on 0.159.2,
      // so token granularity is not claimed).
      "headless-session": "message",
      interactive: "none",
    },
    session: true,
  },
  // Escalation provenance: the `model` below is the escalation probe's
  // own model (what asked when instructed), not the runtime model - the
  // harness self-attests that on its stream and the decoder fills the
  // re-emitted identity's observedOn from it.
  escalation: {
    supported: true,
    observedOn: {
      harness: "codex",
      model: "gpt-6-astra",
      version: "0.160.0",
      date: "2026-10-03",
    },
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
    // Persistent memories (feature `memories`, stable, on by default on
    // 0.149.1 - evidence: test/fixtures/memory-dimension/; state lives in
    // ~/.codex/memories/ + memories_1.sqlite) are disabled per-call with
    // the feature flag. Verified live 0.149.1: `codex features list`
    // reports memories stable+true; -c features.memories=false flips it to
    // false; both `codex exec --disable memories` and `codex exec resume
    // --disable memories` exit 0, so the resume grammar accepts the same
    // spelling (resumeRender omitted). `codex features disable memories`
    // is the persistent config.toml form - NOT the per-call surface hcn
    // renders.
    memory: {
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--disable", "memories"] },
    },
  },
  // Tools: no built-in name lists; control is feature booleans
  // (reachable per-call via -c key=value), sandbox, and approval policy.
  // MCP servers do have per-tool keys (mcp_servers.<id>.tools.<tool>)
  // but built-ins do not.
  // Skills (probes re-verified 2026-09-28, codex 0.155.1 and 0.157.1, via
  // `codex debug prompt-input`, issue #209; shape first verified 0.147.0
  // under --strict-config): skills.config is a DISABLE-SET - an entry
  // disables the skill its path or name selector matches, unlisted skills
  // stay enabled, and a later entry with the same selector replaces an
  // earlier one (session flags outrank user config.toml, precedence 30 vs
  // 20). Path selectors canonicalize and stay effective even when no
  // current skill matches; name selectors match every discovered copy of
  // the name. Narrowing renders both selectors per skill: path covers a
  // frontmatter name that differs from the registry basename, name covers
  // duplicate copies at paths hcn does not know (observed: synced
  // <uuid>/<name> layout). The picks are restated enabled=true - on
  // 0.155.1 that also lifted a skill's own allow_implicit_invocation:false
  // policy back into the catalog; on 0.157.1 the policy wins and the skill
  // stays out of the model-visible catalog regardless (still explicitly
  // invocable by name). Also -c skills.bundled.enabled=false. No global
  // skills.enabled switch. Catalog budget: the initial skills list caps at
  // ~2% of the context window, so with a large registry unconfigured runs
  // omit skills from the list - do not read a bare-run catalog as the
  // enablement truth.
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
