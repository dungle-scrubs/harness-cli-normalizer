/**
 * The muse descriptor: facts about the `muse` CLI as data, ported from
 * lucid v1's registry and harness-store knowledge. Descriptor groundwork
 * only (D-003). The v1 scar this encodes: muse resumes POSITIONALLY -
 * `muse resume <id>` - with no flag, so resume parsing anchors on the bare
 * subcommand word, and `muse exec` also exits 0 when the work inside
 * failed (verification always reruns the project's own checks).
 */
import type { HarnessDescriptor } from "./descriptor.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const museCode: HarnessDescriptor = {
  name: "muse",
  bin: "muse",
  launch: {
    baseFlags: ["exec"],
    promptStyle: "positional",
    toolsFlag: null,
    streamFlags: [],
  },
  resume: {
    style: "positional",
    flag: "resume",
    aliases: [],
    idShape: UUID_SHAPE,
  },
  sessionMode: null,
  output: {
    tokenFlagSet: [],
    fallback: "none",
    flagAliases: {},
  },
  identity: {
    authority: "caller-assigned",
    announce: { match: { type: "session.started" }, idField: "session_id" },
  },
  limitMatchers: [[/usage limit (?:reached|exceeded)/i, "usage-limit"]],
  authMatchers: [],
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
  resumeLast: null,
  provider: null,
  stdin: "inherit",
  discoveryDisableFlags: [],
  presence: {
    headlessMarkers: ["exec"],
  },
  capabilities: {
    vision: false,
    images: false,
    streamingByMode: {
      "headless-turn": "none",
      "headless-session": "none",
      interactive: "none",
    },
    session: false,
  },
};
