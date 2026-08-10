/**
 * Descriptor types: the shape of what is KNOWN about a harness CLI, as pure
 * data. Interpretation functions consume these; nothing here executes.
 */

export type HarnessName = "claude" | "codex" | "pi" | "muse";

export interface HarnessDescriptor {
  readonly name: HarnessName;
  readonly bin: string;
  /** Headless one-turn launch shape. `promptStyle: "positional"` means the
   * prompt travels as a bare argv entry (ordering constraints apply). */
  readonly launch: {
    readonly baseFlags: readonly string[];
    readonly promptStyle: "positional";
    readonly toolsFlag: string | null;
  };
  /** How a named session id is resumed. `flag` style: `<bin> <flag> <id>`;
   * `positional` style: `<bin> resume <id>` (muse). */
  readonly resume: {
    readonly style: "flag" | "positional";
    readonly flag: string;
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
   * falls back to `fallback` (claude bare `-p`: none - the v1 stall-watchdog
   * scar was the invocation, not the harness). */
  readonly output: {
    readonly tokenFlagSet: readonly string[];
    readonly fallback: "message" | "none";
  };
  /** Where native identity appears in the stream, and who mints it. claude:
   * `system/init.session_id`, re-emitted at every turn start with the same
   * value (A-001) - consumers dedupe via decodeIdentity, never assume
   * first-line-only. */
  readonly identity: {
    readonly authority: "caller-assigned" | "harness-minted";
    readonly announce: {
      readonly type: string;
      readonly subtype?: string;
      readonly idField: string;
    };
  };
  /** "Stopped on a limit" vs crash vs clean exit: the harness's own wall
   * phrasings. Ordering matters - first match wins per line. */
  readonly limitMatchers: ReadonlyArray<readonly [RegExp, string]>;
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
   * up in a process listing, and the flags whose presence marks the process
   * as headless (not interactive presence). */
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

export type HarnessMode = "headless-turn" | "headless-session" | "interactive";

export type StreamingGranularity = "token" | "message" | "none";

export const descriptors: Partial<Record<HarnessName, HarnessDescriptor>> = {};
