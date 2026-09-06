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
 *
 * The render-to-tokens rule itself has one owner, `tokensFor` in the
 * knowledge layer (RFC-02 change 1): every arm here validates its value,
 * resolves the render for the phase, and calls it.
 */
import type { AccessValue, HarnessDescriptor, SpecBase } from "../knowledge/descriptor.js";
import {
  ACCESS_VALUES,
  DISCOVERY_FACETS,
  resolveRender,
  TURN_OPTION_KEYS,
  tokensFor,
} from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import type { DiscoveryOptions, TurnOptions } from "./argv.js";
import { hintFor } from "./hints.js";
import { ArgvRefusalError } from "./refusal.js";
import { renderToolSelection } from "./tool-selection.js";
import { canonicalTable, hasCounterpart, READ_PRESET } from "./tool-vocabulary.js";
import { CLEAN_SELECTOR, resolveModel, validateAccess, validateEffort } from "./vocabulary.js";

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
  // The turn option the access preset displaces when set (codex: sandbox),
  // read from the descriptor so no arm below branches on a harness name.
  const accessSpec = h.turnOptions.access;
  const claimed = accessSpec?.kind === "access" ? accessSpec.claims : undefined;

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
        const facetSpec = spec.facets[facet];
        if (facetSpec === undefined) {
          // A facet the descriptor does not declare cannot be expressed.
          // Only a value that would have emitted refuses: every current
          // facet has "disables" polarity, so false would emit.
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
        // Polarity: disables emits on false, enables emits on true.
        const shouldEmit =
          (facetSpec.polarity === "disables" && val === false) ||
          (facetSpec.polarity === "enables" && val === true);
        if (!shouldEmit) continue;
        const effective = resolveRender(facetSpec, phase);
        if (effective === null) {
          const resumeSupported = Object.entries(spec.facets)
            .filter(([, v]) => resolveRender(v as SpecBase, "resume") !== null)
            .map(([k]) => k);
          throw new ArgvRefusalError({
            issue: "unsupported-on-resume",
            harness: h.name,
            option: "discovery",
            facet,
            supported: resumeSupported.length ? resumeSupported : ["(none resume)"],
          });
        }
        // Discovery is not a closed vocabulary, so config-kv cannot carry it.
        if (effective.kind === "config-kv") {
          throw new ArgvRefusalError({
            issue: "invalid-option-value",
            harness: h.name,
            option: "discovery",
            facet,
            supported: ["flag-list only for discovery"],
          });
        }
        sequences.push([...tokensFor(effective)]);
      }
      continue;
    }

    // Access is opt-in-only, no profile default. One arm for every harness:
    // the descriptor says whether a value renders through the tool list, a
    // phase-aware render, or nothing at all.
    if (key === "access") {
      if (raw === undefined) continue;
      if (spec === undefined || spec.kind !== "access") {
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: key,
          supported: Object.keys(h.turnOptions).length ? Object.keys(h.turnOptions) : ["(none)"],
          detail: String(raw),
          hint: hintFor(h.name, key),
        });
      }
      // The resume path builds from unresolved options, so the value is
      // checked here as well as in option resolution - one rule, two gates.
      const v = validateAccess(String(raw));
      if (!v.ok) {
        throw new ArgvRefusalError({
          issue: "invalid-option-value",
          harness: h.name,
          option: key,
          supported: [...ACCESS_VALUES],
          detail: String(raw),
        });
      }
      const value = v.id as AccessValue;
      const target = spec.renders[value];
      if (target === null) continue;
      if (target === "tool-preset") {
        // The read preset rides the tool list. When discovery.tools is off,
        // it must not switch tools back on; write is no restriction.
        if (value !== "read" || opts.discovery?.tools === false) continue;
        const table = canonicalTable(defaultDescriptors());
        const filtered = (READ_PRESET as readonly string[]).filter((c) =>
          hasCounterpart(table, c, h.name, opts.toolMap),
        );
        if (filtered.length === 0) continue;
        const rendered = renderToolSelection(h, { include: filtered, toolMap: opts.toolMap });
        if (rendered.tokens.length > 0) sequences.push([...rendered.tokens]);
        continue;
      }
      const render = resolveRender(target, phase);
      if (render === null) {
        throw new ArgvRefusalError({
          issue: "unsupported-on-resume",
          harness: h.name,
          option: key,
          supported: ["re-launch with --access, or resume without it"],
        });
      }
      sequences.push([...tokensFor(render, target.value)]);
      continue;
    }

    // Non-discovery keys
    // Handle enum default on launch. A set access preset displaces the
    // option it claims (codex: sandbox), so that option's default must not
    // emit a second flag beside the preset's.
    if (raw === undefined) {
      if (key === claimed && opts.access !== undefined) continue;
      if (
        spec !== undefined &&
        spec.kind === "enum" &&
        spec.default !== undefined &&
        phase === "launch"
      ) {
        const effective = resolveRender(spec, phase);
        if (effective === null) continue; // should not happen for launch
        // config-kv is allowed for enum (closed vocab) - no rejection needed here
        sequences.push([...tokensFor(effective, spec.default)]);
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

    // From here every spec carries a render: the discovery table and the
    // access spec were handled above and left the loop with `continue`.
    if (spec.kind === "discovery" || spec.kind === "access") continue;

    // Check resumeRender null => unsupported-on-resume
    const render = resolveRender(spec, phase);
    if (render === null) {
      const resumeSupported = TURN_OPTION_KEYS.filter((k) => {
        const s = h.turnOptions[k];
        if (!s) return false;
        if (s.kind === "discovery") return Object.keys(s.facets).length > 0;
        if (s.kind === "access") {
          const read = s.renders.read;
          return (
            read === "tool-preset" || (read !== null && resolveRender(read, "resume") !== null)
          );
        }
        return resolveRender(s, "resume") !== null;
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
      spec.render.kind === "config-kv" &&
      spec.kind !== "enum" &&
      spec.kind !== "effort" &&
      spec.kind !== "prompt-text"
    ) {
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: h.name,
        option: key,
        supported: ["config-kv only for enum, effort, and prompt-text (issue #48)"],
      });
    }

    // Per-kind validation; token generation is tokensFor's alone.
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
        sequences.push([...tokensFor(render, raw)]);
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
        sequences.push([...tokensFor(render, raw)]);
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
        sequences.push([...tokensFor(render, raw, "verbatim")]);
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
        sequences.push([...tokensFor(render, raw)]);
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
        const shouldEmit =
          (spec.polarity === "disables" && raw === false) ||
          (spec.polarity === "enables" && raw === true);
        if (!shouldEmit) break;
        sequences.push([...tokensFor(render, String(raw))]);
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
        sequences.push([...tokensFor(render, String(raw))]);
        break;
      }
      default: {
        const _exhaustive: never = spec;
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

  // De-duplication by exact token sequence, first occurrence winning
  const seen = new Set<string>();
  const deduped: string[][] = [];
  for (const seq of sequences) {
    const k = seq.join("\0");
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(seq);
  }
  return deduped.flat();
};
