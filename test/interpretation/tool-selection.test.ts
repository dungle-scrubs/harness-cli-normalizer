/**
 * Tool-selection rendering with canonical vocabulary.
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
        renderToolSelection(h, { include: ["read"], exclude: ["shell"] });
        expect.unreachable(`${h.name} should have refused`);
      } catch (e) {
        expect((e as { issue: string }).issue).toBe("mutually-exclusive-options");
      }
    }
  });

  it("through the full builder too", () => {
    expect(() =>
      buildLaunchArgv(piCli, { prompt: "hi", tools: ["read"], excludeTools: ["shell"] }),
    ).toThrow(/exactly one/i);
  });
});

describe("D2: exclude is the complement over known names", () => {
  it("pi exclude shell -> include of the other six, gaining grep/glob/list", () => {
    const { tokens, passthrough } = renderToolSelection(piCli, { exclude: ["shell"] });
    expect(tokens).toEqual(["--tools", "read,edit,write,grep,find,ls"]);
    expect(passthrough).toEqual([]);
  });

  it("claude exclude emits the deny list directly", () => {
    const { tokens } = renderToolSelection(claudeCode, { exclude: ["shell"] });
    expect(tokens).toEqual(["--disallowedTools", "Bash"]);
  });

  it("unknown exclude on pi refuses", () => {
    expect(() => renderToolSelection(piCli, { exclude: ["no-such-tool"] })).toThrow(
      expect.objectContaining({ issue: "unknown-tool-name" }),
    );
  });

  it("unknown exclude on claude via native passthrough passes through", () => {
    const { tokens, passthrough } = renderToolSelection(claudeCode, {
      exclude: ["shell", "native:SomeExtTool"],
    });
    expect(tokens).toEqual(["--disallowedTools", "Bash,SomeExtTool"]);
    expect(passthrough).toEqual(["SomeExtTool"]);
  });
});

describe("include rendering per harness asymmetry", () => {
  it("claude include renders grant + deny-complement (probe 2b)", () => {
    const { tokens, passthrough } = renderToolSelection(claudeCode, {
      include: ["read", "shell"],
    });
    expect(tokens[0]).toBe("--allowedTools");
    expect(tokens[1]).toBe("Read,Bash");
    expect(tokens[2]).toBe("--disallowedTools");
    const denied = (tokens[3] ?? "").split(",");
    expect(denied).not.toContain("Read");
    expect(denied).not.toContain("Bash");
    expect(denied).toContain("Edit");
    expect(passthrough).toEqual([]);
  });

  it("pi include renders directly, strict over built-ins", () => {
    const { tokens } = renderToolSelection(piCli, { include: ["read", "shell"] });
    expect(tokens).toEqual(["--tools", "read,bash"]);
  });

  it("native passthrough include names ride along and are reported", () => {
    const { tokens, passthrough } = renderToolSelection(piCli, {
      include: ["read", "native:mcp__srv__x"],
    });
    expect(tokens).toEqual(["--tools", "read,mcp__srv__x"]);
    expect(passthrough).toEqual(["mcp__srv__x"]);
  });

  it("claude include with a native passthrough keeps it out of the deny complement", () => {
    const { tokens, passthrough } = renderToolSelection(claudeCode, {
      include: ["read", "native:ExtTool"],
    });
    expect(tokens[1]).toBe("Read,ExtTool");
    expect((tokens[3] ?? "").split(",")).not.toContain("ExtTool");
    expect(passthrough).toEqual(["ExtTool"]);
  });
});

describe("name validation", () => {
  it("empty entries and commas inside names refuse", () => {
    expect(() => renderToolSelection(piCli, { include: ["read", ""] })).toThrow(/tool/i);
    expect(() => renderToolSelection(piCli, { include: ["read,shell"] })).toThrow(/tool/i);
  });

  it("traversal-shaped names refuse", () => {
    expect(() => renderToolSelection(piCli, { include: ["../etc/passwd"] })).toThrow(/tool/i);
  });
});

describe("no-list harnesses refuse", () => {
  it("codex any include or exclude refuses unsupported-option", () => {
    expect(() => renderToolSelection(codexCli, { include: ["read"] })).toThrow(
      expect.objectContaining({ issue: "unsupported-option" }),
    );
    expect(() => renderToolSelection(codexCli, { exclude: ["read"] })).toThrow(
      expect.objectContaining({ issue: "unsupported-option" }),
    );
  });

  it("muse exclude inexpressible refuses, include inexpressible is no-op", () => {
    // include inexpressible on muse is accepted (no-op, renders disables)
    expect(() => renderToolSelection(museCode, { include: ["read"] })).not.toThrow();
    // exclude inexpressible on muse refuses
    expect(() => renderToolSelection(museCode, { exclude: ["read"] })).toThrow(
      expect.objectContaining({ issue: "unsupported-option" }),
    );
    expect(() => renderToolSelection(museCode, { exclude: ["list"] })).toThrow(
      expect.objectContaining({ issue: "unsupported-option" }),
    );
  });
});

describe("canonical vocabulary", () => {
  it("pi read,grep -> --tools read,grep", () => {
    const { tokens } = renderToolSelection(piCli, { include: ["read", "grep"] });
    expect(tokens).toEqual(["--tools", "read,grep"]);
  });

  it("claude read,grep -> Read,Grep plus deny complement", () => {
    const { tokens } = renderToolSelection(claudeCode, { include: ["read", "grep"] });
    expect(tokens[0]).toBe("--allowedTools");
    expect(tokens[1]).toBe("Read,Grep");
    expect(tokens[2]).toBe("--disallowedTools");
  });

  it("pi Read (native name) refuses unknown-tool-name listing canonical set", () => {
    try {
      renderToolSelection(piCli, { include: ["Read"] });
      expect.unreachable();
    } catch (e) {
      const err = e as { issue: string; supported: string[]; hint: string };
      expect(err.issue).toBe("unknown-tool-name");
      expect(err.supported.join(",")).toContain("read");
      expect(err.hint).toContain("native:");
    }
  });

  it("claude list -> refuses unsupported-option naming pi in supportedBy", () => {
    try {
      renderToolSelection(claudeCode, { include: ["list"] });
      expect.unreachable();
    } catch (e) {
      const err = e as { issue: string; supportedBy: { harness: string }[] };
      expect(err.issue).toBe("unsupported-option");
      expect(err.supportedBy.map((s) => s.harness)).toContain("pi");
    }
  });

  it("muse read,grep -> --disable-write --disable-shell --disable-web-tools", () => {
    const { tokens } = renderToolSelection(museCode, { include: ["read", "grep"] });
    expect(tokens).toContain("--disable-write");
    expect(tokens).toContain("--disable-shell");
    expect(tokens).toContain("--disable-web-tools");
    expect(tokens.length).toBe(3);
  });

  it("muse read,shell -> --disable-write --disable-web-tools", () => {
    const { tokens } = renderToolSelection(museCode, { include: ["read", "shell"] });
    expect(tokens).toContain("--disable-write");
    expect(tokens).toContain("--disable-web-tools");
    expect(tokens).not.toContain("--disable-shell");
  });

  it("muse exclude web-search -> --disable-web-tools", () => {
    const { tokens } = renderToolSelection(museCode, { exclude: ["web-search"] });
    expect(tokens).toEqual(["--disable-web-tools"]);
  });

  it("native:web_search on pi passes through and lands in passthrough", () => {
    const { tokens, passthrough } = renderToolSelection(piCli, { include: ["native:web_search"] });
    expect(tokens).toEqual(["--tools", "web_search"]);
    expect(passthrough).toEqual(["web_search"]);
  });

  it("mixed read,native:foo on pi -> --tools read,foo", () => {
    const { tokens, passthrough } = renderToolSelection(piCli, {
      include: ["read", "native:foo"],
    });
    expect(tokens).toEqual(["--tools", "read,foo"]);
    expect(passthrough).toEqual(["foo"]);
  });

  it("all-native on claude and pi via native: still considered passthrough", () => {
    const r1 = renderToolSelection(piCli, { include: ["native:foo", "native:bar"] });
    expect(r1.tokens).toEqual(["--tools", "foo,bar"]);
    expect(r1.passthrough).toEqual(["foo", "bar"]);
  });
});

describe("F-36: empty include list handling per harness", () => {
  it("empty include on claudeCode emits no empty token and contains deny complement", () => {
    const { tokens, passthrough } = renderToolSelection(claudeCode, { include: [] });
    expect(tokens).not.toContain("");
    expect(tokens.join(" ")).toContain("--disallowedTools");
    expect(tokens.join(",")).not.toContain('""');
    const expectedKnown = claudeCode.tools.builtins.map((t) => t.name).join(",");
    expect(tokens).toEqual(["--disallowedTools", expectedKnown]);
    expect(passthrough).toEqual([]);
  });

  it("empty include on piCli throws invalid-tool-grant", () => {
    expect(() => renderToolSelection(piCli, { include: [] })).toThrow(
      expect.objectContaining({ issue: "invalid-tool-grant" }),
    );
  });
});

describe("toolMap extensible vocabulary", () => {
  it("with toolMap web-search on pi renders web_search", () => {
    const { tokens } = renderToolSelection(piCli, {
      include: ["web-search"],
      toolMap: { "web-search": "web_search" },
    });
    expect(tokens).toEqual(["--tools", "web_search"]);
  });

  it("without toolMap web-search on pi refuses unsupported-option with hint naming toolMap.pi.web-search", () => {
    try {
      renderToolSelection(piCli, { include: ["web-search"] });
      expect.unreachable();
    } catch (e) {
      const err = e as { issue: string; hint: string };
      expect(err.issue).toBe("unsupported-option");
      expect(err.hint).toContain("toolMap.pi.web-search");
    }
  });

  it("native:web_search still passes through with provenance", () => {
    const { tokens, passthrough } = renderToolSelection(piCli, {
      include: ["native:web_search"],
    });
    expect(tokens).toEqual(["--tools", "web_search"]);
    expect(passthrough).toEqual(["web_search"]);
  });

  it("shadowing entry wins over descriptor", () => {
    const { tokens } = renderToolSelection(piCli, {
      include: ["read"],
      toolMap: { read: "my_read" },
    });
    expect(tokens).toEqual(["--tools", "my_read"]);
  });

  it("unknown everywhere still refuses unknown-tool-name", () => {
    expect(() => renderToolSelection(piCli, { include: ["does-not-exist"] })).toThrow(
      expect.objectContaining({ issue: "unknown-tool-name" }),
    );
  });
});
