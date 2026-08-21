/**
 * The claude-code descriptor: facts about the `claude` CLI as data, verified
 * against claude 2.1.233 and the 00-chat-substrate spike evidence (A-001,
 * A-002, A-005). No process logic lives here.
 *
 * Discovery: claude 2.1.233 has no isolated instruction-file toggle.
 * `--bare` would stop `CLAUDE.md` discovery, but it also skips hooks, LSP,
 * plugin sync, auto-memory and keychain reads, and forces auth to
 * `ANTHROPIC_API_KEY` / `apiKeyHelper` (OAuth never read) - so a caller
 * authenticated via OAuth would break. The descriptor therefore offers no
 * `instructionFiles` facet and a call passing it must refuse. Likewise
 * `tools` has no discovery flag on claude and refuses.
 *
 * Effort: A-002 showed `--effort bogus` warns on stderr and runs at DEFAULT
 * effort, exit 0, with nothing echoed in the stream. The library-side
 * `validateEffort` refusal is therefore load-bearing, not cosmetic.
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

export const claudeCode: HarnessDescriptor = deepFreeze({
  name: "claude",
  bin: "claude",
  verifiedAgainst: "2.1.233",
  versionSource: { kind: "npm", package: "@anthropic-ai/claude-code" },
  launch: {
    baseFlags: ["-p"],
    subcommands: [],
    promptStyle: "positional",
    toolsFlag: "--allowedTools",
    // A headless turn launches with the full stream-json output set so the
    // runner can decode identity/limits and stream token deltas; bare -p
    // (granularity none) is a degraded invocation this builder never emits.
    streamFlags: ["--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    idFlag: "--session-id",
  },
  resume: {
    // A-005: claude resumes are id-stable - the caller-assigned id survives
    // every resume, so there is no rotation handling and forking is only the
    // explicit --fork-session flag (deliberate branching, never a default).
    style: "flag",
    flag: "--resume",
    aliases: ["-r"],
    idShape: UUID_SHAPE,
    onMissing: "error",
    extraFlags: ["-p"],
  },
  sessionMode: {
    // A-001: one process, many turns; `result` delimits turns; mid-turn sends
    // queue. --setting-sources project isolates the child from user-level
    // hooks (D-025). Token deltas require this exact output flag set.
    // sessionMode.flags is the complete flag list after the binary, so -p
    // lives here rather than being inherited from launch.baseFlags.
    flags: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      "project",
    ],
    idFlag: "--session-id",
    input: { kind: "claude-sdk-user-message" },
    turnEnd: { type: "result" },
    identityProbe: null,
  },
  output: {
    // --output-format/--include-partial-messages only work with --print, so
    // -p is part of the pin, not an accident of the builders.
    pins: [
      {
        flags: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
        granularity: "token",
      },
    ],
    floor: "none",
    flagAliases: { "--print": "-p" },
  },
  identity: {
    authority: "caller-assigned",
    announce: { match: { type: "system", subtype: "init" }, idField: "session_id" },
  },
  limitMatchers: [
    // Observed phrasings from the live CLI (ported from lucid v1's limits.ts):
    // "You've hit your session limit · resets 6:30pm"
    { pattern: "you'?ve hit your session limit", flags: "i", code: "session-limit" },
    // "You've hit your weekly limit · resets 2am (Asia/Bangkok)"
    { pattern: "you'?ve hit your weekly limit", flags: "i", code: "weekly-limit" },
    ...SHARED_LIMIT_MATCHERS,
  ],
  authMatchers: [
    // A detached process cannot read Keychain creds, and misreading that as
    // "not logged in" sends the human to redo a login that was never broken.
    { pattern: "oauth session expired|could not be refreshed", flags: "i", kind: "expired" },
    { pattern: "failed to authenticate", flags: "i", kind: "expired" },
    { pattern: "not logged in|please run \\/login", flags: "i", kind: "not-logged-in" },
    ...SHARED_AUTH_MATCHERS,
  ],
  autonomy: { flag: "--dangerously-skip-permissions" },
  vocabulary: {
    modelFlag: "--model",
    models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    aliases: {
      fable: "claude-fable-5",
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5-20251001",
    },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    extensible: false,
  },
  store: {
    // Verified against the A-001 fixture's memory_paths slug and real
    // ~/.claude/projects entries: '/', '.' -> '-'; '_' preserved.
    template: "{home}/.claude/projects/{cwdSlug}/{sessionId}.jsonl",
    cwdSlug: "dash-separators",
  },
  contextHook: {
    // claude statusline payload: { context_window: { used_percentage } }.
    // This arrives on the statusline channel, never on stream-json stdout -
    // route accordingly, do not call per stdout line.
    object: "context_window",
    usedPctField: "used_percentage",
  },
  resumeLast: null,
  stdin: "inherit",
  presence: {
    headlessMarkers: ["-p", "--print"],
  },
  capabilities: {
    vision: true,
    images: true,
    streamingByMode: {
      "headless-turn": "token",
      "headless-session": "token",
      interactive: "message",
    },
    session: true,
  },
  turnOptions: {
    effort: { kind: "effort", render: { kind: "flag-value", flag: "--effort" } },
    // issue #48, live-verified 2.1.235: --system-prompt replaces the built-in
    // prompt; --exclude-dynamic-system-prompt-sections strips the dynamic
    // sections (git state, directory listing) that ride even under a
    // replacement. hcn pairs them - a payload-stripping replacement without
    // the exclusion keeps injected sections. Verified live: the pair changes
    // model behavior (NAKED-HAIKU probe vs BASELINE-OK).
    systemPrompt: {
      kind: "prompt-text",
      render: {
        kind: "flag-value",
        flag: "--system-prompt",
        extraFlags: ["--exclude-dynamic-system-prompt-sections"],
      },
    },
    appendSystemPrompt: {
      kind: "prompt-text",
      render: { kind: "flag-value", flag: "--append-system-prompt" },
    },
    discovery: {
      kind: "discovery",
      facets: {
        extensions: {
          polarity: "disables",
          render: { kind: "flag-list", flags: ["--setting-sources", "project"] },
        },
        skills: {
          // Phase 0 (claude-tool-interplay.md probe 4): --disable-slash-commands
          // removes the Skill tool AND all skills listing - verified a full
          // skills-off switch, not just command dispatch. --setting-sources
          // project stays the extensions-facet spelling (settings scope).
          polarity: "disables",
          render: { kind: "flag-list", flags: ["--disable-slash-commands"] },
        },
      },
    },
  },
  // Phase 0 fixtures: claude-tool-interplay.md. include is a permission
  // grant (Bash, Edit stay visible under --allowedTools Read); only the
  // disallow flag reshapes the model-visible set. Both flags together
  // compose, deny winning on overlap. Patterns (Bash(git *)) valid in both
  // lists; unknown PATTERN spellings warn on stderr, unknown exact names
  // are the silent-acceptance hazard the curated vocabulary guards.
  skills: { loadFlag: null, overridesVia: "settings-skilloverrides" },
  tools: {
    includeFlag: "--allowedTools",
    excludeFlag: "--disallowedTools",
    includeIsStrictAllowlist: false,
    composable: true,
    builtins: [
      { name: "Bash", defaultEnabled: true, canonical: "shell" },
      { name: "Edit", defaultEnabled: true, canonical: "edit" },
      { name: "Glob", defaultEnabled: true, canonical: "glob" },
      { name: "Grep", defaultEnabled: true, canonical: "grep" },
      { name: "Read", defaultEnabled: true, canonical: "read" },
      { name: "Write", defaultEnabled: true, canonical: "write" },
      { name: "WebFetch", defaultEnabled: true, canonical: "web-fetch" },
      { name: "WebSearch", defaultEnabled: true, canonical: "web-search" },
      { name: "Monitor", defaultEnabled: true, canonical: null },
      { name: "Task", defaultEnabled: true, canonical: "subagent" },
      { name: "Skill", defaultEnabled: true, canonical: "skill" },
      { name: "NotebookEdit", defaultEnabled: true, canonical: null },
      { name: "LSP", defaultEnabled: true, canonical: null },
    ],
    categories: [],
    denySemantics: "remove-from-set",
  },
});
