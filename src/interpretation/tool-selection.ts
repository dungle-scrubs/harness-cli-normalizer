/**
 * Tool-selection rendering: turns normalized include/exclude lists into the
 * per-harness argv tokens, per decisions D1-D3 and the Phase 0 evidence.
 *
 * Semantics:
 * - include: exact allowlist over the descriptor's curated names. pi's flag
 *   is strict over built-ins, rendered directly. claude's include flag only
 *   pre-approves without restricting the visible set, so an exact allowlist
 *   on claude renders as a deny-complement (all known minus included).
 * - exclude: the complement of the named tools over all descriptor-known
 *   names (D2). pi's native exclude subtracts from its default set (4
 *   tools), so a D2 exclude renders as a computed include list there.
 * - mutual exclusion (D1): both flags in one call refuse.
 * - extensible rule (D3): curated names validate and map; unknown
 *   clean-selector names pass through and are reported as unmapped so
 *   provenance can surface them.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { ArgvRefusalError } from "./refusal.js";
import { supportedBy } from "./support.js";

export const TOOL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export interface ToolSelection {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface RenderedToolSelection {
  readonly tokens: readonly string[];
  readonly unmapped: readonly string[];
}

const validateNames = (h: HarnessDescriptor, names: readonly string[]): string[] => {
  for (const name of names) {
    if (name.trim() === "" || name.includes(",")) {
      throw new ArgvRefusalError({
        issue: "invalid-tool-grant",
        harness: h.name,
        supported: ["non-empty, comma-free tool names"],
        detail: `tools=${JSON.stringify(names)}`,
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
  }
  return [...names];
};

/** Curated-name mapping plus extensible pass-through; returns the effective
 * names and which of them the descriptor could not vouch for. */
const resolveNames = (
  h: HarnessDescriptor,
  names: readonly string[],
): { mapped: string[]; unmapped: string[] } => {
  const known = new Set(h.tools.builtins.map((t) => t.name));
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const name of names) {
    if (known.has(name)) mapped.push(name);
    else unmapped.push(name);
  }
  return { mapped, unmapped };
};

export const renderToolSelection = (
  h: HarnessDescriptor,
  selection: ToolSelection,
): RenderedToolSelection => {
  const hasInclude = selection.include !== undefined;
  const hasExclude = selection.exclude !== undefined;

  // D1: mutual exclusivity, structured refusal.
  if (hasInclude && hasExclude) {
    throw new ArgvRefusalError({
      issue: "mutually-exclusive-options",
      harness: h.name,
      option: "tools",
      supported: ["--tools (exact allowlist) or --exclude-tools (complement), never both"],
      detail: "mutual exclusion",
    });
  }
  if (!hasInclude && !hasExclude) return { tokens: [], unmapped: [] };

  if (h.tools.includeFlag === null || h.tools.excludeFlag === null) {
    const option = hasInclude ? "tools" : "excludeTools";
    const by = supportedBy(defaultDescriptors(), option);
    throw new ArgvRefusalError({
      issue: "unsupported-option",
      harness: h.name,
      option,
      supported: ["per-tool name lists"],
      supportedBy: by,
      hint:
        h.name === "codex"
          ? "nearest control on codex: category switches via config keys (features.shell_tool, web_search) or sandbox modes - see `hcn inspect codex`"
          : "nearest control on muse: category switches (--disable-write, --disable-shell, --disable-web-tools) gate tool execution per session",
    });
  }

  if (hasInclude) {
    const names = validateNames(h, selection.include!);
    if (names.length === 0) {
      // Empty include list = deny everything. On pi --tools "" has no
      // defined meaning, so refuse; on claude emit the deny complement
      // without an empty include token.
      if (h.tools.includeIsStrictAllowlist || h.tools.excludeFlag === null) {
        throw new ArgvRefusalError({
          issue: "invalid-tool-grant",
          harness: h.name,
          option: "tools",
          supported: ["non-empty tool list (empty include would deny everything)"],
          detail: "empty include list",
        });
      }
      const known = h.tools.builtins.map((t) => t.name);
      return { tokens: [h.tools.excludeFlag, known.join(",")], unmapped: [] };
    }
    const { mapped, unmapped } = resolveNames(h, names);
    if (!h.tools.includeIsStrictAllowlist) {
      if (mapped.length === 0 && unmapped.length > 0) {
        throw new ArgvRefusalError({
          issue: "unknown-tool-name",
          harness: h.name,
          option: "tools",
          supported: [`known tool names: ${h.tools.builtins.map((t) => t.name).join(", ")}`],
          detail: `unknown tool name(s) ${unmapped.join(", ")}`,
        });
      }
      // claude: exact allowlist must reshape the visible set via the deny
      // complement (probe 2b). The include flag also carries the granted
      // names (curated + pass-throughs) so they skip approval prompts;
      // unmapped names ride along - the deny complement is computed over
      // curated names only, so an extension tool in an include is granted,
      // never denied.
      const known = h.tools.builtins.map((t) => t.name);
      const excluded = known.filter((n) => !mapped.includes(n));
      const tokens: string[] = [h.tools.includeFlag!, [...mapped, ...unmapped].join(",")];
      tokens.push(h.tools.excludeFlag!, excluded.join(","));
      return { tokens, unmapped };
    }
    // pi: strict over built-ins, direct include; unmapped (extension/MCP)
    // names ride along in the same list - pi governs them too.
    return { tokens: [h.tools.includeFlag!, [...mapped, ...unmapped].join(",")], unmapped };
  }

  // exclude (D2): all descriptor-known names minus the excluded ones.
  const names = validateNames(h, selection.exclude!);
  const { mapped, unmapped: excludedUnmapped } = resolveNames(h, names);
  if (excludedUnmapped.length > 0) {
    // Excluding a name the descriptor does not know: permitted (it may be a
    // runtime-registered tool), rendered natively where the harness's deny
    // list can carry it; on claude only, since its include path consumes
    // unknown names without effect (silent-acceptance hazard).
    if (!h.tools.includeIsStrictAllowlist) {
      const tokens = [h.tools.excludeFlag!, [...mapped, ...excludedUnmapped].join(",")];
      return { tokens, unmapped: excludedUnmapped };
    }
    // pi: a D2 exclude renders as a computed include (its native exclude
    // subtracts from the default set, which cannot express "all minus X"
    // when off-by-default tools are involved). An unknown excluded name
    // cannot be complemented - refuse rather than silently grant it.
    throw new ArgvRefusalError({
      issue: "unknown-tool-name",
      harness: h.name,
      option: "excludeTools",
      supported: [`known tool names: ${h.tools.builtins.map((t) => t.name).join(", ")}`],
      detail: `cannot exclude unknown name(s) ${excludedUnmapped.join(", ")}: the complement cannot be computed`,
    });
  }
  const known = h.tools.builtins.filter((t) => !mapped.includes(t.name));
  const kept = known.map((t) => t.name);
  if (!h.tools.includeIsStrictAllowlist) {
    // claude: deny list IS the complement expression.
    return { tokens: [h.tools.excludeFlag!, mapped.join(",")], unmapped: [] };
  }
  // pi: computed include over every known name minus the excluded.
  return { tokens: [h.tools.includeFlag!, kept.join(",")], unmapped: [] };
};
