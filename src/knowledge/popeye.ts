/**
 * The popeye descriptor: facts about the `popeye` CLI as data, verified
 * against popeye 0.1.0 (probes in /tmp/popeye-probe, 2026-09-24; fixtures
 * land with the transcript reader arm). Descriptor entry only (RFC-02 P5):
 * launch, resume, session, and grant surfaces are live-verified below, but
 * content decoding (READERS arm) and transcript mapping are later units,
 * so `transcript` is null and `hcn run` against popeye refuses until then.
 */
import { deepFreeze, type HarnessDescriptor } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { POPEYE_TRANSCRIPT } from "./transcript/popeye.js";

export const popeyeCli: HarnessDescriptor = deepFreeze({
  name: "popeye",
  transcript: POPEYE_TRANSCRIPT,
  bin: "popeye",
  verifiedAgainst: "0.1.0",
  // No npm package: never distributed via Homebrew or npm per author
  // policy; the binary is built from source (`--version` reports 0.1.0).
  versionSource: { kind: "installed" },
  launch: {
    // `-p` headless with a positional prompt. `--mode hcn` emits the HCN
    // event stream (identity/token/message/done); `--mode json` the
    // protocol Progress/Snapshot lines; bare -p prints settled text.
    // Verified: --version reports 0.1.0; --help lists print/json/rpc/hcn.
    baseFlags: ["-p"],
    subcommands: [],
    promptStyle: "positional",
    passthrough: "after-argv",
    streamFlags: ["--mode", "hcn"],
    idFlag: null,
  },
  resume: {
    // `--resume <id>` re-enters the session. Unknown ids refuse with a
    // JournalNotFound headError (probed: exit 0 with the typed failure on
    // stdout), so onMissing is error, not create.
    style: "flag",
    flag: "--resume",
    aliases: [],
    idShape: /^[A-Za-z0-9_-]{16}$/,
    onMissing: "error",
    // -p only: launch streamFlags already append --mode hcn.
    extraFlags: ["-p"],
  },
  sessionMode: {
    // `-p --mode rpc`: NDJSON frames on stdin, responses on stdout.
    // `create` mints and returns the snapshot carrying sessionId;
    // `prompt` needs attach in the same process (probed: cross-process
    // prompt refuses session_not_found). Turn end is the prompt response
    // with result._tag snapshot; close emits the terminal closed shape.
    flags: ["-p", "--mode", "rpc"],
    idFlag: null,
    resumeFlag: "--resume",
    input: { kind: "popeye-rpc-prompt" },
    turnEnd: { result: "snapshot" },
    identityProbe: { command: "get-snapshot", responseIdField: "result.sessionId" },
  },
  output: {
    // --mode hcn emits token records plus the message/done envelopes.
    pins: [{ flags: ["--mode", "hcn"], granularity: "token" }],
    floor: "none",
    flagAliases: {},
  },
  identity: {
    authority: "harness-minted",
    // The hcn head's first record: {"kind":"identity","sessionId":...}.
    // RPC create returns the snapshot; sessionId rides result.sessionId.
    announce: { match: { kind: "identity" }, idField: "sessionId" },
  },
  limitMatchers: [...SHARED_LIMIT_MATCHERS],
  authMatchers: [...SHARED_AUTH_MATCHERS],
  autonomy: null,
  vocabulary: {
    modelFlag: "--model",
    // Popeye takes any OpenAI-compatible model id; the endpoint owns the
    // registry, so the vocabulary is open and models is the observed baseline.
    models: ["fake-model"],
    aliases: {},
    efforts: ["low", "medium-low", "medium", "medium-high", "high", "xhigh"],
    extensible: true,
  },
  store: {
    // Flat directory: <sessionDir>/<sessionId>.jsonl, default
    // <cwd>/.popeye/sessions (probed: session files land beside the
    // spawn cwd; --session-dir overrides). No cwd component, no slug.
    template: "{root}/.popeye/sessions",
    cwdSlug: "verbatim",
  },
  contextInspection: null,
  // Compaction is journal-native (compaction entries, summary payloads),
  // never model-window auto-compaction: no native signal exists.
  nativeContextManagement: null,
  // The hcn head reports started/compacted on its own stream; the harness
  // binary emits no compaction channel of its own.
  compactionReporting: null,
  // --resume-last is refused at config (flat dir, no workspace binding).
  resumeLast: null,
  stdin: "inherit",
  presence: { headlessMarkers: ["-p", "--headless"] },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "message",
      interactive: "none",
    },
    session: true,
  },
  escalation: {
    supported: false,
  },
  turnOptions: {
    effort: {
      kind: "effort",
      render: { kind: "flag-value", flag: "--effort" },
    },
    systemPrompt: {
      kind: "prompt-text",
      render: { kind: "flag-value", flag: "--system-prompt" },
    },
    appendSystemPrompt: {
      kind: "prompt-text",
      render: { kind: "flag-value", flag: "--append-system-prompt" },
    },
    contextWindow: {
      kind: "integer",
      min: 1,
      max: 10000000,
      render: { kind: "flag-value", flag: "--context-window" },
    },
    access: { kind: "access", renders: { read: "tool-preset", write: null } },
    // Memory is a declared no-op divergence: both values emit nothing.
    memory: {
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: [] },
    },
  },
  // HCN skills picks are registry paths; popeye --skills takes plugin
  // names at composition, and no path-to-name mapping exists. Refuse like
  // muse until a comma-list render lands in the vocabulary.
  skills: null,
  tools: {
    includeFlag: "--tools",
    excludeFlag: "--exclude-tools",
    includeIsStrictAllowlist: true,
    builtins: [],
    categories: [],
    denySemantics: "remove-from-set",
  },
});
