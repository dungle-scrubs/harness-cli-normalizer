/**
 * The muse descriptor: facts about the `muse` CLI as data, verified against
 * Muse Code 1.3.0 (test/fixtures/muse-1.3.0). The v1 scars this encodes:
 * headless re-entry is `muse exec
 * --session-id <id>` (the positional `muse resume <id>` is the INTERACTIVE
 * picker - recognized when pasted, never built), and `muse exec` exits 0
 * on task failure but 1 on step exhaustion (verified 0.1.0 - see spike
 * report A-003 for `budget` vs `task` split).
 */
import { deepFreeze, type HarnessDescriptor, UUID_SHAPE } from "./descriptor.js";
import { SHARED_AUTH_MATCHERS, SHARED_LIMIT_MATCHERS } from "./matchers.js";
import { MUSE_TRANSCRIPT } from "./transcript/muse.js";

export const museCode: HarnessDescriptor = deepFreeze({
  name: "muse",
  transcript: MUSE_TRANSCRIPT,
  bin: "muse",
  verifiedAgainst: "1.3.0",
  // No npm package - `hcn check` falls back to `muse --version` locally and
  // is skipped in CI where the binary is absent, so this harness is exempt
  // from automated drift detection (see README Version-pinning and drift).
  versionSource: { kind: "installed" }, // Re-checked with muse --version, 2026-09-17.
  launch: {
    // exec --json emits the payload_type/stream records the runner decodes
    // (verified 0.1.0); bare exec streams human text.
    baseFlags: ["exec", "--json"],
    subcommands: ["exec"],
    promptStyle: "positional",
    // Passthrough placement (ADR 0003, probed 2026-09-17 on Muse Code
    // 1.3.0): the earlier prompt-joins verdict was the `--` separator's
    // doing. With the separator gone, appended native flags parse: an
    // appended `--session-id <uuid>` is honored as the session id and a
    // bogus flag is rejected natively as an unknown option. The tail
    // renders past hcn's own argv with no separator.
    passthrough: "after-argv",
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
  // Issue #179: exec omits pending approvals from stdout, so a headless
  // turn blocked on one hangs with no event. The runner observes them
  // through the read-only MSP approval/listPending operation (verified
  // against the 1.3.0 schema export: a log-fold read, no lease, works on
  // loaded and unloaded sessions, never subscribes).
  approvalObserver: "msp-list-pending",
  vocabulary: {
    modelFlag: "--model",
    models: [
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
      "muse-spark-1.2",
      "muse-spark-1.1",
    ],
    aliases: {},
    // max and ultra: listed by `muse exec --help` on 1.3.0 and accepted live
    // (an unlisted effort is a native usage error, exit 2).
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
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
  contextInspection: null,
  // Automatic replacement installation and later process recall captured on
  // 1.1.1 and again on 1.3.0. Native growth handling is not a pending-prompt count or a guarantee
  // that arbitrary incoming content fits; native compaction can fail.
  nativeContextManagement: { kind: "auto-compaction", modes: ["headless-turn"] },
  // `muse resume --last` exists (muse resume --help) but needs a
  // terminal: parse data for `parse-resume.ts` only, never a render
  // target, since no headless grammar exists. No warning text lives here:
  // the parse-only arm of `resumeLast` carries no `warning` (a muse
  // warning would never be emitted, and its no-session claim was never
  // probed).
  resumeLast: {
    flag: "--last",
    headless: false,
  },
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
  // Provenance from test/fixtures/muse-1.3.0/questions.snapshot.json.
  escalation: {
    supported: true,
    observedOn: {
      harness: "muse",
      model: "muse-spark-1.3-contributor",
      version: "1.3.0",
      date: "2026-09-17",
    },
  },
  turnOptions: {
    effort: { kind: "effort", render: { kind: "flag-value", flag: "--reasoning-effort" } },
    // MEMORY GAP (watched, verified absent on 0.2.1 - evidence:
    // test/fixtures/memory-dimension/muse-absence-probes.txt): muse ships
    // add_memory/edit_memory tools persisting to ~/.local/share/muse/
    // memory/projects, with no CLI disable flag (category flags cover only
    // write/shell/web) and no documented settings key - memory cannot be
    // turned off per-call. No spec here means an explicit memory:false
    // REFUSES (unsupported-option) and the profile default reports
    // divergence. Re-probe `muse --help` for a memory category flag on
    // every version bump; if one lands, add a toggle spec here and the
    // divergence disappears. Enterprise config planes (muse config
    // validate --plane policy) are unverified for memory gating.
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
    // read gates the write and shell categories; write is the harness
    // default and emits nothing.
    access: {
      kind: "access",
      renders: {
        read: { render: { kind: "flag-list", flags: ["--disable-write", "--disable-shell"] } },
        write: null,
      },
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
