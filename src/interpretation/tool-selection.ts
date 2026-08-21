/**
 * Tool-selection rendering with canonical vocabulary.
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
  NATIVE_PREFIX,
  nativeFor,
  parseToolSelector,
  READ_PRESET,
  validateCanonicalList,
} from "./tool-vocabulary.js";

export const TOOL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export interface ToolSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly toolMap?: Readonly<Record<string, string>>;
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
  if (!TOOL_SELECTOR.test(name)) {
    throw new ArgvRefusalError({
      issue: "invalid-tool-grant",
      harness: h.name,
      supported: [`must match ${TOOL_SELECTOR.source}`],
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

export const renderAccessPreset = (
  h: HarnessDescriptor,
  access: "read" | "write",
  opts: { toolMap?: Readonly<Record<string, string>> } = {},
): string[] => {
  if (access === "write") return [];
  // read preset
  const filtered = (READ_PRESET as readonly string[]).filter((c) => {
    if (opts.toolMap?.[c] !== undefined) return true;
    const table = canonicalTable(defaultDescriptors());
    return table[c]?.[h.name] !== undefined;
  });
  if (filtered.length === 0) return [];
  // For tool-preset harnesses, render via tool-selection include
  const spec = h.turnOptions.access;
  if (spec && spec.kind === "tool-preset") {
    const rendered = renderToolSelection(h, { include: filtered, toolMap: opts.toolMap });
    return [...rendered.tokens];
  }
  // For flag-value / flag-list-by-value harnesses, caller should handle via spec mapping;
  // we return empty here so turn-options can map via spec values.
  return [];
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
  const toolMap = selection.toolMap ?? {};
  const allCanonical = allCanonicalNames(set, {
    [h.name]: toolMap as unknown as Record<string, string>,
  } as unknown as import("./tool-vocabulary.js").ToolMap);

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

  const isCodexShape = h.tools.includeFlag === null && h.tools.categories.length === 0;
  const isCategoryShape = h.tools.includeFlag === null && h.tools.categories.length > 0;

  if (isCodexShape) {
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
  if (isCategoryShape) {
    const names = hasInclude ? selection.include! : selection.exclude!;
    const { canonical, passthrough } = splitSelection(names);

    if (hasExclude) {
      // one helper replaces the three no-counterpart loops
      for (const c of canonical) {
        const has = toolMap[c] !== undefined || table[c]?.[h.name] !== undefined;
        if (!has) {
          throw new ArgvRefusalError({
            issue: "unsupported-option",
            harness: h.name,
            option: "excludeTools",
            supported: ["per-tool name lists"],
            supportedBy: supportedByCanonical(set, c),
            hint: hintFor(h.name, "excludeTools"),
          });
        }
      }
      const cats = categoriesFor(h, canonical, table);
      const tokens: string[] = [];
      for (const cat of h.tools.categories) {
        if (cats.has(cat.key) && cat.disableFlag) tokens.push(cat.disableFlag);
      }
      return { tokens, passthrough };
    }

    for (const c of canonical) {
      const has = toolMap[c] !== undefined || table[c]?.[h.name] !== undefined;
      if (!has) {
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: "tools",
          supported: ["per-tool name lists"],
          supportedBy: supportedByCanonical(set, c),
          hint: hintFor(h.name, "tools"),
        });
      }
    }
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

  // From here: h has list flags (claude, pi)
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
    for (const c of canonical) {
      const has = toolMap[c] !== undefined || table[c]?.[h.name] !== undefined;
      if (!has) {
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: "tools",
          supported: ["per-tool name lists"],
          supportedBy: supportedByCanonical(set, c),
          hint: `add toolMap.${h.name}.${c} to ~/.config/hcn/config.json or pass native:${c}`,
        });
      }
    }
    const mapped: string[] = [];
    for (const c of canonical) {
      let n: string | null = toolMap[c] ?? null;
      if (n === null) {
        const entry = table[c]?.[h.name];
        if (entry?.kind === "builtin") n = entry.native;
      }
      if (n) mapped.push(n);
    }
    if (!h.tools.includeIsStrictAllowlist) {
      // claude's include flag pre-approves without restricting, so an exact allowlist renders as the deny complement
      const known = h.tools.builtins.map((t) => t.name);
      const excluded = known.filter((n) => !mapped.includes(n));
      const tokens: string[] = [h.tools.includeFlag!, [...mapped, ...passthrough].join(",")];
      // only add exclude if needed? original pushed exclude even when? Keep original behavior: push excludeFlag excluded
      if (excluded.length > 0 || passthrough.length > 0) {
        tokens.push(h.tools.excludeFlag!, excluded.join(","));
      } else {
        // when all tools included, exclude nothing? but keep token? original pushed exclude always
        tokens.push(h.tools.excludeFlag!, excluded.join(","));
      }
      return { tokens, passthrough };
    }
    return {
      tokens: [h.tools.includeFlag!, [...mapped, ...passthrough].join(",")],
      passthrough,
    };
  }

  // exclude
  const names = selection.exclude!;
  const { canonical, passthrough: excludedPassthrough } = splitSelection(names);
  for (const c of canonical) {
    const has = toolMap[c] !== undefined || table[c]?.[h.name] !== undefined;
    if (!has) {
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        option: "excludeTools",
        supported: ["per-tool name lists"],
        supportedBy: supportedByCanonical(set, c),
        hint: `add toolMap.${h.name}.${c} to ~/.config/hcn/config.json or pass native:${c}`,
      });
    }
  }
  if (excludedPassthrough.length > 0) {
    if (!h.tools.includeIsStrictAllowlist) {
      const mapped = canonical.map(
        (c) => toolMap[c] ?? (table[c]?.[h.name] as { native: string } | undefined)?.native ?? c,
      );
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
  const mapped = canonical
    .map((c) => toolMap[c] ?? (table[c]?.[h.name] as { native: string } | undefined)?.native ?? "")
    .filter(Boolean);
  const known = h.tools.builtins.filter((t) => !mapped.includes(t.name));
  const kept = known.map((t) => t.name);
  if (!h.tools.includeIsStrictAllowlist) {
    return { tokens: [h.tools.excludeFlag!, mapped.join(",")], passthrough: [] };
  }
  return { tokens: [h.tools.includeFlag!, kept.join(",")], passthrough: [] };
};
