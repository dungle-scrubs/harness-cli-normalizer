/**
 * Descriptor types: the shape of what is KNOWN about a harness CLI, as pure
 * data. Interpretation functions consume these; nothing here executes.
 */

export type HarnessName = "claude" | "codex" | "pi" | "muse";

export type StreamingGranularity = "token" | "message" | "none";

export type HarnessMode = "headless-turn" | "headless-session" | "interactive";

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
  /** Headless one-turn launch shape. `promptStyle: "positional"` means the
   * prompt travels as a bare argv entry (ordering constraints apply).
   * `streamFlags` is the output flag set a headless turn launches with so
   * its stream is parseable and token-granular where the harness supports
   * it - the v1 stall-watchdog scar was launching bare and then waiting for
   * deltas the invocation could not emit. */
  readonly launch: {
    readonly baseFlags: readonly string[];
    readonly promptStyle: "positional";
    readonly toolsFlag: string | null;
    readonly streamFlags: readonly string[];
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
  };
  /** Persistent headless session support: the exact flag set that opens one
   * lucid-owned process serving many turns, or null when the harness has no
   * such mode. `idFlag` pins the caller-assigned session identity. */
  readonly sessionMode: {
    readonly flags: readonly string[];
    readonly idFlag: string;
  } | null;
  /** Streaming is a property of the INVOCATION, not the harness: `token`
   * granularity exists only under the exact pinned flag set; anything else
   * falls back to `fallback`. `flagAliases` maps alternate spellings onto
   * the canonical pin members (--print -> -p). */
  readonly output: {
    readonly tokenFlagSet: readonly string[];
    readonly fallback: "message" | "none";
    readonly flagAliases: Readonly<Record<string, string>>;
  };
  /** Where native identity appears in the stream, and who mints it. Every
   * key/value pair in `announce.match` must match the raw event; claude:
   * {type: "system", subtype: "init"}, re-emitted at every turn start with
   * the same value (A-001) - consumers dedupe via decodeIdentity. */
  readonly identity: {
    readonly authority: "caller-assigned" | "harness-minted";
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
    readonly effortFlag: string | null;
  };
  /** Where the harness files sessions/transcripts, as a template over
   * {home}, {cwdSlug} and {sessionId}. Slugging rule is per-harness. */
  readonly store: {
    readonly template: string;
    readonly cwdSlug: "dash-separators" | "verbatim";
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
