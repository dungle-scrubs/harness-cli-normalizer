/**
 * The opencode descriptor: facts about the OpenCode CLI (`opencode`) as
 * data, verified against opencode 1.19.5 (npm package `opencode-ai`,
 * 1.19.5; captures in test/fixtures/opencode-1.19.5).
 *
 * What the captures establish:
 * - One JSON object per line on stdout: `{type, timestamp, sessionID,
 *   part|error}`. The types are `step_start`, `tool_use`, `text`,
 *   `step_finish`, `reasoning` (only with `--thinking`) and `error`.
 * - Identity is harness-minted: every line carries `sessionID`
 *   (`ses_` plus 26 base62 characters), so the FIRST line announces the
 *   session even when that line is the error line.
 * - `text` carries the whole text part when it ends - there are no deltas,
 *   so the stream is message-granular.
 * - `tool_use` carries the tool call AND its completed state (input,
 *   output or error) on one line, so one line is one tool and one result.
 * - `step_finish` carries that step's token counts (`part.tokens`) and its
 *   cost (`part.cost`); `part.reason` is `tool-calls` mid-turn and `stop`
 *   at the end of the turn.
 * - An unknown session id is a refusal, not a fresh session: exit 1, an
 *   empty stdout and `Error: Session not found` on stderr.
 * - An unknown model is a plain terminal error (`UnknownError`), not an
 *   auth or a limit wall.
 *
 * What is NOT claimed here (the first slice): a persistent session mode,
 * transcript reading, context inspection, compaction, tool selection and
 * the read access preset. The free model roster rotates - `opencode
 * models` lists a different set between releases - so the vocabulary holds
 * no model list and stays extensible.
 */
import { deepFreeze, type HarnessDescriptor } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

/** opencode mints session ids as `ses_` plus 26 base62 characters
 * (observed on every capture in test/fixtures/opencode-1.19.5). */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]{26}$/;

export const opencodeCli: HarnessDescriptor = deepFreeze({
  name: "opencode",
  // Transcript reading is out of scope for the first slice: 1.19.5 files
  // sessions inside its SQLite store, not as one file per session, so
  // there is no per-session path to name. A null transcript makes
  // `hcn transcript opencode` report divergence instead of inventing a
  // reader.
  transcript: null,
  bin: "opencode",
  verifiedAgainst: "1.19.5",
  versionSource: { kind: "npm", package: "opencode-ai" },
  launch: {
    // `opencode run` is the one-shot headless turn; `--format json` is
    // the raw event stream (the default format is human text).
    baseFlags: ["run"],
    subcommands: ["run"],
    promptStyle: "positional",
    // `run` takes a VARIADIC positional message and joins every trailing
    // token that is not a flag into that message, so a token after hcn's
    // bare `--` would silently rewrite what the model is asked (the
    // cursor prompt-join hazard). A tail that IS a flag parses natively,
    // but hcn has no flag roster to tell the two apart, so any non-empty
    // tail refuses before spawn.
    passthrough: "prompt-joins",
    streamFlags: ["--format", "json"],
    // The session id is minted by the harness; no caller-assigned id flag
    // exists on `run`.
    idFlag: null,
  },
  resume: {
    // `opencode run -s <id>` (also `--session <id>`) continues that
    // session. An unknown id is an ERROR, not a create: exit 1 with an
    // empty stdout and `Error: Session not found` on stderr.
    style: "flag",
    flag: "--session",
    aliases: ["-s"],
    idShape: OPENCODE_SESSION_ID,
    extraFlags: [],
    onMissing: "error",
  },
  sessionMode: null,
  output: {
    // `text` carries the whole text part when it ends; there are no
    // deltas, so the stream is message-granular.
    pins: [{ flags: ["--format", "json"], granularity: "message" }],
    floor: "none",
    flagAliases: {},
    // No echo records: every over-long line is judged on its own.
    echoRecords: null,
  },
  identity: {
    authority: "harness-minted",
    // Every line carries `sessionID` at the top level, and the first line
    // announces it - including when that first line is the error line.
    // An empty match means "any record carrying the id path", so an error
    // line still announces the session it failed in.
    announce: { match: {}, idField: "sessionID" },
  },
  limitMatchers: [
    // The free tier's own wall, as the provider names it in the error
    // body's `responseBody` (from the 1.19.5 bundle; not captured live,
    // because provoking a free-tier limit would spend the allowance).
    { pattern: "FreeUsageLimitError", flags: "i", code: "usage-limit" },
    // The Go subscription tier's wall, same shape.
    { pattern: "GoUsageLimitError", flags: "i", code: "usage-limit" },
    ...SHARED_LIMIT_MATCHERS,
  ],
  authMatchers: [...SHARED_AUTH_MATCHERS],
  // `--dangerously-skip-permissions` (a hidden alias of `--auto` and
  // `--yolo` in the 1.19.5 bundle) approves the permission requests `run`
  // otherwise auto-rejects. Without it a headless turn's write or shell
  // call is denied by opencode itself.
  autonomy: { flag: "--dangerously-skip-permissions" },
  vocabulary: {
    modelFlag: "--model",
    // The free roster rotates: `opencode models opencode` listed a
    // different set of free models on 1.17.10 and on 1.19.5 the same day
    // (2026-11-10). The vocabulary therefore carries no model list and stays
    // extensible, so a caller may name any `provider/model` selector the
    // installed opencode knows.
    models: [],
    aliases: {},
    // `--variant` carries the model variant, but the first slice does not
    // express it, so no effort ladder is claimed.
    efforts: [],
    extensible: true,
  },
  store: {
    // 1.19.5 keeps its sessions in a SQLite store under the XDG data
    // root (`$XDG_DATA_HOME/opencode/opencode.db`, or
    // `~/.local/share/opencode/opencode.db`). The template names that
    // store; no per-session file exists to name.
    template: "{root}/opencode.db",
    cwdSlug: "verbatim",
    rootEnv: [{ name: "XDG_DATA_HOME", suffix: "opencode" }],
    defaultRoot: "{home}/.local/share/opencode",
  },
  contextInspection: null,
  // Compaction is out of scope for the first slice: no claim either way.
  nativeContextManagement: null,
  // No compaction signal was observed on the stream, so silence here is
  // absence of reporting, not absence of compaction.
  compactionReporting: null,
  // `opencode run --continue` resumes the most recent session, but that
  // grammar was never probed, so no most-recent resume is claimed.
  resumeLast: null,
  // No setting-source selection flag (issue #457 is claude-only).
  settingSources: null,
  // `run` appends piped stdin to the prompt, and an open stdin keeps the
  // process waiting for input that never comes.
  stdin: "close-required",
  presence: { headlessMarkers: ["run"] },
  capabilities: {
    // No image or vision surface was probed; curated claims stay
    // conservative (false until observed).
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "message",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
  // No escalation observation exists for opencode: `run` auto-rejects
  // permission requests and no hcn-question block was ever observed.
  escalation: { supported: false },
  // The first slice expresses no turn option: `run` has no tool list
  // flag, no access preset, and `--variant`/`--thinking` are out of
  // scope. Every one of those options refuses before spawn.
  turnOptions: {},
  // No per-skill CLI surface.
  skills: null,
  tools: {
    includeFlag: null,
    excludeFlag: null,
    includeIsStrictAllowlist: false,
    builtins: [],
    categories: [],
    denySemantics: "no-lists",
  },
});
