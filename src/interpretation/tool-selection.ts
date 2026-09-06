/**
 * Tool-selection rendering with canonical vocabulary. The descriptor's
 * denySemantics says which shape a harness has; the toolMap helpers in
 * tool-vocabulary.ts own the counterpart and native-name rules (RFC-02
 * changes 7 and 8) - nothing here restates them.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { hintFor } from "./hints.js";
import { ArgvRefusalError } from "./refusal.js";
import { supportedBy, supportedByCanonical } from "./support.js";
import {
  allCanonicalNames,
  canonicalTable,
  hasCounterpart,
  nativeFor,
  parseToolSelector,
  type ToolMap,
} from "./tool-vocabulary.js";
import { CLEAN_SELECTOR } from "./vocabulary.js";

export interface ToolSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** The merged toolMap, every harness; the renderer reads its own entry. */
  readonly toolMap?: ToolMap;
}

export interface RenderedToolSelection {
  readonly tokens: readonly string[];
  readonly passthrough: readonly string[];
}

const validateInnerName = (h: HarnessDescriptor, name: string, raw: readonly string[]): void => {
  if (name.trim() === "" || name.includes(",")) {
    throw new ArgvRefusalError({
      issue: "invalid-tool-grant",
      harness: h.name,
      supported: ["non-empty, comma-free tool names"],
      detail: `tools=${JSON.stringify(raw)}`,
    });
  }
  if (!CLEAN_SELECTOR.test(name)) {
    throw new ArgvRefusalError({
      issue: "invalid-tool-grant",
      harness: h.name,
      supported: [`must match ${CLEAN_SELECTOR.source}`],
      detail: name,
    });
  }
};

const categoriesFor = (
  h: HarnessDescriptor,
  canonicals: readonly string[],
  table: ReturnType<typeof canonicalTable>,
): Set<string> => {
  const cats = new Set<string>();
  for (const c of canonicals) {
    const val = table[c]?.[h.name];
    if (val?.kind === "category") cats.add(val.key);
  }
  return cats;
};

export const renderToolSelection = (
  h: HarnessDescriptor,
  selection: ToolSelection,
): RenderedToolSelection => {
  const hasInclude = selection.include !== undefined;
  const hasExclude = selection.exclude !== undefined;

  if (hasInclude && hasExclude) {
    throw new ArgvRefusalError({
      issue: "mutually-exclusive-options",
      harness: h.name,
      option: "tools",
      supported: ["--tools (exact allowlist) or --exclude-tools (complement), never both"],
      detail: "mutual exclusion",
    });
  }
  if (!hasInclude && !hasExclude) return { tokens: [], passthrough: [] };

  const set = defaultDescriptors();
  const table = canonicalTable(set);
  const toolMap = selection.toolMap;
  // Names this harness's own toolMap entry adds count as canonical here;
  // another harness's entries do not make a name expressible on this one.
  const own = toolMap?.[h.name];
  const allCanonical = allCanonicalNames(set, own === undefined ? undefined : { [h.name]: own });

  const splitSelection = (
    names: readonly string[],
  ): { canonical: string[]; passthrough: string[] } => {
    const canonical: string[] = [];
    const passthrough: string[] = [];
    const setForValidate = new Set(allCanonical);
    for (const raw of names) {
      const parsed = parseToolSelector(raw);
      if (parsed.kind === "native") {
        validateInnerName(h, parsed.name, names);
        passthrough.push(parsed.name);
        continue;
      }
      validateInnerName(h, parsed.name, names);
      if (!setForValidate.has(parsed.name)) {
        throw new ArgvRefusalError({
          issue: "unknown-tool-name",
          harness: h.name,
          option: "tools",
          supported: [...allCanonical],
          hint: "use native:<name> for an extension or MCP tool",
          detail: `unknown tool name(s) ${parsed.name}`,
        });
      }
      canonical.push(parsed.name);
    }
    return { canonical, passthrough };
  };

  /** Refuse the first canonical this harness cannot express. */
  const requireCounterparts = (
    canonical: readonly string[],
    option: "tools" | "excludeTools",
    hint: (c: string) => string | undefined,
  ): void => {
    for (const c of canonical) {
      if (hasCounterpart(table, c, h.name, toolMap)) continue;
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        option,
        supported: ["per-tool name lists"],
        supportedBy: supportedByCanonical(set, c),
        hint: hint(c),
      });
    }
  };

  // The descriptor says how a deny lands (RFC-02 change 7): no lists at
  // all (codex), a policy gate over category switches (muse), or removal
  // from the name list (claude, pi). Nothing here re-derives that shape.
  const semantics = h.tools.denySemantics;

  if (semantics === "no-lists") {
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: h.name,
      option: hasInclude ? "tools" : "excludeTools",
      supported: ["per-tool name lists"],
      supportedBy: supportedBy(set, hasInclude ? "tools" : "excludeTools"),
      hint:
        hintFor(h.name, hasInclude ? "tools" : "excludeTools") ??
        "nearest control on codex: category switches via config keys (features.shell_tool, web_search) or sandbox modes - see `hcn inspect codex`",
    });
  }
  if (semantics === "policy-gate") {
    const names = hasInclude ? selection.include! : selection.exclude!;
    const { canonical, passthrough } = splitSelection(names);

    if (hasExclude) {
      requireCounterparts(canonical, "excludeTools", () => hintFor(h.name, "excludeTools"));
      const cats = categoriesFor(h, canonical, table);
      const tokens: string[] = [];
      for (const cat of h.tools.categories) {
        if (cats.has(cat.key) && cat.disableFlag) tokens.push(cat.disableFlag);
      }
      return { tokens, passthrough };
    }

    requireCounterparts(canonical, "tools", () => hintFor(h.name, "tools"));
    if (canonical.length === 0) {
      const tokens = h.tools.categories.map((c) => c.disableFlag).filter((f): f is string => !!f);
      return { tokens, passthrough };
    }
    const grantedCats = categoriesFor(h, canonical, table);
    const tokens: string[] = [];
    for (const cat of h.tools.categories) {
      if (!grantedCats.has(cat.key) && cat.disableFlag) tokens.push(cat.disableFlag);
    }
    return { tokens, passthrough };
  }

  // From here: remove-from-set, the harness has name-list flags (claude, pi)
  const toolMapHint = (c: string): string =>
    `add toolMap.${h.name}.${c} to ~/.config/hcn/config.json or pass native:${c}`;
  const nativeNames = (canonical: readonly string[]): string[] =>
    canonical
      .map((c) => nativeFor(table, c, h.name, toolMap))
      .filter((n): n is string => n !== null);

  if (hasInclude) {
    const names = selection.include!;
    if (names.length === 0) {
      if (h.tools.includeIsStrictAllowlist) {
        throw new ArgvRefusalError({
          issue: "invalid-tool-grant",
          harness: h.name,
          option: "tools",
          supported: ["non-empty tool list (empty include would deny everything)"],
          detail: "empty include list",
        });
      }
      const known = h.tools.builtins.map((t) => t.name);
      return { tokens: [h.tools.excludeFlag!, known.join(",")], passthrough: [] };
    }
    const { canonical, passthrough } = splitSelection(names);
    requireCounterparts(canonical, "tools", toolMapHint);
    const mapped = nativeNames(canonical);
    if (!h.tools.includeIsStrictAllowlist) {
      // claude's include flag pre-approves without restricting, so an exact
      // allowlist renders as the deny complement - always, even when the
      // complement is empty.
      const known = h.tools.builtins.map((t) => t.name);
      const excluded = known.filter((n) => !mapped.includes(n));
      return {
        tokens: [
          h.tools.includeFlag!,
          [...mapped, ...passthrough].join(","),
          h.tools.excludeFlag!,
          excluded.join(","),
        ],
        passthrough,
      };
    }
    return {
      tokens: [h.tools.includeFlag!, [...mapped, ...passthrough].join(",")],
      passthrough,
    };
  }

  // exclude
  const names = selection.exclude!;
  const { canonical, passthrough: excludedPassthrough } = splitSelection(names);
  requireCounterparts(canonical, "excludeTools", toolMapHint);
  const mapped = nativeNames(canonical);
  if (excludedPassthrough.length > 0) {
    if (!h.tools.includeIsStrictAllowlist) {
      const tokens = [h.tools.excludeFlag!, [...mapped, ...excludedPassthrough].join(",")];
      return { tokens, passthrough: excludedPassthrough };
    }
    throw new ArgvRefusalError({
      issue: "unknown-tool-name",
      harness: h.name,
      option: "excludeTools",
      supported: [`known tool names: ${h.tools.builtins.map((t) => t.name).join(", ")}`],
      detail: `cannot exclude unknown name(s) ${excludedPassthrough.join(", ")}: the complement cannot be computed`,
    });
  }
  const kept = h.tools.builtins.filter((t) => !mapped.includes(t.name)).map((t) => t.name);
  if (!h.tools.includeIsStrictAllowlist) {
    return { tokens: [h.tools.excludeFlag!, mapped.join(",")], passthrough: [] };
  }
  return { tokens: [h.tools.includeFlag!, kept.join(",")], passthrough: [] };
};
