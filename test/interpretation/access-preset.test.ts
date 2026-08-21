import { describe, expect, it } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { resolveEffectiveOptions } from "../../src/interpretation/resolve-options.js";
import { renderTurnOptions } from "../../src/interpretation/turn-options.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("--access preset", () => {
  it("pi read -> --tools read,grep,find,ls", () => {
    const argv = buildLaunchArgv(piCli, { prompt: "hi", access: "read" });
    expect(argv.join(" ")).toContain("--tools");
    const idx = argv.indexOf("--tools");
    const val = argv[idx + 1] ?? "";
    expect(val.split(",").sort()).toEqual(["find", "grep", "ls", "read"].sort());
  });
  it("claude read -> Read,Grep,Glob,WebFetch,WebSearch plus deny complement", () => {
    const argv = buildLaunchArgv(claudeCode, { prompt: "hi", access: "read" });
    expect(argv.join(" ")).toContain("--allowedTools");
    const idx = argv.indexOf("--allowedTools");
    expect(argv[idx + 1]).toContain("Read");
    expect(argv[idx + 1]).toContain("Grep");
    expect(argv.join(" ")).toContain("--disallowedTools");
  });
  it("codex read -> --sandbox read-only exactly once even with profile sandbox", () => {
    const argv = buildLaunchArgv(codexCli, { prompt: "hi", access: "read" });
    const count = argv.filter((a) => a === "--sandbox").length;
    expect(count).toBe(1);
    expect(argv).toContain("read-only");
  });
  it("codex write -> --sandbox workspace-write once", () => {
    const argv = buildLaunchArgv(codexCli, { prompt: "hi", access: "write" });
    const count = argv.filter((a) => a === "--sandbox").length;
    expect(count).toBe(1);
    expect(argv).toContain("workspace-write");
  });
  it("muse read -> --disable-write --disable-shell", () => {
    const argv = buildLaunchArgv(museCode, { prompt: "hi", access: "read" });
    expect(argv).toContain("--disable-write");
    expect(argv).toContain("--disable-shell");
  });
  it("write on claude/pi/muse -> nothing", () => {
    expect(buildLaunchArgv(claudeCode, { prompt: "hi", access: "write" }).join(" ")).not.toContain(
      "--allowedTools",
    );
    expect(buildLaunchArgv(piCli, { prompt: "hi", access: "write" }).join(" ")).not.toContain(
      "--tools",
    );
    expect(buildLaunchArgv(museCode, { prompt: "hi", access: "write" }).join(" ")).not.toContain(
      "--disable",
    );
  });
  it("--access read --tools read -> mutually-exclusive", () => {
    expect(() =>
      resolveEffectiveOptions(
        piCli,
        { prompt: "hi", access: "read", tools: ["read"] } as never,
        {},
      ),
    ).toThrow(ArgvRefusalError);
  });
  it("codex --access read with explicit --sandbox workspace-write -> refuses", () => {
    expect(() =>
      resolveEffectiveOptions(
        codexCli,
        { prompt: "hi", access: "read", sandbox: "workspace-write" } as never,
        {},
      ),
    ).toThrow(ArgvRefusalError);
  });
  it("--access nope -> invalid-option-value on every harness", () => {
    for (const h of [claudeCode, codexCli, piCli, museCode]) {
      expect(() =>
        renderTurnOptions(h as never, { prompt: "hi", access: "nope" as never }, "launch"),
      ).toThrow(ArgvRefusalError);
    }
  });
  it("pi access read with no --tools resolves and profile tools skipped with provenance", () => {
    const r = resolveEffectiveOptions(piCli, { prompt: "hi", access: "read" } as never, {});
    expect(r.options.access).toBe("read");
    expect(r.provenance.some((p) => p.key === "tools" && String(p.value).includes("access"))).toBe(
      true,
    );
  });
  it("--access read --no-tools on pi -> -nt, no --tools", () => {
    const argv = buildLaunchArgv(piCli, {
      prompt: "hi",
      access: "read",
      discovery: { tools: false },
    } as never);
    expect(argv).toContain("-nt");
    expect(argv.join(" ")).not.toContain("--tools");
  });
});
