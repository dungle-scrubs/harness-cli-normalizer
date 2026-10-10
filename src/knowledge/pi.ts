/**
 * The pi descriptor: facts about the `pi` CLI as data, verified against
 * pi 1.1.0 (test/fixtures/pi-1.1.0). Descriptor groundwork only (D-003). The load-bearing scars:
 * pi reads stdin even in -p mode (a backgrounded call without `< /dev/null`
 * hangs forever), it auto-discovers instruction files/skills/extensions
 * unless disabled, and its model registry is runtime-extensible (D-008) -
 * the curated list here is a baseline, never a refusal authority.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { PI_TRANSCRIPT } from "./transcript/pi.js";

export const piCli: HarnessDescriptor = deepFreeze({
  name: "pi",
  transcript: PI_TRANSCRIPT,
  bin: "pi",
  verifiedAgainst: "1.1.0",
  versionSource: { kind: "npm", package: "@earendil-works/pi-coding-agent" },
  launch: {
    // -p --mode json: bare -p prints plain text; --mode json emits the
    // structured v3 records the runner decodes (verified 0.84.2; 0.84.2
    // additionally nests a usage object inside message_update alongside
    // assistantMessageEvent - additive, decoder unaffected).
    baseFlags: ["-p", "--mode", "json"],
    subcommands: [],
    promptStyle: "positional",
    // Passthrough placement (ADR 0003, probed 2026-09-17 on pi 0.85.1):
    // the earlier prompt-joins verdict was the `--` separator's doing (pi
    // documents `--` as end-of-options with the remainder as
    // messages/files). With the separator gone, appended native flags
    // parse: an appended `--session-id <uuid>` is honored as the session
    // id and a bogus flag is rejected natively as an unknown option. The
    // tail renders past hcn's own argv with no separator.
    passthrough: "after-argv",
    streamFlags: [],
    idFlag: "--session-id",
  },
  resume: {
    // Caller-assigned: the same --session-id re-enters the session. Resume
    // carries the same structured-output flags launch does, or a resumed
    // turn would stream plain text the runner cannot decode.
    // Verified 2026-08-21 on pi 0.84.2: a session id minted by `pi --mode rpc`
    // via the get_state probe (01a022e3-9afb-7ce5-88f5-07ad0e9ac8fa) resumed
    // after close through the one-shot grammar `pi --session-id <id> -p
    // --mode json` (flag --session-id, extraFlags -p --mode json), exit 0,
    // 207 lines, and the reply recalled the codeword "otter" (evidence at
    // test/fixtures/pi-rpc-spike/06-resume-after-close/: rpc-turn.ndjson,
    // resume.argv.json, resume.ndjson, README.md). If the resume had not
    // recalled the codeword, this comment would say so and the descriptor
    // would not be changed here.
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
  // delimits turns. A busy hcn send uses prompt with streamingBehavior:
  // steer, joining the current run; follow_up is Pi's separate native queue.
  // Identity is silent at startup and readable
  // only via a get_state round trip, stdin EOF exits rc=0. The claude
  // slice remains the proven vertical (D-003); this entry is the second.
  sessionMode: {
    flags: ["--mode", "rpc"],
    // pi has TWO flags with similar names and opposite unknown-id behaviour:
    // `--session <path|id>` requires an EXISTING id (live-verified
    // "No session found" on a fresh uuid) while `--session-id <id>` creates
    // it if missing. Session mode uses `--session-id`, the flag the one-shot
    // resume grammar also uses (resume.flag). That is why `idFlag` is
    // `--session-id` here and not null - the earlier `idFlag: null` comment
    // described `--session`, a different flag. Verified phase10
    // (test/fixtures/phase10-pi-rpc-resume): a second `pi --mode rpc
    // --session-id <id>` against the same id restored the codeword
    // "pomegranate" (rpc-resume.ndjson), while the first established it
    // and warned on stderr "creating a new session with that id"
    // (rpc-establish.stderr.txt). An unknown id is therefore created with
    // a stderr warning, which is what `resume.onMissing: "create"` already
    // records for the one-shot grammar - no duplication in sessionMode.
    idFlag: "--session-id",
    resumeFlag: "--session-id",
    input: { kind: "pi-rpc-prompt" },
    turnEnd: { type: "agent_settled" },
    identityProbe: { command: "get_state", responseIdField: "data.sessionId" },
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
  authMatchers: [
    { pattern: "No API key found for", flags: "i", kind: "not-logged-in" },
    ...SHARED_AUTH_MATCHERS,
  ],
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
    // <root>/<ISO-stamp>_<uuid>.jsonl. The stamp needs a store scan, so the
    // template names the directory. Pi resolves that directory in this
    // order (docs/configuration.md, docs/sessions.md, verified on 0.87.1):
    // PI_CODING_AGENT_SESSION_DIR files FLAT, with no per-cwd slug;
    // otherwise <agent dir>/sessions/<slug>, where the agent dir is
    // PI_CODING_AGENT_DIR, else ~/.pi/agent. The slug is the cwd
    // dash-flattened and dash-wrapped, dots preserved
    // (--Users-kevin-dev-x--). The --session-dir flag and the sessionDir
    // setting also move the store; hcn sees neither. Re-exercised live on
    // 0.99.1: smoke sessions landed in
    // $PI_CODING_AGENT_DIR/sessions/--private-tmp-hcn-smoke-ws-pi--.
    template: "{root}",
    cwdSlug: "pi-dash-wrapped",
    rootEnv: [
      { name: "PI_CODING_AGENT_SESSION_DIR", suffix: "" },
      { name: "PI_CODING_AGENT_DIR", suffix: "sessions/{cwdSlug}" },
    ],
    defaultRoot: "{home}/.pi/agent/sessions/{cwdSlug}",
  },
  contextInspection: null,
  // Native auto-compaction, observed live on 0.87.0, 2026-09-22
  // (docs/research/2026-09-22-compaction-signals/pi). It fires when
  // contextTokens exceeds contextWindow - reserveTokens, in headless-turn
  // (`-p --mode json`, including the resume grammar) and in headless-session
  // (`--mode rpc`). interactive is untested, so it is not claimed.
  //
  // The stream announces both edges: `compaction_start` carries `reason`
  // ("manual" | "threshold" | "overflow"), and `compaction_end` carries the
  // whole payload - summary, firstKeptEntryId, tokensBefore,
  // estimatedTokensAfter, the summarizer's usage, and details. Hcn reports
  // both edges, including threshold compaction outside the agent_start /
  // agent_settled pair. A consumer keyed only on turn boundaries can miss it.
  nativeContextManagement: {
    kind: "auto-compaction",
    modes: ["headless-turn", "headless-session"],
  },
  // 1.0.0: JSON and RPC threshold replacement installation and later-process
  // recall reproduced at lowered thresholds (test/fixtures/pi-1.0.0/VERIFICATION.md).
  // This does not establish lossless recall or steady full-capacity behavior.
  // 0.99.1 re-probe: reproduced (test/fixtures/pi-0.99.1/VERIFICATION.md).
  // Three forcing configurations: project .pi/settings.json with
  // reserveTokens 950k and 5M (plus keepRecentTokens 500 and --approve)
  // both fired threshold compaction inside one hcn-shaped resume turn
  // (compaction_start/compaction_end before agent_start; 230k -> 57k
  // tokens), and the compacted session was recalled correctly in a later
  // process. The user-settings route (~/.pi/agent/settings.json) does not
  // fire on this machine because the shell exports
  // PI_CODING_AGENT_DIR=/Users/kevin/.pi, which redirects global settings
  // to /Users/kevin/.pi/settings.json; without --approve the project route
  // is ignored (docs/settings.md trust gate). Those two gates, not pi
  // behavior, explain the earlier 0.87.1 non-reproduction; the payload
  // semantics still rest on the 0.87.0 live evidence
  // (docs/research/2026-09-22-compaction-signals/pi).
  // RFC-06: `--continue` continues the previous session (observed on
  // 0.85.1, 2026-09-17; `--continue` example in `pi --help`). No fork
  // mechanism is probed on pi, so none is rendered.
  // pi brackets every compaction with compaction_start / compaction_end,
  // both carrying `reason`. A resultless end record reports `aborted` or
  // `failed` - pi drops the `result` key rather than nulling it.
  compactionReporting: {
    source: "stream",
    states: ["started", "compacted", "failed", "aborted"],
    tokens: true,
  },
  resumeLast: {
    flag: "--continue",
    headless: true,
    warning:
      "hcn: --resume-last resumes the most-recent pi session in {cwd}; the most recent session may be a killed, failed, or unrelated run's session; pi starts a fresh session with exit 0 when no session is resumable in {cwd}; a run from inside a live pi session in the same directory re-enters that session",
  },
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
  // Escalation provenance: the escalation probe observations below are
  // the probe's own model (what asked when instructed), not the runtime
  // model. The harness self-attests THAT on its stream (pi assistant
  // message records carry provider/model; the transcript-only
  // `model_change` record never appears on stdout - verified live on pi
  // 0.85.1) and the decoder fills the re-emitted identity's observedOn
  // from that attestation (see decodeParsed). Static probe records stay
  // untouched; the observed value is display only.
  escalation: {
    supported: true,
    observedOn: {
      harness: "pi",
      model: "openai-codex/gpt-6.1-sol",
      version: "1.1.0",
      date: "2026-10-10",
    },
  },
  turnOptions: {
    effort: { kind: "effort", render: { kind: "flag-value", flag: "--thinking" } },
    provider: { kind: "selector", render: { kind: "flag-value", flag: "--provider" } },
    // Extension-registered option (map #300, #302-#304): the subagent
    // extension (~/.pi/extensions/subagent, loaded via the pi config dir)
    // registers `--agent <value>` - "Start as a named user agent". Published
    // pi core 0.87.1 rejects the flag (`Error: Unknown option: --agent`,
    // probed 2026-09-28 from the npm tarball), so the spec carries a probe:
    // the CLI gate runs `pi --help` under the caller's env and refuses
    // pre-spawn where the extension is absent. pi is lenient on unknown
    // agent NAMES (stderr warning listing the roster, run continues) - the
    // name stays the harness's business, like claude/antigravity/popeye.
    agent: {
      kind: "selector",
      render: { kind: "flag-value", flag: "--agent" },
      probe: {
        argv: ["--help"],
        contains: "--agent <value>",
        providedBy: "subagent extension",
      },
    },
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
    // RFC 35 (Lucid), verified on 0.87.1: `-e <path>` loads an extension
    // file even with -ne, and repeats for several files.
    extensions: { kind: "path-list", render: { kind: "flag-value", flag: "-e" } },
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
    // read renders the read preset through --tools (strict allowlist);
    // write is the harness default and emits nothing.
    access: { kind: "access", renders: { read: "tool-preset", write: null } },
    // pi ships no built-in persistent-memory capability (verified 0.84.3 -
    // evidence: test/fixtures/memory-dimension/pi-absence-probes.txt:
    // no memory tool or feature; sessions are files resumed explicitly,
    // which is session persistence, not context memory). The memory-off
    // state is therefore vacuously true - the render is an EMPTY flag
    // list: memory:false emits nothing because pi already runs memory-off,
    // and memory:true is a no-op for the same reason. A user-installed
    // memory extension is runtime-registered and outside descriptor
    // scope (same stance as MCP tools).
    memory: {
      kind: "toggle",
      polarity: "disables",
      render: { kind: "flag-list", flags: [] },
    },
  },
  // Pi 1.0 live probes confirm --tools replaces the whole active selection,
  // including extension and MCP tools (test/fixtures/pi-1.0.0). Exclusion
  // subtracts after selection; -nbt has no normalized spelling.
  skills: { loadFlag: "--skill", overridesVia: null },
  tools: {
    includeFlag: "--tools",
    excludeFlag: "--exclude-tools",
    includeIsStrictAllowlist: true,
    builtins: [
      { name: "read", defaultEnabled: true, canonical: "read" },
      { name: "bash", defaultEnabled: true, canonical: "shell" },
      { name: "edit", defaultEnabled: true, canonical: "edit" },
      { name: "write", defaultEnabled: true, canonical: "write" },
      { name: "grep", defaultEnabled: false, canonical: "grep" },
      { name: "find", defaultEnabled: false, canonical: "glob" },
      { name: "ls", defaultEnabled: false, canonical: "list" },
    ],
    categories: [],
    denySemantics: "remove-from-set",
  },
});
