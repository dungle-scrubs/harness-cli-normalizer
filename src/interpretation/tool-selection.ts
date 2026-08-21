/**
 * Tool-selection rendering with canonical vocabulary.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { ArgvRefusalError } from "./refusal.js";
import { supportedBy } from "./support.js";
import { canonicalNames, canonicalToolTable } from "./tool-vocabulary.js";

export const TOOL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export interface ToolSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly toolMap?: Readonly<Record<string, string>>;
}

export interface RenderedToolSelection {
  readonly tokens: readonly string[];
  readonly unmapped: readonly string[];
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
  if (!hasInclude && !hasExclude) return { tokens: [], unmapped: [], passthrough: [] };

  // Helpers for canonical handling
  const baseCanonical = canonicalNames(defaultDescriptors());
  const table = canonicalToolTable(defaultDescriptors());
  const toolMap = selection.toolMap ?? {};
  const allCanonical = [...new Set([...baseCanonical, ...Object.keys(toolMap)])].sort();

  const splitSelection = (
    names: readonly string[],
  ): { canonical: string[]; passthrough: string[] } => {
    const canonical: string[] = [];
    const passthrough: string[] = [];
    for (const raw of names) {
      if (raw.startsWith("native:")) {
        const inner = raw.slice("native:".length);
        validateInnerName(h, inner, names as unknown as string[]);
        passthrough.push(inner);
        continue;
      }
      validateInnerName(h, raw, names as unknown as string[]);
      if (!allCanonical.includes(raw)) {
        throw new ArgvRefusalError({
          issue: "unknown-tool-name",
          harness: h.name,
          option: "tools",
          supported: allCanonical as unknown as string[],
          hint: "use native:<name> for an extension or MCP tool",
          detail: `unknown tool name(s) ${raw}`,
        });
      }
      canonical.push(raw);
    }
    return { canonical, passthrough };
  };

  const supportedByForCanonical = (canonical: string): { harness: string; spelling: string }[] => {
    const entry = table[canonical];
    if (!entry) return [];
    const out: { harness: string; spelling: string }[] = [];
    for (const [har, val] of Object.entries(entry)) {
      if (val === undefined) continue;
      const spelling = typeof val === "string" ? val : (val as { category: string }).category;
      out.push({ harness: har, spelling: typeof val === "string" ? val : spelling });
    }
    return out;
  };

  const hasCounterpart = (canonical: string, harness: HarnessDescriptor): boolean => {
    if (toolMap[canonical] !== undefined) return true;
    const entry = table[canonical];
    if (!entry) return false;
    return entry[harness.name] !== undefined;
  };

  const nativeFor = (canonical: string, harness: HarnessDescriptor): string | undefined => {
    if (toolMap[canonical] !== undefined) return toolMap[canonical];
    const entry = table[canonical];
    const val = entry?.[harness.name];
    if (typeof val === "string") return val;
    return undefined;
  };

  // Codex and muse have no list flags
  if (h.tools.includeFlag === null || h.tools.excludeFlag === null) {
    if (h.name === "codex") {
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        option: hasInclude ? "tools" : "excludeTools",
        supported: ["per-tool name lists"],
        supportedBy: supportedBy(defaultDescriptors(), hasInclude ? "tools" : "excludeTools"),
        hint: "nearest control on codex: category switches via config keys (features.shell_tool, web_search) or sandbox modes - see `hcn inspect codex`",
      });
    }
    if (h.name === "muse") {
      // muse category rendering
      const names = hasInclude ? selection.include! : selection.exclude!;
      const { canonical, passthrough } = splitSelection(names as readonly string[]);

      // For exclude: inexpressible refuses
      if (hasExclude) {
        for (const c of canonical) {
          if (!hasCounterpart(c, h)) {
            throw new ArgvRefusalError({
              issue: "unsupported-option",
              harness: h.name,
              option: "excludeTools",
              supported: ["per-tool name lists"],
              supportedBy: supportedByForCanonical(c),
              hint: "nearest control on muse: category switches (--disable-write, --disable-shell, --disable-web-tools) gate tool execution per session",
            });
          }
        }
        // collect categories to disable
        const cats = new Set<string>();
        for (const c of canonical) {
          const val = table[c]?.[h.name] as { category: string } | undefined;
          if (val && typeof val === "object" && "category" in val) cats.add(val.category);
        }
        const tokens: string[] = [];
        for (const cat of h.tools.categories) {
          if (cats.has(cat.key) && cat.disableFlag) tokens.push(cat.disableFlag);
        }
        return { tokens, unmapped: passthrough, passthrough };
      }

      // include path for muse: category switches based on absence
      // Check if all canonical are inexpressible (no counterpart)
      const hasExpressible = canonical.some((c) => hasCounterpart(c, h));
      // If no canonical (empty?) handle below; otherwise compute disables
      if (canonical.length === 0) {
        // empty include on muse: disable everything? treat as all disables?
        // spec: empty include would deny everything, but muse case not listed
        // We'll throw invalid-tool-grant as per pi? But for muse, includeFlag null path check above already?
        // Empty include list = deny everything. For muse strict? We'll emit all disable flags
        const tokens = h.tools.categories.map((c) => c.disableFlag).filter((f): f is string => !!f);
        return { tokens, unmapped: passthrough, passthrough };
      }
      // Determine which categories are granted (canonical member present)
      const grantedCats = new Set<string>();
      for (const c of canonical) {
        const val = table[c]?.[h.name] as { category: string } | undefined;
        if (val && typeof val === "object" && "category" in val) grantedCats.add(val.category);
      }
      const tokens: string[] = [];
      for (const cat of h.tools.categories) {
        if (!grantedCats.has(cat.key) && cat.disableFlag) tokens.push(cat.disableFlag);
      }
      // inexpressible names are no-op, already ignored for grants
      return { tokens, unmapped: passthrough, passthrough };
    }
    // fallback generic refusal
    const option = hasInclude ? "tools" : "excludeTools";
    const by = supportedBy(defaultDescriptors(), option);
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: h.name,
      option,
      supported: ["per-tool name lists"],
      supportedBy: by,
      hint: "nearest control on muse: category switches (--disable-write, --disable-shell, --disable-web-tools) gate tool execution per session",
    });
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
      return { tokens: [h.tools.excludeFlag, known.join(",")], unmapped: [], passthrough: [] };
    }
    const { canonical, passthrough } = splitSelection(names as readonly string[]);
    // check counterpart on this harness
    for (const c of canonical) {
      if (!hasCounterpart(c, h)) {
        throw new ArgvRefusalError({
          issue: "unsupported-option",
          harness: h.name,
          option: "tools",
          supported: ["per-tool name lists"],
          supportedBy: supportedByForCanonical(c),
          hint: `add toolMap.${h.name}.${c} to ~/.config/hcn/config.json or pass native:${c}`,
        });
      }
    }
    const mapped = canonical.map((c) => nativeFor(c, h)!).filter(Boolean);
    if (!h.tools.includeIsStrictAllowlist) {
      const known = h.tools.builtins.map((t) => t.name);
      const excluded = known.filter((n) => !mapped.includes(n));
      const tokens: string[] = [h.tools.includeFlag!, [...mapped, ...passthrough].join(",")];
      tokens.push(h.tools.excludeFlag!, excluded.join(","));
      return { tokens, unmapped: passthrough, passthrough };
    }
    return {
      tokens: [h.tools.includeFlag!, [...mapped, ...passthrough].join(",")],
      unmapped: passthrough,
      passthrough,
    };
  }

  // exclude
  const names = selection.exclude!;
  const { canonical, passthrough: excludedPassthrough } = splitSelection(
    names as readonly string[],
  );
  for (const c of canonical) {
    if (!hasCounterpart(c, h)) {
      throw new ArgvRefusalError({
        issue: "unsupported-option",
        harness: h.name,
        option: "excludeTools",
        supported: ["per-tool name lists"],
        supportedBy: supportedByForCanonical(c),
        hint: `add toolMap.${h.name}.${c} to ~/.config/hcn/config.json or pass native:${c}`,
      });
    }
  }
  if (excludedPassthrough.length > 0) {
    if (!h.tools.includeIsStrictAllowlist) {
      const mapped = canonical.map((c) => nativeFor(c, h)!);
      const tokens = [h.tools.excludeFlag!, [...mapped, ...excludedPassthrough].join(",")];
      return { tokens, unmapped: excludedPassthrough, passthrough: excludedPassthrough };
    }
    throw new ArgvRefusalError({
      issue: "unknown-tool-name",
      harness: h.name,
      option: "excludeTools",
      supported: [`known tool names: ${h.tools.builtins.map((t) => t.name).join(", ")}`],
      detail: `cannot exclude unknown name(s) ${excludedPassthrough.join(", ")}: the complement cannot be computed`,
    });
  }
  const mapped = canonical.map((c) => nativeFor(c, h)!);
  const known = h.tools.builtins.filter((t) => !mapped.includes(t.name));
  const kept = known.map((t) => t.name);
  if (!h.tools.includeIsStrictAllowlist) {
    return { tokens: [h.tools.excludeFlag!, mapped.join(",")], unmapped: [], passthrough: [] };
  }
  return { tokens: [h.tools.includeFlag!, kept.join(",")], unmapped: [], passthrough: [] };
};
