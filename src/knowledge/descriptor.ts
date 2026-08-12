/**
 * Descriptor types: the shape of what is KNOWN about a harness CLI, as pure
 * data. Interpretation functions consume these; nothing here executes.
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

export const SESSION_INPUT_KINDS = ["claude-sdk-user-message"] as const;
export type SessionInputKind = (typeof SESSION_INPUT_KINDS)[number];

export interface SessionInputContract {
  readonly kind: SessionInputKind;
}

/** Consumers branch on these (session-limit: wait for reset; weekly-limit:
 * route elsewhere), so the vocabulary is closed - a descriptor cannot invent
 * a code a consumer has no arm for. */
export type LimitCode = "usage-limit" | "session-limit" | "weekly-limit" | "credits" | "quota";

/** Auth walls are separate from usage limits because the remedy is entirely
 * different (re-auth vs wait), and a detached process misreading one as the
 * other sends the human to fix the wrong thing. */
export type AuthFailureKind = "not-logged-in" | "expired" | "invalid-key";

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
  /** Persistent headless session support: the exact flag set that opens one
   * lucid-owned process serving many turns, or null when the harness has no
   * such mode. `idFlag` pins the caller-assigned session identity. */
  readonly sessionMode: {
    readonly flags: readonly string[];
    readonly idFlag: string;
    readonly input: SessionInputContract;
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
  readonly limitMatchers: ReadonlyArray<readonly [RegExp, LimitCode]>;
  /** Auth-wall phrasings, same scan discipline as limitMatchers. */
  readonly authMatchers: ReadonlyArray<readonly [RegExp, AuthFailureKind]>;
  /** The "run unattended without stops" flag, or null when the harness has
   * no such mode. */
  readonly autonomy: { readonly flag: string } | null;
  /** The harness's own model-id spellings, alias map, and effort ladder.
   * Curated baseline - pi's registry is runtime-extensible, so validation
   * against this vocabulary is a default, not a final word (D-008).
   * `effortFlag` is null where effort is not a launch-time flag (claude:
   * effort is an in-session command, not argv). */
  readonly vocabulary: {
    readonly modelFlag: string;
    readonly models: readonly string[];
    readonly aliases: Readonly<Record<string, string>>;
    readonly efforts: readonly string[];
    /** Per-model effort ladders where the harness constrains them (codex:
     * gpt-5.5 tops out at high; gpt-5.6-* starts at medium). Falls back to
     * the harness-wide `efforts`. */
    readonly effortsByModel?: Readonly<Record<string, readonly string[]>>;
    readonly effortFlag: string | null;
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
  /** Provider/model-route flag where present (pi --provider). */
  readonly provider: { readonly flag: string } | null;
  /** Whether backgrounded headless calls must have stdin closed (pi hangs
   * without `< /dev/null`). */
  readonly stdin: "inherit" | "close-required";
  /** Flags that disable instruction-file/skill/MCP auto-discovery, in the
   * spelling the harness accepts. */
  readonly discoveryDisableFlags: readonly string[];
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
}
