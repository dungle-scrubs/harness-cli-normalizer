/**
 * Pure normalization for the Cursor SDK worker backend (issue #440): the
 * private wire records the hcn parent and the SDK worker exchange, the
 * SDK stream/delta mapping onto the shared ContentEvent vocabulary, model
 * slug resolution against the native `Cursor.models.list()` catalog (read
 * as data - this layer never calls it), and the access preset's SDK
 * restriction rendering. The worker itself stays thin: it forwards SDK
 * observations inside the `event` envelopes these decoders read, so the
 * field names live here (ADR 0005) and the runners hold none.
 *
 * Why a worker at all: the SDK runs the agent loop in-process, and a
 * timeout that cannot kill that loop is not a timeout. hcn executes the
 * SDK in one owned child spawned through the injected primitives and
 * supervises it with the same supervisors every other harness uses; this
 * module is the pure half of that seam.
 */

import { CURSOR_SDK_HISTORICAL_MODEL_ALIASES } from "../knowledge/cursor.js";
import type { AccessValue } from "../knowledge/descriptor.js";
import type { ContentEvent } from "./content.js";
import { cursorDenialEvent, cursorToolOutcome } from "./cursor-tool-outcome.js";
import { asRecord, readPath } from "./shape.js";

/** The `hcn` discriminator on every private worker wire record. The SDK
 * never emits this key, so a forwarded SDK observation wrapped in the
 * envelope can never collide with a native SDK message shape. */
export const CURSOR_SDK_WIRE_KEY = "hcn";

/** The wire record kinds (values of the `hcn` discriminator). */
export const CURSOR_SDK_RECORDS = [
  "open",
  "opened",
  "open-failed",
  "prompt",
  "receipt",
  "send-failed",
  "send-cancelled",
  "abort",
  "abort-receipt",
  "turn-end",
  "event",
] as const;
export type CursorSdkRecordKind = (typeof CURSOR_SDK_RECORDS)[number];

/** The one shape the runner's turn-end matching keys on: the worker's
 * terminal record for one run. */
export const CURSOR_SDK_TURN_END: Readonly<Record<string, string>> = { hcn: "turn-end" };

/** The worker's terminal statuses - `RunResult.status` verbatim. */
export type CursorSdkRunStatus = "finished" | "error" | "cancelled";

/** The SDK error classes the worker can name by type instead of leaving
 * string matching to the parent: the error object's class is better
 * evidence than any prose. Closed so the parent has an arm for each. */
const SDK_ERROR_KINDS = [
  "auth",
  "rate-limit",
  "not-found",
  "config",
  "transport",
  "native",
] as const;
export type CursorSdkErrorKind = (typeof SDK_ERROR_KINDS)[number];

const sdkErrorKindOf = (value: unknown): CursorSdkErrorKind | undefined =>
  typeof value === "string" && (SDK_ERROR_KINDS as readonly string[]).includes(value)
    ? (value as CursorSdkErrorKind)
    : undefined;

/** Map an SDK error class name onto the closed error-kind vocabulary. */
export const cursorSdkErrorKindOf = (name: string): CursorSdkErrorKind => {
  if (name === "AuthenticationError") return "auth";
  if (name === "RateLimitError") return "rate-limit";
  if (name === "AgentNotFoundError") return "not-found";
  if (name === "ConfigurationError") return "config";
  if (name === "NetworkError") return "transport";
  return "native";
};

const jsonLine = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

/** An explicit selection input the native catalog cannot satisfy - today
 * only an explicit effort word no catalog entry can pin. Configuration,
 * in the SDK's own sense: its documented ConfigurationError covers an
 * invalid model id and missing or mismatched params and points at
 * `Cursor.models.list()`. Named so the worker's existing class mapping
 * reports the private wire kind `config`, never `native`. */
export class CursorSdkSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** The identity-probe / open request: everything the worker needs to build
 * the SDK AgentOptions, resolved to data by the caller. `model` stays the
 * hcn model slug and `effort` the caller's explicit effort word - the
 * worker resolves both against the native catalog. */
export const encodeCursorSdkOpen = (opts: {
  readonly id: string;
  readonly resume?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Present (false) only for the explicit unconfined write contract. */
  readonly sandbox?: boolean;
}): string =>
  jsonLine({
    hcn: "open",
    id: opts.id,
    ...(opts.resume === undefined ? {} : { resume: opts.resume }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.effort === undefined ? {} : { effort: opts.effort }),
    ...(opts.tools === undefined ? {} : { tools: opts.tools }),
    ...(opts.disallowedTools === undefined ? {} : { disallowedTools: opts.disallowedTools }),
    ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
  });

/** One prompt, correlated by the runner's per-command token. */
export const encodeCursorSdkPrompt = (id: string, message: string): string =>
  jsonLine({ hcn: "prompt", id, message });

/** The native cancellation request for the active run. */
export const encodeCursorSdkAbort = (id: string): string => jsonLine({ hcn: "abort", id });

/** The worker's announcement that the agent is open. Deliberately
 * dual-purpose: the session runner reads `agentId` as the identity-probe
 * answer, and the run runner decodes the `system/init` shape through the
 * descriptor's one identity contract, so both surfaces announce identity
 * the same way. */
export const encodeCursorSdkOpened = (id: string, agentId: string): string =>
  jsonLine({
    hcn: "opened",
    id,
    agentId,
    type: "system",
    subtype: "init",
    session_id: agentId,
  });

export const encodeCursorSdkOpenFailed = (
  id: string,
  message: string,
  errorKind: CursorSdkErrorKind,
): string => jsonLine({ hcn: "open-failed", id, message, errorKind });

export const encodeCursorSdkReceipt = (id: string): string =>
  jsonLine({ hcn: "receipt", id, disposition: "started" });

export const encodeCursorSdkSendFailed = (
  id: string,
  message: string,
  errorKind: CursorSdkErrorKind,
): string => jsonLine({ hcn: "send-failed", id, message, errorKind });

/** hcn cancelled a deferred input before any SDK Run existed. */
export const encodeCursorSdkSendCancelled = (id: string): string =>
  jsonLine({ hcn: "send-cancelled", id });

export const encodeCursorSdkAbortReceipt = (id: string, accepted: boolean, idle = false): string =>
  jsonLine({ hcn: "abort-receipt", id, accepted, ...(idle ? { idle: true } : {}) });

export const encodeCursorSdkTurnEnd = (result: {
  readonly status: CursorSdkRunStatus;
  readonly message?: string;
  readonly code?: string;
  readonly errorKind?: CursorSdkErrorKind;
}): string =>
  jsonLine({
    hcn: "turn-end",
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
  });

/** One forwarded SDK observation. `event` is an SDKMessage the worker
 * chose to forward; `delta` is an InteractionUpdate (only `text-delta`
 * ever rides here - tokens stream once). */
export const encodeCursorSdkEvent = (
  observation:
    | { readonly event: Record<string, unknown> }
    | { readonly delta: Record<string, unknown> },
): string => jsonLine({ hcn: "event", ...observation });

/** The `hcn` discriminator of one parsed worker record, or null for a
 * record that carries none (malformed or foreign output). */
export const cursorSdkWireKindOf = (
  parsed: Record<string, unknown>,
): CursorSdkRecordKind | null => {
  const kind = parsed[CURSOR_SDK_WIRE_KEY];
  return typeof kind === "string" && (CURSOR_SDK_RECORDS as readonly string[]).includes(kind)
    ? (kind as CursorSdkRecordKind)
    : null;
};

/** The worker's terminal record, with its status - the one fact the run
 * runner ends a turn on. Never an assistant-text heuristic. */
export const cursorSdkTurnEndOf = (
  parsed: Record<string, unknown>,
): {
  readonly status: CursorSdkRunStatus;
  readonly message?: string;
  readonly errorKind?: CursorSdkErrorKind;
} | null => {
  if (cursorSdkWireKindOf(parsed) !== "turn-end") return null;
  const status = parsed.status;
  if (status !== "finished" && status !== "error" && status !== "cancelled") return null;
  const message = typeof parsed.message === "string" ? parsed.message : undefined;
  const errorKind = sdkErrorKindOf(parsed.errorKind);
  return {
    status,
    ...(message !== undefined ? { message } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
  };
};

/** Typed failure evidence from a worker refusal or failed run. */
export const cursorSdkFailureOf = (
  parsed: Record<string, unknown>,
): { readonly kind: CursorSdkErrorKind; readonly message: string } | null => {
  const wire = cursorSdkWireKindOf(parsed);
  if (
    wire !== "open-failed" &&
    wire !== "send-failed" &&
    !(wire === "turn-end" && parsed.status === "error")
  )
    return null;
  const kind = sdkErrorKindOf(parsed.errorKind);
  return kind === undefined
    ? null
    : {
        kind,
        message: typeof parsed.message === "string" ? parsed.message : "cursor SDK request failed",
      };
};

/** The SDK access rendering (RFC-02 change 3's access preset on the SDK
 * surface): `read` selects a strict built-in allowlist - read, grep,
 * glob, ls plus the two read-only web tools - with `task` and `mcp`
 * disallowed so neither subagents nor custom tools can escape the
 * allowlist. `write` (or `autonomy` without an explicit read restriction)
 * runs the native toolset unconfined, with the disabled sandbox stated
 * explicitly so the unconfined contract is data, not an omission. A bare
 * call sets no restriction at all: the SDK's own defaults own the bare
 * case (its default toolset runs without approval and its sandbox is off
 * in the pinned 1.0.38), and hcn hardcodes neither policy onto a call
 * that asked for none. */
export interface CursorSdkRestriction {
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** false = the explicit unconfined write contract. */
  readonly sandbox?: false;
}

const CURSOR_SDK_READ_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "ls",
  "webFetch",
  "webSearch",
];

export const cursorSdkAccessRestriction = (opts: {
  readonly access?: AccessValue;
  readonly autonomy?: boolean;
}): CursorSdkRestriction => {
  if (opts.access === "read") {
    return { tools: CURSOR_SDK_READ_TOOLS, disallowedTools: ["task", "mcp"] };
  }
  if (opts.access === "write" || opts.autonomy === true) {
    return { sandbox: false };
  }
  return {};
};

/** One catalog entry of `Cursor.models.list()`, as data. `aliases` are
 * the native spellings the SDK accepts for the same entry - the account
 * catalog lists `auto` as an alias of `default` - and a selection made
 * through one still returns the entry's actual id. */
export interface CursorSdkModelCatalogEntry {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly displayName?: string;
  readonly parameters?: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly values: readonly { readonly value: string; readonly displayName?: string }[];
  }[];
  readonly variants?: readonly {
    readonly params: readonly { readonly id: string; readonly value: string }[];
    readonly displayName: string;
    readonly isDefault?: boolean;
    readonly isMaxMode?: boolean;
  }[];
}

export type CursorSdkModelCatalog = readonly CursorSdkModelCatalogEntry[];

/** The SDK ModelSelection the worker passes to Agent.create/resume. */
export interface CursorSdkModelSelection {
  readonly id: string;
  readonly params?: readonly { readonly id: string; readonly value: string }[];
}

/** Slugify a catalog displayName for slug-word matching: lowercase,
 * zero-width and whitespace runs collapsed to single dashes ("Extra High"
 * -> "extra-high"; the catalog's "Fast\u200b\u200b" -> "fast"). */
const slugWord = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** One selectable spelling of a catalog entry: its canonical id or a
 * native alias the SDK accepts for the same entry. */
interface CursorSdkModelSelector {
  readonly selector: string;
  readonly entry: CursorSdkModelCatalogEntry;
}

/** Every catalog selector - each entry's id plus its native aliases -
 * longest first so exact and prefix decomposition always try the most
 * specific base. */
const selectorsByLongest = (catalog: CursorSdkModelCatalog): CursorSdkModelSelector[] =>
  catalog
    .flatMap((entry) => [
      { selector: entry.id, entry },
      ...(entry.aliases ?? []).map((alias) => ({ selector: alias, entry })),
    ])
    .sort((a, b) => b.selector.length - a.selector.length);

/** The two spellings of the top effort tier, canonicalized for matching
 * only: grok wires `xhigh`, GPT wires `extra-high`, and an hcn slug says
 * whichever its CLI family said. The selection still returns the
 * catalog's own wire value. */
const canonicalWord = (word: string): string =>
  word === "xhigh" || word === "extra-high" ? "xhigh" : word;

/** The value of one parameter a slug word selects: a value matches by its
 * own wire value ("high") or by its slugified displayName ("extra-high"
 * names the value "xhigh" whose display name is "Extra High"), with the
 * two top-tier spellings interchangeable for matching only. A word equal
 * to a boolean parameter's id selects that parameter's allowed true value
 * - the modifier names the switch ("thinking", "fast"), and `true` must
 * be a value the catalog actually allows; nothing is inferred for a
 * parameter that allows no `true`. */
const valueMatching = (
  entry: CursorSdkModelCatalogEntry,
  word: string,
): { readonly id: string; readonly value: string } | null => {
  const canonical = canonicalWord(word);
  for (const parameter of entry.parameters ?? []) {
    for (const candidate of parameter.values) {
      if (
        canonicalWord(candidate.value) === canonical ||
        canonicalWord(slugWord(candidate.displayName ?? "")) === canonical
      ) {
        return { id: parameter.id, value: candidate.value };
      }
    }
  }
  for (const parameter of entry.parameters ?? []) {
    if (parameter.id !== word) continue;
    if (parameter.values.some((candidate) => candidate.value === "true")) {
      return { id: parameter.id, value: "true" };
    }
  }
  return null;
};

/** CLI-selector fallback: use the first non-max variant, or the marked
 * default variant if no non-max variant exists. If that variant has no
 * value for this parameter, use the parameter's first allowed value. */
const defaultValueOf = (
  entry: CursorSdkModelCatalogEntry,
  parameterId: string,
): { readonly id: string; readonly value: string } | null => {
  const variants = entry.variants ?? [];
  const fromVariant = (variant: (typeof variants)[number]): string | undefined =>
    variant.params.find((param) => param.id === parameterId)?.value;
  const preferred =
    variants.find((variant) => variant.isMaxMode !== true) ??
    variants.find((variant) => variant.isDefault === true);
  const preferredValue = preferred === undefined ? undefined : fromVariant(preferred);
  const firstAllowed = entry.parameters?.find((param) => param.id === parameterId)?.values[0]
    ?.value;
  const value = preferredValue ?? firstAllowed;
  return value === undefined ? null : { id: parameterId, value };
};

/** Assign the modifier words of a slug's remainder onto the entry's
 * parameters (the loop body resolveCursorSdkModel ran inline before the
 * explicit-effort arm needed the same two helpers): multi-word display
 * names ("extra-high") can split across tokens, so the two-token join is
 * tried first and consumes both tokens when it hits. Null when any word
 * matches nothing - the entry is then not the one the slug names. */
const assignWords = (
  entry: CursorSdkModelCatalogEntry,
  words: readonly string[],
): { readonly id: string; readonly value: string }[] | null => {
  const assigned: { readonly id: string; readonly value: string }[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    const joined = words[index + 1] === undefined ? null : `${word}-${words[index + 1]}`;
    const joinedMatch = joined === null ? null : valueMatching(entry, joined);
    const match = joinedMatch ?? valueMatching(entry, word);
    if (joinedMatch !== null) index += 1;
    if (match === null) return null;
    if (!assigned.some((param) => param.id === match.id)) assigned.push(match);
  }
  return assigned;
};

/** One entry's selection with every parameter the entry defines either
 * assigned or filled from its stable default - the one merge rule both
 * the slug-decomposition and the explicit-effort arm run. */
const withDefaults = (
  entry: CursorSdkModelCatalogEntry,
  assigned: readonly { readonly id: string; readonly value: string }[],
): CursorSdkModelSelection => {
  const params: { readonly id: string; readonly value: string }[] = [...assigned];
  for (const parameter of entry.parameters ?? []) {
    if (params.some((param) => param.id === parameter.id)) continue;
    const fallback = defaultValueOf(entry, parameter.id);
    if (fallback !== null) params.push(fallback);
  }
  return {
    id: entry.id,
    ...(params.length === 0 ? {} : { params }),
  };
};

/** Pin an explicit effort word onto an entry's own parameter, matched by
 * the same value/display logic a slug word uses (xhigh/extra-high
 * interchangeable for matching, the catalog's wire value sent). The
 * explicit word overrides whatever the slug's own words pinned for that
 * parameter and leaves every other modifier standing; the rest fill from
 * the stable defaults. A word no parameter value matches is a
 * configuration failure - never a silent native default. */
const withExplicitEffort = (
  entry: CursorSdkModelCatalogEntry,
  assigned: readonly { readonly id: string; readonly value: string }[],
  effort: string,
): CursorSdkModelSelection => {
  const match = valueMatching(entry, effort);
  if (match === null) {
    throw new CursorSdkSelectionError(
      `model ${JSON.stringify(entry.id)} offers no parameter value matching explicit effort ${JSON.stringify(effort)}`,
    );
  }
  return withDefaults(entry, [...assigned.filter((param) => param.id !== match.id), match]);
};

/** Map a historical Cursor CLI slug onto its SDK catalog spelling before
 * lookup: the CLI shipped two cursor-prefixed grok ids the catalog names
 * unprefixed (the data table lives in knowledge/cursor.ts). Exact or
 * dash-boundary prefix only - a slug the table does not name keeps its
 * own spelling. */
const historicalSelectorOf = (slug: string): string => {
  for (const [historical, current] of Object.entries(CURSOR_SDK_HISTORICAL_MODEL_ALIASES)) {
    if (slug === historical || slug.startsWith(`${historical}-`)) {
      return `${current}${slug.slice(historical.length)}`;
    }
  }
  return slug;
};

/** Resolve one hcn model slug against the native catalog (issue #440's
 * model contract):
 *
 * 1. An exact catalog id - or a native alias the catalog lists for an
 *    entry, `auto` for `default` - runs as the entry's actual id with no
 *    params - the native defaults apply ("native SDK base ids must work
 *    too").
 * 2. A slug that decomposes as `<selector>-<modifier words...>` pins
 *    the parameters those words name (effort values, boolean switches
 *    like `thinking` and `fast`, context sizes - matched by actual
 *    documented values and display names, with xhigh/extra-high
 *    interchangeable), and fills every other parameter the entry defines
 *    with its default, so `grok-4.7-high` selects reasoning_effort high
 *    on the 256k non-fast variant rather than riding an account default
 *    that can drift.
 * 3. A historical cursor-prefixed CLI slug maps onto its catalog spelling
 *    before the lookup (CURSOR_SDK_HISTORICAL_MODEL_ALIASES).
 * 4. Anything else passes through unchanged - the SDK is the authority
 *    and its unknown-model failure is the clear one.
 *
 * An absent model resolves to the native default: `auto` when the catalog
 * lists it (as an id, or as the native alias of `default`), else the
 * catalog's first entry.
 *
 * An explicit `effort` word rides alongside the slug because the CLI
 * grammar folds some tiers onto the bare slug itself (gpt-5.3-codex
 * medium IS gpt-5.3-codex, whose native default is reasoning high, fast
 * true): resolved through the catalog onto the same pinned selection a
 * decomposed slug yields, on the exact-id path too, overriding any effort
 * the slug's own words pinned and keeping every other modifier. Without
 * it every behavior above is unchanged. With it, an entry it cannot pin
 * (no matching parameter value, no catalog entry for the slug, an empty
 * catalog) is a CursorSdkSelectionError - the caller must surface it,
 * never degrade to the native default. */
export const resolveCursorSdkModel = (
  catalog: CursorSdkModelCatalog,
  slug: string | undefined,
  effort?: string,
): CursorSdkModelSelection => {
  if (slug === undefined || slug === "") {
    const auto =
      catalog.find((entry) => entry.id === "auto") ??
      catalog.find((entry) => (entry.aliases ?? []).includes("auto"));
    const first = auto ?? catalog[0];
    if (first === undefined) {
      if (effort !== undefined) {
        throw new CursorSdkSelectionError(
          `explicit effort ${JSON.stringify(effort)} cannot be applied: the Cursor model catalog is empty`,
        );
      }
      return { id: "auto" };
    }
    return effort === undefined ? { id: first.id } : withExplicitEffort(first, [], effort);
  }
  const selector = historicalSelectorOf(slug);
  for (const { selector: base, entry } of selectorsByLongest(catalog)) {
    if (base === selector) {
      return effort === undefined ? { id: entry.id } : withExplicitEffort(entry, [], effort);
    }
    if (!selector.startsWith(`${base}-`)) continue;
    const remainder = selector.slice(base.length + 1);
    if (remainder === "") continue;
    const words = remainder.split("-").filter((word) => word !== "");
    const assigned = assignWords(entry, words);
    if (assigned === null) continue;
    return effort === undefined
      ? withDefaults(entry, assigned)
      : withExplicitEffort(entry, assigned, effort);
  }
  if (effort !== undefined) {
    throw new CursorSdkSelectionError(
      `explicit effort ${JSON.stringify(effort)} cannot be applied: model ${JSON.stringify(slug)} is not in the Cursor model catalog`,
    );
  }
  return { id: slug };
};

/** The default catalog a worker reports when the account list call fails:
 * resolution degrades to pass-through so the native model validation (not
 * a stale local copy) answers. */
export const EMPTY_CURSOR_SDK_CATALOG: CursorSdkModelCatalog = [];

/** Reader state for the SDK envelope: the tool-call ids whose `running`
 * record was seen (so a completion without one still emits its tool, and a
 * repeated running never re-emits) and the ids already completed (a
 * duplicate completion emits nothing). Both bounded drop-oldest, like
 * the legacy reader's collections. */
export interface CursorSdkReaderState {
  readonly running: readonly string[];
  readonly completed: readonly string[];
}

export const freshCursorSdkReaderState = (): CursorSdkReaderState => ({
  running: [],
  completed: [],
});

const SDK_STATE_BOUND = 128;

const boundedAdd = (ids: readonly string[], id: string): readonly string[] =>
  [...ids.filter((known) => known !== id), id].slice(-SDK_STATE_BOUND);

/** Decode one worker `event` envelope onto the shared content vocabulary.
 * Malformed payloads are defensive reads: nothing throws, an unknown
 * shape decodes to no events (the wire is private, but a truncated or
 * foreign line must never kill the stream). */
export const cursorSdkContentEvents = (
  record: Record<string, unknown>,
  state: CursorSdkReaderState,
): { readonly events: ContentEvent[]; readonly state: CursorSdkReaderState } => {
  const wire = cursorSdkWireKindOf(record);
  if (wire === null) return { events: [], state };
  const observation = record.event !== undefined ? record.event : record.delta;
  const observationRecord = asRecord(observation);
  if (observationRecord === null) {
    // The turn-end record itself carries no observation; its error arm is
    // below so both runners decode it through one reader.
    if (wire === "turn-end") {
      const turn = cursorSdkTurnEndOf(record);
      if (turn === null) return { events: [], state };
      return turn.status === "error"
        ? {
            events: [
              {
                kind: "error",
                message:
                  turn.message === undefined
                    ? `cursor SDK run ended with status error${turn.errorKind === undefined ? "" : ` (${turn.errorKind})`}`
                    : turn.message,
                terminal: true,
              },
            ],
            state,
          }
        : { events: [], state };
    }
    if (wire === "open-failed" || wire === "send-failed") {
      const message =
        typeof record.message === "string" ? record.message : "cursor SDK agent failed to open";
      return { events: [{ kind: "error", message, terminal: true }], state };
    }
    return { events: [], state };
  }
  const type = observationRecord.type;
  if (type === "text-delta") {
    const text = observationRecord.text;
    return typeof text === "string" && text !== ""
      ? { events: [{ kind: "token", text }], state }
      : { events: [], state };
  }
  if (type === "assistant") {
    // The worker synthesizes this shape from onStep: complete text, one
    // message per step, so task-separated turns never concatenate (#438).
    const content = readPath(observationRecord, "message.content");
    const text = Array.isArray(content)
      ? content
          .map((block) => asRecord(block))
          .filter(
            (block): block is Record<string, unknown> => block !== null && block.type === "text",
          )
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .join("")
      : "";
    return text === ""
      ? { events: [], state }
      : { events: [{ kind: "message", role: "assistant", text }], state };
  }
  if (type === "tool_call") {
    const callId = observationRecord.call_id;
    const name = observationRecord.name;
    if (typeof callId !== "string" || typeof name !== "string") return { events: [], state };
    const status = observationRecord.status;
    if (status === "running") {
      // The SDK repeats the running record for one native call (real
      // capture: two identical running records, one call id): the first
      // invocation's data is the one preserved, a repeat - or a late
      // repeat after completion - emits nothing.
      if (state.running.includes(callId) || state.completed.includes(callId)) {
        return { events: [], state };
      }
      return {
        events: [
          {
            kind: "tool",
            name,
            callId,
            ...(observationRecord.args === undefined ? {} : { input: observationRecord.args }),
          },
        ],
        state: { ...state, running: boundedAdd(state.running, callId) },
      };
    }
    if (status !== "completed" && status !== "error") return { events: [], state };
    const outcome = cursorToolOutcome({ result: observationRecord.result }, name);
    // A repeated completion re-reports its denial but never re-emits the
    // tool or its result - the CLI re-reports denials the same way, and
    // the count is the observation, not the unique call.
    if (state.completed.includes(callId)) {
      return outcome?.kind === "rejected"
        ? { events: [cursorDenialEvent(name, outcome.reason)], state }
        : { events: [], state };
    }
    const settled: CursorSdkReaderState = {
      running: state.running.filter((id) => id !== callId),
      completed: boundedAdd(state.completed, callId),
    };
    const events: ContentEvent[] = [];
    // A completion with no seen start still surfaces its tool once, the
    // way the legacy reader does for an unknown call id.
    if (!state.running.includes(callId)) {
      events.push({
        kind: "tool",
        name,
        callId,
        ...(observationRecord.args === undefined ? {} : { input: observationRecord.args }),
      });
    }
    // The record's own result forwards unchanged; the shared canonical
    // outcome reader (legacy payload or SDK wrapper) classifies it. A
    // settled outcome carries isError true or false like the legacy
    // reader's; an unknown one claims nothing. Error signals combine
    // conservatively: an explicit error status (record-level or in the
    // result) is never overridden by a success-shaped classification.
    const outcomeIsError =
      outcome !== null && "isError" in outcome && outcome.isError === true
        ? true
        : status === "error"
          ? true
          : outcome !== null && "isError" in outcome && outcome.isError === false
            ? false
            : undefined;
    events.push({
      kind: "tool-result",
      name,
      callId,
      ...(observationRecord.result === undefined ? {} : { result: observationRecord.result }),
      ...(outcomeIsError === undefined ? {} : { isError: outcomeIsError }),
    });
    if (outcome?.kind === "rejected") {
      // An explicit rejected payload (the legacy CLI arm) keeps its denial
      // observation. The SDK wrapper never carries one for ordinary
      // built-ins - the conversion collapses rejection into a generic
      // error - so this fires only where the distinction is real.
      events.push(cursorDenialEvent(name, outcome.reason));
    }
    return { events, state: settled };
  }
  if (type === "task") {
    const label =
      typeof observationRecord.status === "string" && observationRecord.status !== ""
        ? observationRecord.status
        : "task";
    return { events: [{ kind: "progress", label }], state };
  }
  if (type === "request") {
    const requestId = observationRecord.request_id;
    const named = typeof requestId === "string" && requestId !== "" ? ` ${requestId}` : "";
    return {
      events: [
        {
          kind: "error",
          message: `cursor SDK raised a native request${named} that hcn cannot answer: the SDK exposes no reply API; answer it through native hooks or the hcn question protocol`,
        },
      ],
      state,
    };
  }
  return { events: [], state };
};
