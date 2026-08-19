/**
 * Phase 1: descriptor tool data, asserted against the Phase 0 fixture
 * evidence (test/fixtures/phase0/*.md). These tests pin the curated facts
 * so descriptor edits that drift from verified evidence fail here first.
 */
import { describe, expect, it } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const ALL: readonly HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];

describe("tools field: shape invariants", () => {
  it("every descriptor carries the field", () => {
    for (const h of ALL) expect(h.tools).toBeDefined();
  });

  it("denySemantics no-lists implies no name-list flags and no disable flags", () => {
    for (const h of ALL) {
      if (h.tools.denySemantics === "no-lists") {
        expect(h.tools.includeFlag).toBeNull();
        expect(h.tools.excludeFlag).toBeNull();
        expect(h.tools.categories.every((c) => c.disableFlag === null)).toBe(true);
      }
    }
  });

  it("composable requires both flags", () => {
    for (const h of ALL) {
      if (h.tools.composable) {
        expect(h.tools.includeFlag).not.toBeNull();
        expect(h.tools.excludeFlag).not.toBeNull();
      }
    }
  });
});

describe("claude tool surface (claude-tool-interplay.md)", () => {
  it("has both list flags, patterns allowed, deny removes from set", () => {
    expect(claudeCode.tools.includeFlag).toBe("--allowedTools");
    expect(claudeCode.tools.excludeFlag).toBe("--disallowedTools");
    expect(claudeCode.tools.composable).toBe(true);
    expect(claudeCode.tools.denySemantics).toBe("remove-from-set");
  });

  it("include is a grant, not a visibility filter (probe 2b)", () => {
    expect(claudeCode.tools.includeIsStrictAllowlist).toBe(false);
  });

  it("core built-ins are curated and default-enabled", () => {
    for (const name of ["Bash", "Read", "Edit", "Write", "Grep", "Skill"]) {
      const entry = claudeCode.tools.builtins.find((t) => t.name === name);
      expect(entry, name).toBeDefined();
      expect(entry?.defaultEnabled).toBe(true);
    }
  });

  it("skills facet renders to the verified skills-off switch (probe 4)", () => {
    const discovery = claudeCode.turnOptions.discovery;
    expect(discovery).toBeDefined();
    expect(discovery?.kind).toBe("discovery");
    const facets = (discovery as { facets: Record<string, { polarity: string; render: unknown }> })
      .facets;
    expect(facets.skills).toMatchObject({
      polarity: "disables",
      render: { kind: "flag-list", flags: ["--disable-slash-commands"] },
    });
  });
});

describe("pi tool surface (pi-both-tool-flags.md)", () => {
  it("has both list flags, strict include, exclude subtracts from include", () => {
    expect(piCli.tools.includeFlag).toBe("--tools");
    expect(piCli.tools.excludeFlag).toBe("--exclude-tools");
    expect(piCli.tools.includeIsStrictAllowlist).toBe(true);
    expect(piCli.tools.composable).toBe(true);
    expect(piCli.tools.denySemantics).toBe("remove-from-set");
  });

  it("the seven documented built-ins with their default-enabled states", () => {
    const byName = new Map(piCli.tools.builtins.map((t) => [t.name, t.defaultEnabled]));
    expect([...byName.keys()].sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    expect(byName.get("grep")).toBe(false);
    expect(byName.get("find")).toBe(false);
    expect(byName.get("ls")).toBe(false);
    expect(byName.get("read")).toBe(true);
    expect(byName.get("bash")).toBe(true);
  });
});

describe("codex tool surface (codex-tool-surface.md)", () => {
  it("has no name lists; control is config booleans", () => {
    expect(codexCli.tools.includeFlag).toBeNull();
    expect(codexCli.tools.excludeFlag).toBeNull();
    expect(codexCli.tools.denySemantics).toBe("no-lists");
    expect(codexCli.tools.builtins).toEqual([]);
  });

  it("category config keys match the documented reference", () => {
    const keys = codexCli.tools.categories.map((c) => `${c.key}:${c.configKey}`).sort();
    expect(keys).toEqual([
      "exec:features.unified_exec",
      "shell:features.shell_tool",
      "view-image:tools.view_image",
      "web:web_search",
    ]);
  });
});

describe("muse tool surface (muse-category-flags.md)", () => {
  it("has no name lists; category disable flags exist for write/shell/web", () => {
    expect(museCode.tools.includeFlag).toBeNull();
    expect(museCode.tools.excludeFlag).toBeNull();
    expect(museCode.tools.denySemantics).toBe("policy-gate");
    const byKey = new Map(museCode.tools.categories.map((c) => [c.key, c.disableFlag]));
    expect(byKey.get("write")).toBe("--disable-write");
    expect(byKey.get("shell")).toBe("--disable-shell");
    expect(byKey.get("web")).toBe("--disable-web-tools");
  });
});
