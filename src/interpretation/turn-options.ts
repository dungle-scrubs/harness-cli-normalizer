/**
 * turn-options: rendering and validation of per-call turn options into argv.
 *
 * This lives separately from argv.ts because argv.ts owns argv *assembly and
 * ordering* (where the prompt goes, that tools is last, that resume never
 * inherits launch flags). Turn-option *rendering and validation* - which
 * flag spells a dimension, how its value is validated and quoted, and when
 * it must refuse - is a distinct responsibility with its own vocabulary.
 * Folding it into argv.ts would make the largest interpretation file the
 * place two unrelated questions are answered.
 */
import type { HarnessDescriptor, OptionRender, SpecBase } from "../knowledge/descriptor.js";
import { DISCOVERY_FACETS, resolveRender, TURN_OPTION_KEYS } from "../knowledge/descriptor.js";
import type { DiscoveryOptions, TurnOptions } from "./argv.js";
import { hintFor } from "./hints.js";
import { ArgvRefusalError } from "./refusal.js";
import { renderToolSelection } from "./tool-selection.js";
import { CLEAN_SELECTOR, resolveModel, validateEffort } from "./vocabulary.js";

// TOML-quoted value for config-kv: JSON.stringify is sufficient for the
// closed vocabularies that may use it (enum, effort) - no value contains a
// quote that would need escaping beyond JSON's.
const tomlQuote = (value: string): string => JSON.stringify(value);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Render turn options for a given phase, in TURN_OPTION_KEYS order and with
 * discovery facets in DISCOVERY_FACETS order, de-duplicating by exact token
 * sequence (first wins) so claude's two facets sharing one flag emit once. */
export const renderTurnOptions = (
  h: HarnessDescriptor,
  opts: TurnOptions,
  phase: "launch" | "resume",
): string[] => {
  const sequences: string[][] = [];

  // Access mutual exclusivity: access preset vs explicit tool selection
  const accessRaw = (opts as unknown as Record<string, unknown>).access as string | undefined;
  if (accessRaw !== undefined) {
    if (opts.tools !== undefined || opts.excludeTools !== undefined) {
      throw new ArgvRefusalError({
        issue: "mutually-exclusive-options",
        harness: h.name,
        option: "access",
        supported: ["--access is a preset allowlist, not a filter over --tools/--exclude-tools"],
        detail: "mutual exclusion",
      });
    }
  }
  // Validate access value early if present
  if (accessRaw !== undefined && accessRaw !== "read" && accessRaw !== "write") {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: h.name,
      option: "access",
      supported: ["read", "write"],
      detail: String(accessRaw),
    });
  }

  for (const key of TURN_OPTION_KEYS) {
    const spec = h.turnOptions[key];
    const raw = (opts as unknown as Record<string, unknown>)[key];

    // Discovery is a table of facets, handled separately.
    if (key === "discovery") {
      const discovery = raw as DiscoveryOptions | undefined;
      // omitted, null, or {} => no-op
      if (discovery === undefined || discovery === null) continue;
      if (!isPlainObject(discovery as unknown)) {
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: "discovery",
          supported: ["discovery must be an object"],
          detail: String(raw),
        });
      }
      const discObj = discovery as Record<string, unknown>;
      // If spec absent, any facet set to false must refuse.
      if (spec === undefined) {
        const requested = DISCOVERY_FACETS.filter((f) => discObj[f] === false);
        if (requested.length === 0) continue;
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: "discovery",
          supported: Object.keys(h.turnOptions).length ? Object.keys(h.turnOptions) : ["(none)"],
          detail: String(requested[0]),
          hint: hintFor(h.name, `discovery.${String(requested[0])}`),
        });
      }
      if (spec.kind !== "discovery") {
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: "discovery",
          supported: ["discovery spec malformed"],
        });
      }
      // Validate each facet value is boolean if present
      for (const facet of DISCOVERY_FACETS) {
        if (!(facet in discObj)) continue;
        const v = discObj[facet];
        if (v !== undefined && typeof v !== "boolean") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: "discovery",
            facet,
            supported: ["true or false"],
            detail: String(v),
          });
        }
      }
      // Render facets in DISCOVERY_FACETS order
      for (const facet of DISCOVERY_FACETS) {
        const val = discObj[facet];
        if (val === undefined) continue;
        // Polarity handling: disables emits on false, enables emits on true
        const facetSpec = spec.facets[facet];
        if (facetSpec === undefined) {
          // If caller asked to disable (false for disables, true for enables) but facet not declared, refuse
          // But if caller passed true for a disables facet, it's a no-op, not a refusal
          // So only refuse when the caller's value would have emitted
          // For all current descriptors polarity is disables, so false would emit -> refuse
          // For safety, check wouldEmit logic
          // If val would not emit anyway, skip
          // Determine wouldEmit: if facetSpec undefined, we cannot know polarity, so treat false as intended disable -> refuse
          if (val === false) {
            const supportedFacets = Object.keys(spec.facets);
            throw new ArgvRefusalError({
              issue: "unsupported-option-facet",
              harness: h.name,
              option: "discovery",
              facet,
              supported: supportedFacets.length ? supportedFacets : ["(none)"],
              hint: hintFor(h.name, `discovery.${facet}`),
            });
          }
          continue;
        }
        // Determine if this value should emit
        let shouldEmit = false;
        if (facetSpec.polarity === "disables" && val === false) shouldEmit = true;
        else if (facetSpec.polarity === "enables" && val === true) shouldEmit = true;
        else {
          // true for disables or false for enables => no-op
          continue;
        }
        if (!shouldEmit) continue;
        // Check resumeRender refusal
        const effective = resolveRender(facetSpec, phase);
        if (effective === null) {
          const resumeSupported = Object.entries(spec.facets)
            .filter(
              ([, v]) =>
                resolveRender(
                  v as unknown as import("../knowledge/descriptor.js").SpecBase,
                  "resume",
                ) !== null,
            )
            .map(([k]) => k);
          throw new ArgvRefusalError({
            issue: "unsupported-on-resume",
            harness: h.name,
            option: "discovery",
            facet,
            supported: resumeSupported.length ? resumeSupported : ["(none resume)"],
          });
        }
        // Reject config-kv for discovery (only closed vocab, discovery is not)
        if ((effective as OptionRender).kind === "config-kv") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: "discovery",
            facet,
            supported: ["flag-list only for discovery"],
          });
        }
        let seq: string[];
        if ((effective as OptionRender).kind === "flag-list")
          seq = [...(effective as Extract<OptionRender, { kind: "flag-list" }>).flags];
        else if ((effective as OptionRender).kind === "flag-value")
          seq = [(effective as Extract<OptionRender, { kind: "flag-value" }>).flag, ""];
        else seq = [];
        sequences.push(seq);
      }
      continue;
    }

    // Access is opt-in-only, no profile default; handle per harness rendering.
    if (key === "access") {
      if (raw === undefined) continue;
      if (spec === undefined) {
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: key,
          supported: Object.keys(h.turnOptions).length ? Object.keys(h.turnOptions) : ["(none)"],
          detail: String(raw),
          hint: hintFor(h.name, key),
        });
      }
      if (typeof raw !== "string" || (raw !== "read" && raw !== "write")) {
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: key,
          supported: ["read", "write"],
          detail: String(raw),
        });
      }
      // Discovery.tools off suppresses read preset grant (F-12 containment)
      if (raw === "read" && (opts.discovery as DiscoveryOptions | undefined)?.tools === false) {
        // Still respect the tool-preset skip - never re-enable tools when discovery turned them off.
        if ((spec as { kind: string }).kind === "tool-preset") continue;
      }
      switch ((spec as { kind: string }).kind) {
        case "tool-preset": {
          if (raw === "write") break;
          // read = canonical read subset, filtered to harness expressible names
          const preset = ["read", "grep", "glob", "list", "web-fetch", "web-search"] as const;
          const toolMapForHarness = (opts as { toolMap?: Record<string, Record<string, string>> })
            .toolMap?.[h.name];
          // Filter to harness-expressible canonicals (including toolMap overrides)
          const filtered = (preset as readonly string[]).filter((c) => {
            if (toolMapForHarness?.[c] !== undefined) return true;
            if (h.tools.builtins.some((b) => b.canonical === c)) return true;
            if (h.tools.categories.some((cat) => (cat.canonical as readonly string[]).includes(c)))
              return true;
            return false;
          });
          if (filtered.length === 0) break;
          // Discovery off already handled above; otherwise render via tool-selection
          const rendered = renderToolSelection(h, {
            include: filtered as unknown as string[],
            toolMap: toolMapForHarness,
          });
          if (rendered.tokens.length > 0) sequences.push([...rendered.tokens]);
          break;
        }
        case "flag-value": {
          const fv = spec as { kind: "flag-value"; flag: string; values: Record<string, string> };
          const mapped = fv.values[raw];
          if (mapped !== undefined) sequences.push([fv.flag, mapped]);
          break;
        }
        case "flag-list-by-value": {
          const fl = spec as {
            kind: "flag-list-by-value";
            flags: Record<string, readonly string[]>;
          };
          const list = fl.flags[raw] ?? [];
          if (list.length > 0) sequences.push([...list]);
          break;
        }
        default: {
          const _exhaustive: never = spec as never;
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [],
            detail: String(_exhaustive),
          });
        }
      }
      continue;
    }

    // Non-discovery keys
    // Handle enum default on launch
    if (raw === undefined) {
      if (
        spec !== undefined &&
        spec.kind === "enum" &&
        spec.default !== undefined &&
        phase === "launch"
      ) {
        const effective = resolveRender(spec as unknown as SpecBase, phase);
        if (effective === null) continue; // should not happen for launch
        // config-kv is allowed for enum (closed vocab) - no rejection needed here
        let seq: string[];
        if ((effective as OptionRender).kind === "flag-value")
          seq = [(effective as Extract<OptionRender, { kind: "flag-value" }>).flag, spec.default];
        else if ((effective as OptionRender).kind === "config-kv")
          seq = [
            (effective as Extract<OptionRender, { kind: "config-kv" }>).flag,
            `${(effective as Extract<OptionRender, { kind: "config-kv" }>).key}=${tomlQuote(spec.default)}`,
          ];
        else if ((effective as OptionRender).kind === "flag-list")
          seq = [...(effective as Extract<OptionRender, { kind: "flag-list" }>).flags];
        else seq = [];
        sequences.push(seq);
      }
      continue;
    }

    // Raw is defined but spec is absent => unsupported-option
    if (spec === undefined) {
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        option: key,
        supported: Object.keys(h.turnOptions).length ? Object.keys(h.turnOptions) : ["(none)"],
        detail: String(raw),
        hint: hintFor(h.name, key),
      });
    }

    // Check resumeRender null => unsupported-on-resume
    // For discovery we handled per-facet; for others check spec
    if ((spec as { kind: string }).kind !== "discovery") {
      const effective = resolveRender(spec as unknown as SpecBase, phase);
      if (effective === null) {
        const resumeSupported = TURN_OPTION_KEYS.filter((k) => {
          const s = h.turnOptions[k];
          if (!s) return false;
          if ((s as { kind: string }).kind === "discovery") {
            const facets = (s as unknown as { facets: Record<string, unknown> }).facets;
            return Object.keys(facets).length > 0;
          }
          return resolveRender(s as unknown as SpecBase, "resume") !== null;
        }) as string[];
        throw new ArgvRefusalError({
          issue: "unsupported-on-resume",
          harness: h.name,
          option: key,
          supported: resumeSupported.length ? resumeSupported : ["(none)"],
        });
      }
      // Reject config-kv for open vocabularies. Exception (issue #48):
      // prompt-text rides config-kv VERBATIM on codex - both a literal and
      // a path are accepted (live-verified 0.146.1); no quoting, because
      // codex's k=v split takes the rest of the token raw and both probed
      // forms passed unquoted.
      if (
        (spec as unknown as SpecBase).render.kind === "config-kv" &&
        (spec as { kind: string }).kind !== "enum" &&
        (spec as { kind: string }).kind !== "effort" &&
        (spec as { kind: string }).kind !== "prompt-text"
      ) {
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: key,
          supported: ["config-kv only for enum, effort, and prompt-text (issue #48)"],
        });
      }
    }

    // Per-kind validation and token generation
    const effectiveRender =
      (spec as { kind: string }).kind === "discovery"
        ? null
        : resolveRender(spec as unknown as SpecBase, phase);
    // effectiveRender already checked for null

    switch (spec.kind) {
      case "effort": {
        if (typeof raw !== "string") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [...h.vocabulary.efforts],
            detail: String(raw),
          });
        }
        const validated = validateEffort(
          h,
          raw,
          (opts as unknown as Record<string, unknown>).model as string | undefined,
        );
        if (!validated.ok) {
          let ladder = h.vocabulary.efforts;
          const model = (opts as unknown as Record<string, unknown>).model as string | undefined;
          if (model !== undefined && h.vocabulary.effortsByModel !== undefined) {
            const { id } = resolveModel(h, model);
            const perModel = Object.hasOwn(h.vocabulary.effortsByModel, id)
              ? h.vocabulary.effortsByModel[id]
              : undefined;
            if (perModel !== undefined) ladder = perModel;
          }
          throw new ArgvRefusalError({
            issue: "unknown-effort",
            harness: h.name,
            option: key,
            supported: [...ladder],
            detail: raw,
          });
        }
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-value") seq = [r.flag, raw];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${tomlQuote(raw)}`];
        else if (r.kind === "flag-list") seq = [...r.flags];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "enum": {
        if (typeof raw !== "string") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [...spec.values],
            detail: String(raw),
          });
        }
        if (!spec.values.includes(raw)) {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [...spec.values],
            detail: raw,
          });
        }
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-value") seq = [r.flag, raw];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${tomlQuote(raw)}`];
        else if (r.kind === "flag-list") seq = [...r.flags];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "prompt-text": {
        // issue #48: free-form prompt prose (systemPrompt / appendSystemPrompt).
        // No closed vocabulary - validate non-empty string, render verbatim.
        // Values may be multi-line and may contain shell-hostile characters;
        // they cross as single argv tokens, never through a shell.
        if (typeof raw !== "string" || raw.trim() === "") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: ["non-empty prompt text"],
            detail: typeof raw === "string" ? "(empty)" : String(raw),
          });
        }
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-value") seq = [...(r.extraFlags ?? []), r.flag, raw];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${raw}`];
        else if (r.kind === "flag-list") seq = [...r.flags];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "selector": {
        if (typeof raw !== "string") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: ["CLEAN_SELECTOR"],
            detail: String(raw),
          });
        }
        if (!CLEAN_SELECTOR.test(raw)) {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: ["must match CLEAN_SELECTOR /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/"],
            detail: raw,
          });
        }
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-value") seq = [r.flag, raw];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${tomlQuote(raw)}`];
        else if (r.kind === "flag-list") seq = [...r.flags];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "toggle": {
        if (typeof raw !== "boolean") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: ["true or false"],
            detail: String(raw),
          });
        }
        let shouldEmit = false;
        if (spec.polarity === "disables" && raw === false) shouldEmit = true;
        else if (spec.polarity === "enables" && raw === true) shouldEmit = true;
        if (!shouldEmit) break;
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-list") seq = [...r.flags];
        else if (r.kind === "flag-value") seq = [r.flag, String(raw)];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${tomlQuote(String(raw))}`];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "integer": {
        if (typeof raw !== "number") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [`[${spec.min}, ${spec.max}] integer`],
            detail: String(raw),
          });
        }
        if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < spec.min || raw > spec.max) {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: key,
            supported: [`[${spec.min}, ${spec.max}] integer`],
            detail: String(raw),
          });
        }
        const r = effectiveRender!;
        let seq: string[];
        if (r.kind === "flag-value") seq = [r.flag, String(raw)];
        else if (r.kind === "config-kv") seq = [r.flag, `${r.key}=${tomlQuote(String(raw))}`];
        else if (r.kind === "flag-list") seq = [...r.flags];
        else seq = [];
        sequences.push(seq);
        break;
      }
      case "discovery":
        // already handled
        break;
      case "tool-preset":
      case "flag-value":
      case "flag-list-by-value":
        // access-only kinds - handled above for key === "access"
        break;
      default: {
        const _exhaustive: never = spec as never;
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: key,
          supported: [],
          detail: String(_exhaustive),
        });
      }
    }
  }

  // Flag-level coalescing for --sandbox: one winner, last wins (access over profile)
  const lastSandboxIdx = (() => {
    let idx = -1;
    for (let i = 0; i < sequences.length; i++) if (sequences[i]?.[0] === "--sandbox") idx = i;
    return idx;
  })();
  const coalesced =
    lastSandboxIdx === -1
      ? sequences
      : sequences.filter((s, i) => s[0] !== "--sandbox" || i === lastSandboxIdx);

  // De-duplication by exact token sequence, first occurrence winning
  const seen = new Set<string>();
  const deduped: string[][] = [];
  for (const seq of coalesced) {
    const k = seq.join("\0");
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(seq);
  }
  return deduped.flat();
};
