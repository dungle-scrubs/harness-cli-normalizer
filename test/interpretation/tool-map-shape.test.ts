/**
 * RFC-02 change 8: one toolMap shape past the merge step - the merged
 * map, tier included - carried on the turn options and read by the
 * helpers tool selection calls instead of inlining. The raw config shape
 * exists only on a config tier, before merging.
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { renderToolSelection } from "../../src/interpretation/tool-selection.js";
import * as vocabulary from "../../src/interpretation/tool-vocabulary.js";
import {
  canonicalTable,
  hasCounterpart,
  mergeToolMaps,
  nativeFor,
  type ToolMap,
} from "../../src/interpretation/tool-vocabulary.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

const merged: ToolMap = mergeToolMaps({
  user: { pi: { "web-search": "ws_user" } },
  project: { pi: { "web-search": "ws_project" }, muse: { "web-search": "web_search" } },
});

describe("one toolMap shape", () => {
  test("the merged map carries the native name and the tier that won", () => {
    expect(merged.pi?.["web-search"]).toEqual({ native: "ws_project", tier: "project-config" });
    expect(merged.muse?.["web-search"]).toEqual({ native: "web_search", tier: "project-config" });
  });

  test("the helpers read the merged shape, no sniffing", () => {
    const table = canonicalTable(defaultDescriptors());
    expect(hasCounterpart(table, "web-search", "pi", merged)).toBe(true);
    expect(nativeFor(table, "web-search", "pi", merged)).toBe("ws_project");
    expect(nativeFor(table, "read", "pi", merged)).toBe("read");
    expect(nativeFor(table, "web-search", "codex", merged)).toBeNull();
  });

  test("tool selection and the launch builder take the merged map", () => {
    const rendered = renderToolSelection(piCli, { include: ["web-search"], toolMap: merged });
    expect(rendered.tokens).toEqual(["--tools", "ws_project"]);
    const argv = buildLaunchArgv(piCli, {
      prompt: "hi",
      tools: ["read", "web-search"],
      toolMap: merged,
    });
    expect(argv).toContain("read,ws_project");
  });

  test("resolution hands the merged map on, never a second shape", () => {
    const r = resolveEffectiveOptions(
      piCli,
      { prompt: "hi" },
      { user: { toolMap: { pi: { "web-search": "ws_user" } } } },
    );
    expect(r.options.toolMap).toEqual({
      pi: { "web-search": { native: "ws_user", tier: "user-config" } },
    });
  });

  test("the compatibility alias is gone", () => {
    expect("canonicalToolTable" in vocabulary).toBe(false);
  });
});
