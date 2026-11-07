/**
 * Issue #456: model and effort changes within a Claude or Pi session.
 * Both harnesses have native mid-session mechanisms (verified: Claude
 * 2.1.319 `set_model` / `apply_flag_settings {effortLevel}` control
 * requests; Pi 1.4 RPC `set_model` / `set_thinking_level`), and this
 * module is the pure owner of their wire shapes, of the validation the
 * spawn flags already apply, and of Pi's model resolution against the
 * catalog the running session reports (`get_available_models`), mirroring
 * Pi 1.4.0's own `resolveCliModel`. Execution sequences the writes and
 * settles the receipt; nothing here touches a process.
 */
import type {
  HarnessDescriptor,
  SessionInputContract,
  SessionInputKind,
} from "../knowledge/descriptor.js";
import { piCli } from "../knowledge/pi.js";
import { asRecord } from "./shape.js";
import { validateEffort, validateModel } from "./vocabulary.js";

/** The request id prefix hcn stamps on its settings commands, so their
 * responses cannot be confused with anything user-visible. The effort
 * half of one op carries `:e`, Pi's catalog read `:c` and its state
 * readback `:s`. */
export const SETTINGS_ID_PREFIX = "hcn-settings:";

export const settingsModelId = (token: string): string => `${SETTINGS_ID_PREFIX}${token}`;
export const settingsEffortId = (token: string): string => `${SETTINGS_ID_PREFIX}${token}:e`;
export const settingsCatalogId = (token: string): string => `${SETTINGS_ID_PREFIX}${token}:c`;
export const settingsStateId = (token: string): string => `${SETTINGS_ID_PREFIX}${token}:s`;

/** Which native command of one settings op a settings answer names. */
export type SettingsPart = "model" | "effort" | "catalog" | "state";

const PART_SUFFIXES: Readonly<Record<Exclude<SettingsPart, "model">, string>> = {
  effort: ":e",
  catalog: ":c",
  state: ":s",
};

export const parseSettingsId = (
  id: unknown,
): { readonly token: string; readonly part: SettingsPart } | null => {
  if (typeof id !== "string" || !id.startsWith(SETTINGS_ID_PREFIX)) return null;
  const rest = id.slice(SETTINGS_ID_PREFIX.length);
  if (rest === "" || rest.includes(SETTINGS_ID_PREFIX)) return null;
  for (const [part, suffix] of Object.entries(PART_SUFFIXES) as Array<
    [Exclude<SettingsPart, "model">, string]
  >) {
    if (!rest.endsWith(suffix)) continue;
    const token = rest.slice(0, -suffix.length);
    return token === "" ? null : { token, part };
  }
  return { token: rest, part: "model" };
};

/** Session input kinds with a native mid-session settings mechanism. */
export const supportsSessionSettings = (kind: SessionInputKind): boolean =>
  kind === "claude-sdk-user-message" || kind === "pi-rpc-prompt";

export type SessionSettingsRejection = "invalid-model" | "invalid-effort" | "unsupported";

/** One settings op, validated the way the spawn flags validate. Pi's
 * model stays the caller's selector here: it resolves against the
 * session's own catalog (see resolvePiSessionModel) only after the
 * native `get_available_models` round trip, which validation cannot
 * make. */
export interface ValidatedSessionSettings {
  /** The model id as the harness knows it (Claude aliases resolved;
   * Pi: the syntactically valid selector, resolved later). */
  readonly model?: { readonly id: string };
  /** The effort word, from the harness's own ladder. */
  readonly effort?: string;
}

/** Validate a settings op exactly as the spawn flags do. Claude's model
 * resolves aliases here; Pi's model passes only the spawn flag's
 * selector check (blank, flag-shaped or shell-carrying strings refuse)
 * and resolves semantically against the native catalog afterwards. The
 * effort ladder is the resulting model's: the op's own model, else the
 * session's CURRENT model (the last one a settings op applied, tracked
 * by the runner, else the spawn model). Invalid values reject without a
 * native write. */
export const validateSessionSettings = (
  h: HarnessDescriptor,
  input: SessionInputContract,
  request: { readonly model?: string; readonly effort?: string },
  session: { readonly model?: string; readonly provider?: string } = {},
):
  | { readonly ok: true; readonly value: ValidatedSessionSettings }
  | { readonly ok: false; readonly reason: SessionSettingsRejection } => {
  const kind = input.kind;
  if (!supportsSessionSettings(kind)) return { ok: false, reason: "unsupported" };
  let value: ValidatedSessionSettings = {};
  if (request.model !== undefined) {
    const validated = validateModel(h, request.model);
    if (!validated.ok) return { ok: false, reason: "invalid-model" };
    value = { ...value, model: { id: validated.id } };
  }
  if (request.effort !== undefined) {
    const ladderFor = request.model ?? session.model;
    const validated = validateEffort(h, request.effort, ladderFor);
    if (!validated.ok) return { ok: false, reason: "invalid-effort" };
    value = { ...value, effort: validated.id };
  }
  return { ok: true, value };
};

/** One entry of Pi's `get_available_models` response - the fields the
 * resolver reads, not the full Model object. `name` is the display name
 * pi's fuzzy matching also considers. */
export interface PiModelEntry {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/** The {provider, modelId} pair Pi's `set_model` takes. */
export interface PiModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export type PiModelResolution =
  | {
      readonly status: "resolved";
      readonly ref: PiModelRef;
      /** A `<model>:<level>` selector's parsed thinking level, the way
       * pi's `--model` parses it (see resolvePiSessionModel). */
      readonly thinkingLevel?: string;
    }
  | { readonly status: "invalid" };

/** The suffixes a model selector may carry: pi 1.4.0's thinking-level
 * vocabulary, read from the descriptor's own effort ladder so the
 * suffix parse and effort validation cannot drift apart (review round
 * 3, H3). */
const PI_THINKING_LEVELS: readonly string[] = piCli.vocabulary.efforts;

/** `model:level` suffix split, exactly pi's `splitThinkingSuffix`: the
 * text after the LAST colon must be a thinking level, else the colon
 * stays part of the id. */
const splitThinkingSuffix = (
  text: string,
): { readonly base: string; readonly thinkingLevel: string } | undefined => {
  const colonIndex = text.lastIndexOf(":");
  if (colonIndex === -1) return undefined;
  const suffix = text.substring(colonIndex + 1);
  if (!PI_THINKING_LEVELS.includes(suffix)) return undefined;
  return { base: text.substring(0, colonIndex), thinkingLevel: suffix };
};

/** `provider/rest` split, exactly pi's `splitProviderPrefix`: the prefix
 * must name a provider in the pool (case-insensitively), else the whole
 * text stays one id. */
const splitProviderPrefix = (
  text: string,
  pool: readonly PiModelEntry[],
): { readonly provider: string; readonly modelText: string } | undefined => {
  const slashIndex = text.indexOf("/");
  if (slashIndex === -1) return undefined;
  const prefix = text.substring(0, slashIndex).trim().toLowerCase();
  const modelText = text.substring(slashIndex + 1).trim();
  if (prefix === "" || modelText === "") return undefined;
  const provider = pool.find((model) => model.provider.toLowerCase() === prefix)?.provider;
  return provider === undefined ? undefined : { provider, modelText };
};

const toRef = (model: PiModelEntry): PiModelRef => ({
  provider: model.provider,
  modelId: model.id,
});

type ReferencePick =
  | { readonly resolved: PiModelRef }
  | { readonly ambiguous: true }
  | { readonly notFound: true };

/** pi's `selectReference`, ported: exact matches and `provider/rest`
 * splitting with the named provider preferred. `provider/rest` is only a
 * hint - the whole text may also be an id on another provider (a gateway
 * id such as `moonshotai/kimi-k2.6`); the named candidate wins a
 * cross-provider tie, then a sole other, then the named candidate over
 * no usable alternative. Ambiguity short-circuits fuzzy matching,
 * exactly as in pi. Every candidate comes from the session's catalog,
 * so pi's `hasConfiguredAuth` tiebreak reads true for all of them and
 * the membership scan is gone (review round 3, H7). */
const selectReference = (text: string, pool: readonly PiModelEntry[]): ReferencePick => {
  const lowerText = text.toLowerCase();
  const raw = pool.filter((model) => model.id.toLowerCase() === lowerText);
  const split = splitProviderPrefix(text, pool);
  let named: PiModelEntry | undefined;
  if (split !== undefined) {
    const providerModels = pool.filter((model) => model.provider === split.provider);
    const lowerModelText = split.modelText.toLowerCase();
    // The provider's own literal id (OpenRouter's `openrouter/free`)
    // beats its fuzzy matches.
    named =
      providerModels.find((model) => model.id.toLowerCase() === lowerModelText) ??
      raw.find((model) => model.provider === split.provider) ??
      bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels));
  }
  const others = raw.filter((model) => model !== named);
  const candidates = named === undefined ? others : [named, ...others];
  if (candidates.length === 0) return { notFound: true };
  const first = candidates[0];
  if (first === undefined) return { notFound: true };
  if (new Set(candidates.map((model) => model.provider)).size === 1)
    return { resolved: toRef(first) };
  if (named !== undefined) return { resolved: toRef(named) };
  const sole = others[0];
  if (others.length === 1 && sole !== undefined) return { resolved: toRef(sole) };
  return { ambiguous: true };
};

const fuzzyMatches = (text: string, models: readonly PiModelEntry[]): readonly PiModelEntry[] => {
  const lowerText = text.toLowerCase();
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(lowerText) || model.name?.toLowerCase().includes(lowerText),
  );
};

/** pi's `selectFuzzy`: the best match's id must sit on one provider,
 * else the selector is ambiguous (the same id on several providers
 * would otherwise be decided by catalog order). */
const selectFuzzy = (matches: readonly PiModelEntry[]): ReferencePick => {
  if (matches.length === 0) return { notFound: true };
  const best = bestFuzzyMatch(matches);
  if (best === undefined) return { notFound: true };
  const tied = matches.filter((model) => model.id === best.id);
  if (new Set(tied.map((model) => model.provider)).size === 1) return { resolved: toRef(best) };
  return { ambiguous: true };
};

/** Prefer aliases (`claude-sonnet-4-5`) over dated versions
 * (`claude-sonnet-4-5-20250929`), then the greatest id - pi's ranking. */
const bestFuzzyMatch = (matches: readonly PiModelEntry[]): PiModelEntry | undefined => {
  const aliases = matches.filter((model) => isAlias(model.id));
  const ranked = [...(aliases.length > 0 ? aliases : matches)].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
  return ranked[0];
};

const isAlias = (id: string): boolean => id.endsWith("-latest") || !/-\d{8}$/.test(id);

type TextResolve =
  | { readonly status: "resolved"; readonly ref: PiModelRef; readonly thinkingLevel?: string }
  | { readonly status: "refused" };

/** pi's `resolveText` under the CLI's `strict` suffix mode: reference
 * precedence first, then fuzzy matching, then a valid `model:level`
 * suffix recursing on the model half (pi's caller applies the level;
 * hcn's sequencer does the same). An invalid suffix stays part of the id
 * and fails - it never resolves a different model. */
const resolveText = (text: string, pool: readonly PiModelEntry[]): TextResolve => {
  const reference = selectReference(text, pool);
  if ("resolved" in reference) return { status: "resolved", ref: reference.resolved };
  if ("ambiguous" in reference) return { status: "refused" };
  const fuzzy = selectFuzzy(fuzzyMatches(text, pool));
  if ("resolved" in fuzzy) return { status: "resolved", ref: fuzzy.resolved };
  if ("ambiguous" in fuzzy) return { status: "refused" };
  const thinking = splitThinkingSuffix(text);
  if (thinking !== undefined) {
    const inner = resolveText(thinking.base, pool);
    if (inner.status === "refused") return inner;
    return { ...inner, thinkingLevel: thinking.thinkingLevel };
  }
  return { status: "refused" };
};

/** Resolve one Pi model selector against the session's own catalog, a
 * faithful port of pi 1.4.0's `resolveCliModel` (the spawn flag's
 * resolver) as a pure function over the `get_available_models` entries:
 * the same reference precedence (`selectReference`), the same fuzzy
 * matching, the same `<model>:<level>` suffix parse, minus the pieces
 * that need credentials or pi's custom-model fallback (a settings op
 * that cannot resolve rejects `invalid-model` instead):
 *
 * - The session's `--provider` constrains the pool the way the spawn
 *   flag does, and a provider absent from the catalog (or an unknown
 *   `--provider`) refuses; the catalog IS the available set, so pi's
 *   `hasConfiguredAuth` tiebreak reads true for every candidate: a
 *   named candidate always wins a cross-provider tie, exactly as it
 *   does at spawn over an authenticated catalog (the selector
 *   `moonshotai/kimi-k2.6` with both OpenRouter's gateway id
 *   `moonshotai/kimi-k2.6` and Moonshot's own `kimi-k2.6` available
 *   resolves to Moonshot).
 * - An ambiguous or unmatched selector refuses; pi's fallback to a
 *   custom model id is not part of this surface.
 */
export const resolvePiSessionModel = (
  catalog: readonly PiModelEntry[],
  request: { readonly text: string; readonly provider?: string },
): PiModelResolution => {
  const text = request.text.trim();
  if (text === "") return { status: "invalid" };
  const constrain = request.provider?.toLowerCase();
  const pool =
    constrain === undefined
      ? catalog
      : catalog.filter((entry) => entry.provider.toLowerCase() === constrain);
  if (pool.length === 0) return { status: "invalid" };
  const result = resolveText(text, pool);
  if (result.status === "refused") return { status: "invalid" };
  return {
    status: "resolved",
    ref: result.ref,
    ...(result.thinkingLevel === undefined ? {} : { thinkingLevel: result.thinkingLevel }),
  };
};

/** The catalog of a Pi `get_available_models` response: entries with a
 * string provider and id, others dropped. The optional display `name`
 * rides along when present - pi's fuzzy matching considers it. */
export const piCatalogOf = (parsed: Record<string, unknown>): readonly PiModelEntry[] => {
  const models = asRecord(parsed.data)?.models;
  if (!Array.isArray(models)) return [];
  const entries: PiModelEntry[] = [];
  for (const raw of models) {
    const model = asRecord(raw);
    if (model === null) continue;
    if (typeof model.provider !== "string" || model.provider === "") continue;
    if (typeof model.id !== "string" || model.id === "") continue;
    entries.push({
      provider: model.provider,
      id: model.id,
      ...(typeof model.name === "string" && model.name !== "" ? { name: model.name } : {}),
    });
  }
  return entries;
};

/** What a Pi `get_state` answer says hcn's receipt reports: the
 * effective model (provider/id) and thinking level. */
export interface PiStateAnswer {
  readonly model?: PiModelRef;
  readonly thinkingLevel?: string;
}

export const piStateOf = (parsed: Record<string, unknown>): PiStateAnswer => {
  const data = asRecord(parsed.data);
  if (data === null) return {};
  const rawModel = asRecord(data.model);
  const model =
    rawModel !== null &&
    typeof rawModel.provider === "string" &&
    rawModel.provider !== "" &&
    typeof rawModel.id === "string" &&
    rawModel.id !== ""
      ? { provider: rawModel.provider, modelId: rawModel.id }
      : undefined;
  return {
    ...(model === undefined ? {} : { model }),
    ...(typeof data.thinkingLevel === "string" && data.thinkingLevel !== ""
      ? { thinkingLevel: data.thinkingLevel }
      : {}),
  };
};

/** The native command(s) one validated half of a settings op becomes.
 * Claude writes control requests; pi writes rpc commands. Each carries
 * the request id its answer will name, so the runner can correlate. */
export const encodeSessionSettingsModel = (
  input: SessionInputContract,
  requestId: string,
  model: { readonly id: string; readonly pi?: PiModelRef },
): string =>
  input.kind === "claude-sdk-user-message"
    ? `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_model", model: model.id },
      })}\n`
    : `${JSON.stringify({
        id: requestId,
        type: "set_model",
        provider: model.pi?.provider,
        modelId: model.pi?.modelId,
      })}\n`;

/** Effort is not cleared by a model change: this writes exactly the word
 * the op named (claude `effortLevel`, pi's thinking level). */
export const encodeSessionSettingsEffort = (
  input: SessionInputContract,
  requestId: string,
  effort: string,
): string =>
  input.kind === "claude-sdk-user-message"
    ? `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "apply_flag_settings", settings: { effortLevel: effort } },
      })}\n`
    : `${JSON.stringify({ id: requestId, type: "set_thinking_level", level: effort })}\n`;

/** Pi only: the catalog read that precedes a model write, so the model
 * resolves against the session's own providers exactly the way the
 * spawn flags resolve it. */
export const encodeSessionSettingsCatalog = (
  input: SessionInputContract,
  requestId: string,
): string =>
  input.kind === "pi-rpc-prompt"
    ? `${JSON.stringify({ id: requestId, type: "get_available_models" })}\n`
    : "";

/** Pi only: the state readback that follows the writes, so the receipt
 * reports the effective model and thinking level, not the requested
 * ones (pi clamps both silently). */
export const encodeSessionSettingsState = (
  input: SessionInputContract,
  requestId: string,
): string =>
  input.kind === "pi-rpc-prompt" ? `${JSON.stringify({ id: requestId, type: "get_state" })}\n` : "";

/** What one parsed native answer to a settings command says. `model` is
 * the native confirmation where the harness returns one (claude's
 * `response.model`, pi's `data.id`), else undefined. */
export interface SessionSettingsAnswer {
  readonly ok: boolean;
  readonly model?: string;
}

/** The answer inside a claude `control_response` to a settings control
 * request, or null when the record carries no usable answer shape. The
 * caller has already matched the response's request_id to the settings
 * prefix. */
export const claudeSettingsAnswerOf = (
  parsed: Record<string, unknown>,
): SessionSettingsAnswer | null => {
  const response = parsed.response;
  if (typeof response !== "object" || response === null) return null;
  const record = response as Record<string, unknown>;
  if (record.subtype !== "success") return { ok: false };
  const payload = record.response;
  const model =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).model
      : undefined;
  return {
    ok: true,
    ...(typeof model === "string" && model !== "" ? { model } : {}),
  };
};

/** The command each part of one op is answered by, so a response whose
 * command does not match the id it names (pi answering a model id with a
 * thinking response) settles nothing. */
const PART_COMMANDS: Readonly<Record<SettingsPart, readonly string[]>> = {
  model: ["set_model"],
  effort: ["set_thinking_level"],
  catalog: ["get_available_models"],
  state: ["get_state"],
};

/** The answer inside a pi rpc response to a settings command, or null
 * when the record is not one: the command must be the one the id's part
 * names. The caller has already matched the id to the settings prefix. */
export const piSettingsAnswerOf = (
  parsed: Record<string, unknown>,
  part: SettingsPart,
): SessionSettingsAnswer | null => {
  if (typeof parsed.command !== "string") return null;
  if (!PART_COMMANDS[part].includes(parsed.command)) return null;
  if (parsed.success !== true) return { ok: false };
  const data = parsed.data;
  const model =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).id : undefined;
  return {
    ok: true,
    ...(typeof model === "string" && model !== "" ? { model } : {}),
  };
};
