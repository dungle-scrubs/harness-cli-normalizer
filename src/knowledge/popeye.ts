/**
 * The popeye descriptor: facts about the `popeye` CLI as data, verified
 * against popeye 0.1.4 (live re-verification 2026-09-27: `--version`,
 * `--help` modes, `-p --mode hcn` event stream, `--model`, `--effort`,
 * `--context-window`, `--system-prompt`, `--append-system-prompt`,
 * `--resume`, `--agent`, exit codes; fixtures in
 * test/fixtures/popeye-0.1.4, fake provider). Launch, resume, session,
 * and grant surfaces are live-verified; transcript reading is exercised
 * by test/transcript/popeye.test.ts against both fixture sets.
 * `--agent` reads from ./.popeye/agents and ~/.popeye/agents
 * (POPEYE_AGENTS_DIR overrides the user dir); an unknown name is a
 * typed `CliConfigError` and exits 2 (the harness's usage-error class).
 * Rechecked on 2026-10-03 using the installed source-built wrapper and a
 * live loopback model: six applicable smoke:seven scenarios pass (no
 * default tools). smoke:questions omits Popeye; escalation stays unverified
 * and false. Captures: test/fixtures/popeye-0.1.4-reverify-2026-10-03.
 */
import { deepFreeze, type HarnessDescriptor } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { POPEYE_TRANSCRIPT } from "./transcript/popeye.js";

export const popeyeCli: HarnessDescriptor = deepFreeze({
  name: "popeye",
  transcript: POPEYE_TRANSCRIPT,
  bin: "popeye",
  verifiedAgainst: "0.1.4",
  // No npm package: never distributed via Homebrew or npm per author
  // policy; source tag v0.1.4 and --version were rechecked on 2026-10-03.
  versionSource: { kind: "installed" },
  launch: {
    // `-p` headless with a positional prompt. `--mode hcn` emits the HCN
    // event stream (identity/token/message/done); `--mode json` the
    // protocol Progress/Snapshot lines; bare -p prints settled text.
    // Verified on 0.1.4: --version reports 0.1.4; --help lists
    // print/json/rpc/hcn; --agent reads from .popeye/agents (strict
    // validation, CliConfigError exit 2 on unknown name); the hcn
    // stream and exit codes match the fixtures (test/fixtures/popeye-0.1.4).
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
    // Probe-observed on 0.1.0 (12 base64url bytes) and re-observed on
    // 0.1.3 captures; re-observed length matches on 0.1.4. SessionIdSchema
    // brands any string, so treat the length as verifiedAgainst-0.1.4
    // evidence.
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
    // P2 divergences, verified against popeye's RPC bridge: close and
    // abort ride the control bypass around the session FIFO lane;
    // both queues are bounded (dispatcher overflow refuses
    // protocol_error, turn-input overflow refuses turn_queue_full);
    // abort settles into timeout-to-fallback, never a kill.
    flags: ["-p", "--mode", "rpc"],
    idFlag: null,
    resumeFlag: "--resume",
    input: { kind: "popeye-rpc-prompt" },
    turnEnd: { result: "snapshot" },
    identityProbe: { command: "create", responseIdField: "result.sessionId" },
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
    // spawn cwd; --session-dir overrides). The root is the spawn cwd,
    // declared here so the resume guard resolves the same directory the
    // child files sessions under. No slug component.
    template: "{root}/.popeye/sessions",
    cwdSlug: "verbatim",
    defaultRoot: "{cwd}",
  },
  contextInspection: null,
  // Compaction is journal-native (compaction entries, summary payloads),
  // never model-window auto-compaction: no native signal exists.
  nativeContextManagement: null,
  // The hcn head reports started/compacted on its own stream
  // (fixture: hcn-stream.ndjson identity capabilities); the harness
  // binary emits no compaction channel of its own.
  compactionReporting: {
    source: "stream",
    states: ["started", "compacted"],
    tokens: false,
  },
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
    // --agent (RFC-04 in popeye): selects among agent definitions in
    // ./.popeye/agents, ~/.popeye/agents, or POPEYE_AGENTS_DIR. Strict
    // validation: an unknown name produces a typed CliConfigError on
    // stderr and exit code 2 - the same shape hcn forwards as a native
    // error class, no roster parsing.
    agent: {
      kind: "selector",
      render: { kind: "flag-value", flag: "--agent" },
    },
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
    // Native names from READ_PRESET_TOOL_NAMES (popeye grants.ts);
    // canonical keys follow the pi vocabulary so cross-harness
    // refusals name popeye's spelling.
    builtins: [
      { name: "read", defaultEnabled: true, canonical: "read" },
      { name: "grep", defaultEnabled: true, canonical: "grep" },
      { name: "glob", defaultEnabled: true, canonical: "glob" },
      { name: "list", defaultEnabled: true, canonical: "list" },
      { name: "web-fetch", defaultEnabled: true, canonical: "web-fetch" },
      { name: "web-search", defaultEnabled: true, canonical: "web-search" },
    ],
    categories: [],
    denySemantics: "remove-from-set",
  },
});
