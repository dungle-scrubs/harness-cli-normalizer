/**
 * The muse descriptor: facts about the `muse` CLI as data, verified against
 * Muse Code 0.1.0 and lucid v1's registry. Descriptor groundwork only
 * (D-003). The v1 scars this encodes: headless re-entry is `muse exec
 * --session-id <id>` (the positional `muse resume <id>` is the INTERACTIVE
 * picker - recognized when pasted, never built), and `muse exec` exits 0
 * on task failure but 1 on step exhaustion (verified 0.1.0 - see spike
 * report A-003 for `budget` vs `task` split).
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

export const museCode: HarnessDescriptor = deepFreeze({
  name: "muse",
  bin: "muse",
  verifiedAgainst: "0.1.0",
  // No npm package - `hcn check` falls back to `muse --version` locally and
  // is skipped in CI where the binary is absent, so this harness is exempt
  // from automated drift detection (see README Version-pinning and drift).
  versionSource: { kind: "installed" },
  launch: {
    // exec --json emits the payload_type/stream records the runner decodes
    // (verified 0.1.0); bare exec streams human text.
    baseFlags: ["exec", "--json"],
    subcommands: ["exec"],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
    idFlag: "--session-id",
  },
  resume: {
    // Headless re-entry: the same --session-id on exec (v1 registry). The
    // interactive `muse resume <id>` spelling is parse-only.
    style: "flag",
    flag: "--session-id",
    aliases: [],
    idShape: UUID_SHAPE,
    onMissing: "create",
    // Structured output on resume too (see launch baseFlags).
    extraFlags: ["--json"],
    positionalParseWord: "resume",
  },
  sessionMode: null,
  output: {
    // muse exec --json emits payload.kind run_output_delta text chunks
    // (verified 0.1.0), so this invocation is token-granular.
    pins: [{ flags: ["--json"], granularity: "token" }],
    floor: "none",
    flagAliases: {},
  },
  identity: {
    authority: "caller-assigned",
    // Verified on 0.1.0 (--provider echo --json): records carry
    // payload_type discriminators, no top-level type; the session id lives
    // nested at stream.id - so match any record and read the path.
    announce: { match: {}, idField: "stream.id" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [...SHARED_AUTH_MATCHERS],
  autonomy: { flag: "--yolo" },
  vocabulary: {
    modelFlag: "--model",
    models: ["muse-spark-1.2-contributor", "muse-spark-1.2", "muse-spark-1.1"],
    aliases: {},
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    extensible: false,
  },
  store: {
    // ~/.local/share/muse/sessions/YYYY/MM/DD/{id}/session.jsonl (index at
    // session-index.db) - the template names the sessions root; the
    // execution layer resolves the dated session file.
    template: "{home}/.local/share/muse/sessions",
    cwdSlug: "verbatim",
  },
  contextHook: null,
  // `muse resume --last` exists (muse resume --help).
  resumeLast: { flag: "--last" },
  stdin: "inherit",
  presence: {
    headlessMarkers: ["exec"],
  },
  capabilities: {
    // images: muse exec exposes --image <PATH>; kept false pending runtime
    // verification (curated claims stay conservative).
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
  turnOptions: {
    effort: { kind: "effort", render: { kind: "flag-value", flag: "--reasoning-effort" } },
    write: {
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--disable-write"] },
    },
    shell: {
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--disable-shell"] },
    },
    maxSteps: {
      kind: "integer",
      min: 1,
      max: 10000,
      render: { kind: "flag-value", flag: "--max-model-steps" },
    },
  },
  // Phase 0 fixtures: muse-category-flags.md. No name lists; category
  // switches are enforcement gates - tools stay listed in the catalog but
  // calls are denied per session policy (unlike claude's set removal).
  // Tool names follow muse.<name> (write_file, edit_file, bash, bash_input,
  // add_memory, edit_memory, web_search). --disable-web-tools has no
  // normalized turnOption yet - candidate for a web toggle or passthrough.
  skills: null,
  tools: {
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    composable: false,
    builtins: [],
    categories: [
      {
        key: "write",
        disableFlag: "--disable-write",
        configKey: null,
        canonical: ["write", "edit"],
      },
      { key: "shell", disableFlag: "--disable-shell", configKey: null, canonical: ["shell"] },
      {
        key: "web",
        disableFlag: "--disable-web-tools",
        configKey: null,
        canonical: ["web-fetch", "web-search"],
      },
    ],
    denySemantics: "policy-gate",
  },
});
