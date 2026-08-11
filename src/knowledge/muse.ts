/**
 * The muse descriptor: facts about the `muse` CLI as data, verified against
 * Muse Code 0.1.0 and lucid v1's registry. Descriptor groundwork only
 * (D-003). The v1 scars this encodes: headless re-entry is `muse exec
 * --session-id <id>` (the positional `muse resume <id>` is the INTERACTIVE
 * picker - recognized when pasted, never built), and `muse exec` exits 0
 * even when the work inside failed (verification always reruns the
 * project's own checks).
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";

export const museCode: HarnessDescriptor = deepFreeze({
  name: "muse",
  bin: "muse",
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
    // Structured output on resume too (see launch baseFlags).
    extraFlags: ["--json"],
    positionalParseWord: "resume",
  },
  sessionMode: null,
  output: {
    // muse exec --json emits payload_type-discriminated records including
    // run.output.delta; claimed conservatively as message granularity.
    pins: [{ flags: ["--json"], granularity: "message" }],
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
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"],
    effortFlag: "--reasoning-effort",
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
  provider: null,
  stdin: "inherit",
  discoveryDisableFlags: [],
  presence: {
    headlessMarkers: ["exec"],
  },
  capabilities: {
    // images: muse exec exposes --image <PATH>; kept false pending runtime
    // verification (curated claims stay conservative).
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "none",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
});
