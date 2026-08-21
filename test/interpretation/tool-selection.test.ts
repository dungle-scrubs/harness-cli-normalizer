/**
 * Tool-selection rendering, per D1-D3 and Phase 0 evidence:
 * - mutual exclusivity refuses (D1)
 * - exclude is the complement over all descriptor-known names, not the
 *   harness default (D2) - pi gains its off-by-default tools
 * - claude include renders grant + deny-complement (include is a permission
 *   grant, not a visibility filter); pi include renders directly (strict)
 * - unknown clean names pass through on include (D3 extensible rule) and
 *   are reported unmapped; unknown exclude on pi refuses (complement
 *   cannot be computed)
 */
import { describe, expect, it } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { renderToolSelection } from "../../src/interpretation/tool-selection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("D1: mutual exclusivity", () => {
  it("both flags in one call refuse with the structured issue", () => {
    for (const h of [claudeCode, piCli]) {
      try {
        renderToolSelection(h, { include: ["read"], exclude: ["bash"] });
        expect.unreachable(`${h.name} should have refused`);
      } catch (e) {
        expect((e as { issue: string }).issue).toBe("mutually-exclusive-options");
      }
    }
  });

  it("through the full builder too", () => {
    expect(() =>
      buildLaunchArgv(piCli, { prompt: "hi", tools: ["read"], excludeTools: ["bash"] }),
    ).toThrow(/exactly one/i);
  });
});

describe("D2: exclude is the complement over known names", () => {
  it("pi exclude bash -> include of the other six, gaining grep/find/ls", () => {
    const { tokens, unmapped } = renderToolSelection(piCli, { exclude: ["bash"] });
    expect(tokens).toEqual(["--tools", "read,edit,write,grep,find,ls"]);
    expect(unmapped).toEqual([]);
  });

  it("claude exclude emits the deny list directly", () => {
    const { tokens } = renderToolSelection(claudeCode, { exclude: ["Bash"] });
    expect(tokens).toEqual(["--disallowedTools", "Bash"]);
  });

  it("unknown exclude on pi refuses - the complement cannot be computed", () => {
    expect(() => renderToolSelection(piCli, { exclude: ["no-such-tool"] })).toThrow(
      /cannot compute a tool complement/i,
    );
  });

  it("unknown exclude on claude passes through natively", () => {
    const { tokens, unmapped } = renderToolSelection(claudeCode, {
      exclude: ["Bash", "SomeExtTool"],
    });
    expect(tokens).toEqual(["--disallowedTools", "Bash,SomeExtTool"]);
    expect(unmapped).toEqual(["SomeExtTool"]);
  });
});

describe("include rendering per harness asymmetry", () => {
  it("claude include renders grant + deny-complement (probe 2b)", () => {
    const { tokens, unmapped } = renderToolSelection(claudeCode, {
      include: ["Read", "Bash"],
    });
    expect(tokens[0]).toBe("--allowedTools");
    expect(tokens[1]).toBe("Read,Bash");
    expect(tokens[2]).toBe("--disallowedTools");
    const denied = (tokens[3] ?? "").split(",");
    expect(denied).not.toContain("Read");
    expect(denied).not.toContain("Bash");
    expect(denied).toContain("Edit");
    expect(unmapped).toEqual([]);
  });

  it("pi include renders directly, strict over built-ins", () => {
    const { tokens } = renderToolSelection(piCli, { include: ["read", "bash"] });
    expect(tokens).toEqual(["--tools", "read,bash"]);
  });

  it("unmapped include names ride along and are reported (D3)", () => {
    const { tokens, unmapped } = renderToolSelection(piCli, {
      include: ["read", "mcp__srv__x"],
    });
    expect(tokens).toEqual(["--tools", "read,mcp__srv__x"]);
    expect(unmapped).toEqual(["mcp__srv__x"]);
  });

  it("claude include with an unmapped name keeps it out of the deny complement", () => {
    const { tokens, unmapped } = renderToolSelection(claudeCode, {
      include: ["Read", "ExtTool"],
    });
    // grant carries both; the deny complement is over known names only,
    // so ExtTool is neither denied nor curated - reported unmapped.
    expect(tokens[1]).toBe("Read,ExtTool");
    expect((tokens[3] ?? "").split(",")).not.toContain("ExtTool");
    expect(unmapped).toEqual(["ExtTool"]);
  });
});

describe("name validation", () => {
  it("empty entries and commas inside names refuse", () => {
    expect(() => renderToolSelection(piCli, { include: ["read", ""] })).toThrow(/tool/i);
    expect(() => renderToolSelection(piCli, { include: ["read,bash"] })).toThrow(/tool/i);
  });

  it("traversal-shaped names refuse", () => {
    expect(() => renderToolSelection(piCli, { include: ["../etc/passwd"] })).toThrow(/tool/i);
  });
});

describe("no-list harnesses refuse", () => {
  it("codex and muse refuse include and exclude with unsupported-option", () => {
    for (const h of [codexCli, museCode]) {
      for (const sel of [{ include: ["x"] }, { exclude: ["x"] }] as const) {
        try {
          renderToolSelection(h, sel);
          expect.unreachable(`${h.name} should have refused`);
        } catch (e) {
          expect((e as { issue: string }).issue).toBe("unsupported-option");
        }
      }
    }
  });
});

describe("F-11: claude tool names silently unmapped", () => {
  it("all-unmapped include on claude refuses with unknown-tool-name", () => {
    expect(() =>
      renderToolSelection(claudeCode, { include: ["read", "grep", "find", "ls"] }),
    ).toThrow(expect.objectContaining({ issue: "unknown-tool-name" }));
    try {
      renderToolSelection(claudeCode, { include: ["read", "grep", "find", "ls"] });
      expect.unreachable("should have refused");
    } catch (e) {
      const err = e as { supported: string[] };
      expect(err.supported.join(" ")).toContain("Bash");
    }
  });

  it("partially mapped include on claude keeps grant and reports unmapped", () => {
    const { tokens, unmapped } = renderToolSelection(claudeCode, {
      include: ["Read", "grep", "find", "ls"],
    });
    expect(tokens[0]).toBe("--allowedTools");
    expect(tokens[1]).toBe("Read,grep,find,ls");
    expect(unmapped).toEqual(["grep", "find", "ls"]);
  });
});

describe("F-36: empty include list handling per harness", () => {
  it("empty include on claudeCode emits no empty token and contains deny complement", () => {
    const { tokens, unmapped } = renderToolSelection(claudeCode, { include: [] });
    expect(tokens).not.toContain("");
    expect(tokens.join(" ")).toContain("--disallowedTools");
    expect(tokens.join(",")).not.toContain('""');
    // should be deny complement over all known names
    const expectedKnown = claudeCode.tools.builtins.map((t) => t.name).join(",");
    expect(tokens).toEqual(["--disallowedTools", expectedKnown]);
    expect(unmapped).toEqual([]);
  });

  it("empty include on piCli throws invalid-tool-grant", () => {
    expect(() => renderToolSelection(piCli, { include: [] })).toThrow(
      expect.objectContaining({ issue: "invalid-tool-grant" }),
    );
    try {
      renderToolSelection(piCli, { include: [] });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { issue: string }).issue).toBe("invalid-tool-grant");
    }
  });
});
