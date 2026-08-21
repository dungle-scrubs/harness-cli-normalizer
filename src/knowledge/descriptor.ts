/**
 * Descriptor types: the shape of what is KNOWN about a harness CLI, as pure
 * data. Interpretation functions consume these; nothing here executes.
 *
 * Turn option keys and discovery facets use a closed vocabulary for the same
 * reason `LimitCode` does: a descriptor must not invent an option a consumer
 * has no field for. Every `TurnOptionKey` maps to a field on `TurnOptions`
 * and every `DiscoveryFacet` maps to a field on `DiscoveryOptions`; adding
 * a key without a consumer arm would be dead data that can only drift.
 */

export const HARNESS_NAMES = ["claude", "codex", "pi", "muse"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** Descriptors are process-wide defaults shared by reference into merged
 * override sets - freezing makes an accidental in-place edit throw instead
 * of corrupting every consumer. */
/** A 36-char UUID - how every supported harness names its sessions. */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

export type StreamingGranularity = "token" | "message" | "none";

export type HarnessMode = "headless-turn" | "headless-session" | "interactive";

export const SESSION_INPUT_KINDS = ["claude-sdk-user-message", "pi-rpc-prompt"] as const;
export type SessionInputKind = (typeof SESSION_INPUT_KINDS)[number];

export interface SessionInputContract {
  readonly kind: SessionInputKind;
}

/** Consumers branch on these (session-limit: wait for reset; weekly-limit:
 * route elsewhere), so the vocabulary is closed - a descriptor cannot invent
 * a code a consumer has no arm for. */
export type LimitCode =
  | "usage-limit"
  | "session-limit"
  | "weekly-limit"
  | "credits"
  | "quota"
  | "rate-limit";

/** Auth walls are separate from usage limits because the remedy is entirely
 * different (re-auth vs wait), and a detached process misreading one as the
 * other sends the human to fix the wrong thing. */
export type AuthFailureKind = "not-logged-in" | "expired" | "invalid-key";

/** Serializable wall matcher: pattern and flags are data, not a RegExp
 * literal, so an override file can extend them. `compileMatchers` turns
 * these into RegExps with bounds (pattern length, count, allowed flags)
 * and a WeakMap cache so the same array instance reuses compiled RegExps.
 * The input window (first 4096 chars of a line), not pattern analysis, is
 * the backtracking bound. */
export interface LimitMatcher {
  readonly pattern: string;
  readonly flags?: string;
  readonly code: LimitCode;
}

export interface AuthMatcher {
  readonly pattern: string;
  readonly flags?: string;
  readonly kind: AuthFailureKind;
}

/** The turn-option vocabulary is closed for the same reason `LimitCode` is:
 * a descriptor must not invent an option a consumer has no field for. Every
 * key here maps to a field on `TurnOptions`; adding a key without a consumer
 * arm would be dead data that can only drift. Render order is the tuple
 * order, so argv is deterministic regardless of caller field order. */
export const TURN_OPTION_KEYS = deepFreeze([
  "effort",
  "sandbox",
  "provider",
  "discovery",
  "write",
  "shell",
  "maxSteps",
  // issue #48 (ratified 2026-08-20): the payload-stripping dimensions.
  // systemPrompt replaces the built-in prompt; appendSystemPrompt adds to
  // it. Both are opt-in-only (arg/config, no profile entry) - a default
  // that strips the payload changes every bare run's semantics.
  "systemPrompt",
  "appendSystemPrompt",
] as const);
export type TurnOptionKey = (typeof TURN_OPTION_KEYS)[number];

/** Discovery facets are closed for the same reason as `TurnOptionKey`: each
 * maps to a field on `DiscoveryOptions` and a concrete flag spelling per
 * harness. A harness that cannot express a facet simply omits it from its
 * `turnOptions.discovery.facets` table; a call passing that facet must
 * refuse. */
export const DISCOVERY_FACETS = deepFreeze([
  "tools",
  "instructionFiles",
  "extensions",
  "skills",
] as const);
export type DiscoveryFacet = (typeof DISCOVERY_FACETS)[number];

export type OptionRender =
  /** `--flag <value>`; `extraFlags` are fixed companion tokens emitted
   *  before the value pair (claude's --system-prompt pairs with
   *  --exclude-dynamic-system-prompt-sections - issue #48). */
  | {
      readonly kind: "flag-value";
      readonly flag: string;
      readonly extraFlags?: readonly string[];
    }
  /** `-c key=value` - codex's config-override grammar. Permitted only for
   *  closed-vocabulary specs, so no value can need escaping. */
  | { readonly kind: "config-kv"; readonly flag: string; readonly key: string }
  /** A fixed multi-token flag set emitted verbatim, value-less. */
  | { readonly kind: "flag-list"; readonly flags: readonly string[] };

export interface SpecBase {
  readonly render: OptionRender;
  /** The spelling the RESUME grammar accepts. Omitted means "same as
   *  `render`"; an explicit `null` declares the option unexpressible on
   *  resume, and building a resume argv with it must refuse. */
  readonly resumeRender?: OptionRender | null;
}

export type TurnOptionSpec =
  /** Closed value vocabulary. `default` renders on LAUNCH ONLY. */
  | (SpecBase & {
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly default?: string;
    })
  /** Ladder comes from vocabulary.efforts / effortsByModel, not from here. */
  | (SpecBase & { readonly kind: "effort" })
  /** Open selector, CLEAN_SELECTOR-validated. */
  | (SpecBase & { readonly kind: "selector" })
  /** Free-form prompt text (issue #48): systemPrompt / appendSystemPrompt.
   * Values are prose, never a closed vocabulary - no validation beyond
   * non-emptiness, rendering is verbatim. */
  | (SpecBase & { readonly kind: "prompt-text" })
  /** `polarity: "disables"` emits the render when the caller asks for FALSE. */
  | (SpecBase & { readonly kind: "toggle"; readonly polarity: "enables" | "disables" })
  | (SpecBase & { readonly kind: "integer"; readonly min: number; readonly max: number })
  /** Per-facet toggles; a facet absent from the table cannot be expressed. */
  | {
      readonly kind: "discovery";
      readonly facets: Readonly<
        Partial<Record<DiscoveryFacet, SpecBase & { readonly polarity: "enables" | "disables" }>>
      >;
    };

/** Resolve the effective render for a spec at a given phase.
 * - `launch` always uses `render`.
 * - `resume` with `resumeRender: null` is unexpressible (returns null).
 * - `resume` with `resumeRender` omitted resolves to the same render as `render`.
 * - `resume` with an explicit `resumeRender` uses that spelling.
 * Discovery facets use the same rule per facet; this helper works for any
 * `SpecBase` (top-level specs and per-facet specs alike). */
export const resolveRender = (spec: SpecBase, phase: "launch" | "resume"): OptionRender | null => {
  if (phase === "launch") return spec.render;
  if (spec.resumeRender === null) return null;
  return spec.resumeRender ?? spec.render;
};

/** Alias for `resolveRender` with the resume-only null semantics made
 * explicit in the name; useful for tests asserting the "omitted => same as
 * render, null => unexpressible" contract. */
export const resolveResumeRender = (spec: SpecBase): OptionRender | null =>
  resolveRender(spec, "resume");

/** Like `resolveRender` but for a `TurnOptionSpec` that may be a `discovery`
 * table. Returns null for an unexpressible resume, the spec's render for
 * non-discovery specs, and for discovery returns the spec itself (facets are
 * resolved per-facet via `resolveRender`). */
export const getOptionRender = (
  spec: TurnOptionSpec,
  phase: "launch" | "resume",
): OptionRender | null => {
  if (spec.kind === "discovery") return null;
  return resolveRender(spec, phase);
};

export interface HarnessDescriptor {
  readonly name: HarnessName;
  readonly bin: string;
  /** The CLI version every fact in this descriptor - argv shapes, event
   * vocabularies, capability claims, resume semantics - was verified
   * against, as `<bin> --version` reports it. This is the anchor for the
   * harness-update pipeline: CI compares the published/installed version to
   * this, and a mismatch means the descriptor's facts are unverified for the
   * new version (drift possible, or a capability the descriptor says is
   * absent may now exist). Bump it only when the facts have been re-verified
   * against that version (and the fixtures re-captured). */
  readonly verifiedAgainst: string;
  /** Where the latest published version is found, so the update pipeline can
   * detect a new release WITHOUT installing the CLI or running inference.
   * `npm` is a pure registry query (credential-free, CI-friendly);
   * `installed` harnesses (muse ships a shell script, not an npm package)
   * have no registry to poll, so the check falls back to the locally
   * installed `<bin> --version` and is skipped where the CLI is absent. */
  readonly versionSource:
    | { readonly kind: "npm"; readonly package: string }
    | { readonly kind: "installed" };
  /** Headless one-turn launch shape. `promptStyle: "positional"` means the
   * prompt travels as a bare argv entry (ordering constraints apply).
   * `streamFlags` is the output flag set a headless turn launches with so
   * its stream is parseable and token-granular where the harness supports
   * it - the v1 stall-watchdog scar was launching bare and then waiting for
   * deltas the invocation could not emit. */
  readonly launch: {
    readonly baseFlags: readonly string[];
    /** The subcommand words among baseFlags (codex/muse `exec`), declared
     * explicitly - resume parsing anchors on them, and deriving them by
     * filtering non-dash tokens would silently promote flag VALUES like
     * `workspace-write` into subcommands. */
    readonly subcommands: readonly string[];
    readonly promptStyle: "positional";
    readonly toolsFlag: string | null;
    readonly streamFlags: readonly string[];
    /** The flag that pins a caller-assigned id at LAUNCH (spawn-time
     * assignment; the execution layer consumes it), or null when the
     * harness mints its own. */
    readonly idFlag: string | null;
  };
  /** How a named session id is resumed. `flag` style: `<bin> <flag> <id>`;
   * `positional` style: `<bin> resume <id>` (muse) - the resume token must
   * sit at argv position 1. `idShape` is the shape of the harness's own ids;
   * parseResumeCommand refuses commands where an id-shaped token appears
   * anywhere else (the v1 first-UUID-wins scar: a UUID inside quoted prompt
   * text was returned as the session id, and resuming it started a stranger). */
  readonly resume: {
    readonly style: "flag" | "positional";
    readonly flag: string;
    readonly aliases: readonly string[];
    readonly idShape: RegExp;
    /** Flags valid in the RESUME grammar - resume argv never inherits
     * launch flags, because subcommand grammars differ (codex exec resume
     * rejects --sandbox). */
    readonly extraFlags: readonly string[];
    /** A parse-only positional spelling (muse's interactive `muse resume
     * <id>`) recognized when pasted, but never built - the builder uses
     * `style`/`flag`. */
    readonly positionalParseWord?: string;
    /** What resuming a NONEXISTENT id does (verified live): "error" -
     * claude/codex refuse an unknown session; "create" - pi/muse treat the
     * id as create-if-missing and silently start a FRESH session under it.
     * The protocol layer must know this: a consumer resuming a session it
     * believes exists gets a blank session, not an error, on a "create"
     * harness. */
    readonly onMissing: "error" | "create";
  };
  /** Persistent headless session support: the complete flag list that follows
   * the binary to open one lucid-owned process serving many turns, or null
   * when the harness has no such mode. This is the entire argv prefix after
   * the binary - no launch flags are prepended. `idFlag` pins the
   * caller-assigned session identity. `turnEnd` is the stdout record that
   * delimits one turn (claude: the `result` record; pi rpc:
   * `agent_settled`). `identityProbe`, when present, names a command the
   * runner writes at spawn whose response carries the session id - pi rpc
   * is identity-silent at startup (spike evidence:
   * test/fixtures/pi-rpc-spike), so identity needs a round trip. */
  readonly sessionMode: {
    readonly flags: readonly string[];
    /** Pin an EXISTING session id; null when the harness only accepts
     * caller ids that already exist (pi rpc: `--session` refuses unknown
     * ids - spike evidence), so fresh sessions omit the flag and the
     * harness mints the id, readable via `identityProbe`. */
    readonly idFlag: string | null;
    readonly input: SessionInputContract;
    readonly turnEnd: Readonly<Record<string, string>>;
    readonly identityProbe: { readonly command: string } | null;
  } | null;
  /** Streaming is a property of the INVOCATION, not the harness: each pin
   * names the flag set that unlocks a granularity, checked in order, first
   * fully-satisfied pin wins; an argv satisfying none gets `floor`. This
   * carries claude (token under stream-json), codex (message under --json,
   * none bare), and muse/pi in one shape - a single conditional tier could
   * not. `flagAliases` maps alternate spellings onto pin members. */
  readonly output: {
    readonly pins: ReadonlyArray<{
      readonly flags: readonly string[];
      readonly granularity: StreamingGranularity;
    }>;
    readonly floor: StreamingGranularity;
    readonly flagAliases: Readonly<Record<string, string>>;
  };
  /** Where native identity appears in the stream, and who mints it. Every
   * key/value pair in `announce.match` must match the raw event; claude:
   * {type: "system", subtype: "init"}, re-emitted at every turn start with
   * the same value (A-001) - consumers dedupe via decodeIdentity. */
  readonly identity: {
    readonly authority: "caller-assigned" | "harness-minted";
    /** `idField` is a dot-path (muse nests its id at `stream.id`); an empty
     * `match` means "any record carrying the id path". */
    readonly announce: {
      readonly match: Readonly<Record<string, string>>;
      readonly idField: string;
    };
  };
  /** "Stopped on a limit" vs crash vs clean exit: the harness's own wall
   * phrasings. First match wins per line. */
  readonly limitMatchers: ReadonlyArray<LimitMatcher>;
  /** Auth-wall phrasings, same scan discipline as limitMatchers. */
  readonly authMatchers: ReadonlyArray<AuthMatcher>;
  /** The "run unattended without stops" flag, or null when the harness has
   * no such mode. */
  readonly autonomy: { readonly flag: string } | null;
  /** The harness's own model-id spellings, alias map, and effort ladder.
   * Curated baseline - pi's registry is runtime-extensible, so validation
   * against this vocabulary is a default, not a final word (D-008). */
  readonly vocabulary: {
    readonly modelFlag: string;
    readonly models: readonly string[];
    readonly aliases: Readonly<Record<string, string>>;
    readonly efforts: readonly string[];
    /** Per-model effort ladders where the harness constrains them (codex:
     * gpt-5.5 tops out at high; gpt-5.6-* starts at medium). Falls back to
     * the harness-wide `efforts`. */
    readonly effortsByModel?: Readonly<Record<string, readonly string[]>>;
    /** D-008: an extensible vocabulary (pi) accepts clean unknown model
     * selectors at argv time; capability claims for them degrade to
     * unknown until runtime verification. */
    readonly extensible: boolean;
  };
  /** Where the harness files sessions/transcripts, as a template over
   * {home}, {cwdSlug} and {sessionId}. Slugging rule is per-harness. */
  readonly store: {
    readonly template: string;
    /** claude: '/', '.' -> '-'; pi: '/' -> '-' wrapped in leading/trailing
     * dashes, dots preserved. */
    readonly cwdSlug: "dash-separators" | "pi-dash-wrapped" | "verbatim";
  };
  /** How the harness exposes context-window usage; the interpretation layer
   * surfaces it as a `context` HarnessEvent. */
  readonly contextHook: {
    readonly object: string;
    readonly usedPctField: string;
  } | null;
  /** Resume-most-recent support (codex --last), or null. The race it opens
   * is owned by the corroboration ranking in interpretation. */
  readonly resumeLast: { readonly flag: string } | null;
  /** Whether backgrounded headless calls must have stdin closed (pi hangs
   * without `< /dev/null`). */
  readonly stdin: "inherit" | "close-required";
  /** Presence recognition: how an interactive process for a session id shows
   * up in a process listing. `headlessMarkers` mark a process as headless
   * (not interactive presence). Known blind spot, inherent to argv matching:
   * an interactive session carrying no id in argv (`claude --continue`) is
   * invisible here - presence corroborates, it never proves. */
  readonly presence: {
    readonly headlessMarkers: readonly string[];
  };
  /** Curated capability baseline per mode (D-008: a default, never a final
   * word - runtime verification upgrades source/confidence at attach). */
  readonly capabilities: {
    readonly vision: boolean;
    readonly images: boolean;
    readonly streamingByMode: Readonly<Record<HarnessMode, StreamingGranularity>>;
    readonly session: boolean;
  };
  /** Per-call turn options this harness can express, keyed by the closed
   * `TurnOptionKey` vocabulary. Absent keys are unexpressible on this
   * harness; a call passing them must refuse. Discovery is a table of
   * per-facet specs rather than a single flag. */
  readonly turnOptions: Readonly<Partial<Record<TurnOptionKey, TurnOptionSpec>>>;
  /** Tool-selection surface, grounded in test/fixtures/phase0/ evidence.
   * `includeFlag`/`excludeFlag` are the per-tool NAME-LIST flags (null when
   * the harness has none - codex/muse). `includeIsStrictAllowlist` records
   * the claude asymmetry: claude's include flag pre-approves without
   * restricting the visible set, so an exact allowlist must render as a
   * disallow-complement there; pi's include IS strict (over built-ins).
   * `composable`: both flags legal at once (pi: exclude subtracts from
   * include). `builtins`: curated names + default-enabled state - grep/find/
   * ls ship off on pi, everything ships on elsewhere. `categories`:
   * non-list switches (muse disable flags, codex config booleans).
   * `denySemantics`: whether a deny removes the tool from the model-visible
   * set (claude/pi), policy-gates execution while the tool stays listed
   * (muse), or there are no lists to deny with (codex). Extension and MCP
   * tools register at runtime and are NEVER enumerated here - name
   * validation is a default, not a refusal authority (same stance as the
   * pi model registry, D-008). */
  /** Caller-directed skills allowlist surface (issue #38). pi: repeatable
   * load flag. claude: per-name "off" overrides via settings JSON.
   * codex/muse: null (structural gap - trust/config scoped only). */
  readonly skills: {
    readonly loadFlag: string | null;
    readonly overridesVia: "settings-skilloverrides" | null;
  } | null;
  readonly tools: {
    readonly includeFlag: string | null;
    readonly excludeFlag: string | null;
    readonly includeIsStrictAllowlist: boolean;
    readonly composable: boolean;
    readonly builtins: ReadonlyArray<{
      readonly name: string;
      readonly defaultEnabled: boolean;
    }>;
    readonly categories: ReadonlyArray<{
      readonly key: "shell" | "write" | "web" | "exec" | "view-image";
      readonly disableFlag: string | null;
      readonly configKey: string | null;
    }>;
    readonly denySemantics: "remove-from-set" | "policy-gate" | "no-lists";
  };
}
