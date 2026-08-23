/**
 * Skills allowlist rendering (issue #38):
 * - pi: -ns + one --skill per resolved path (exact set)
 * - claude: complement-off via skillOverrides settings JSON
 * - codex: complement-off via -c skills.config=[{path, enabled=false}]
 * - muse: refuse with the standard hint shape
 */
import { describe, expect, it } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import {
  claudeSkillOverridesArg,
  codexSkillConfigArg,
} from "../../src/interpretation/skills-selection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("pi rendering", () => {
  it("discovery off + one load flag per skill", () => {
    const argv = buildLaunchArgv(piCli, {
      prompt: "hi",
      skills: ["/root/a", "/root/b"],
    } as never);
    const i = argv.indexOf("-ns");
    expect(i).toBeGreaterThan(0);
    expect(argv.filter((a) => a === "--skill")).toEqual(["--skill", "--skill"]);
    expect(argv[argv.indexOf("--skill") + 1]).toBe("/root/a");
    const second = argv.indexOf("--skill", argv.indexOf("--skill") + 1);
    expect(argv[second + 1]).toBe("/root/b");
  });

  it("empty skills list emits nothing", () => {
    const argv = buildLaunchArgv(piCli, { prompt: "hi", skills: [] } as never);
    expect(argv).not.toContain("-ns");
    expect(argv).not.toContain("--skill");
  });
});

describe("claude rendering", () => {
  it("complement-off: every known name except the picks", () => {
    const tokens = claudeSkillOverridesArg(["hcn", "grill", "bro", "research"], ["/root/hcn"]);
    expect(tokens[0]).toBe("--settings");
    const parsed = JSON.parse(tokens[1] as string) as {
      skillOverrides: Record<string, string>;
    };
    expect(parsed.skillOverrides).toEqual({
      grill: "off",
      bro: "off",
      research: "off",
    });
    expect(parsed.skillOverrides.hcn).toBeUndefined();
  });

  it("all known picked: empty overrides object, still emitted", () => {
    const tokens = claudeSkillOverridesArg(["hcn"], ["/root/hcn"]);
    expect(JSON.parse(tokens[1] as string)).toEqual({ skillOverrides: {} });
  });
});

describe("codex rendering", () => {
  it("complement-off as one -c skills.config token pair", () => {
    const tokens = codexSkillConfigArg(["hcn", "grill", "bro", "research"], ["/tmp/skills/hcn"]);
    expect(tokens[0]).toBe("-c");
    expect(tokens[1]).toContain("skills.config=");
    // three entries for the three not-picked skills
    expect(tokens[1]).toContain('path="/tmp/skills/grill/SKILL.md"');
    expect(tokens[1]).toContain('path="/tmp/skills/bro/SKILL.md"');
    expect(tokens[1]).toContain('path="/tmp/skills/research/SKILL.md"');
    expect(tokens[1]).not.toContain('path="/tmp/skills/hcn/SKILL.md"');
    // each entry has enabled=false
    const matches = (tokens[1] as string).match(/enabled=false/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("emitted value is valid TOML-like array and quotes paths", () => {
    const tokens = codexSkillConfigArg(["a", "b"], ["/root/a"]);
    expect(tokens).toHaveLength(2);
    const value = tokens[1] as string;
    // must start with skills.config=[
    expect(value).toMatch(/^skills\.config=\[/);
    // paths are double-quoted
    expect(value).toContain('"/root/b/SKILL.md"');
  });

  it("picking every known skill emits nothing", () => {
    const tokens = codexSkillConfigArg(["hcn", "grill"], ["/tmp/skills/hcn", "/tmp/skills/grill"]);
    expect(tokens).toEqual([]);
  });

  it("descriptor no longer refuses (codex has skills surface)", () => {
    // codex renderSkillsSelection returns [] without throwing; tokens come from CLI layer
    const argv = buildLaunchArgv(codexCli, { prompt: "hi", skills: ["/root/a"] } as never);
    expect(argv).not.toContain("-c");
  });
});

describe("muse refusal", () => {
  it("refuses on the descriptor when skills is null", () => {
    try {
      buildLaunchArgv(museCode, { prompt: "hi", skills: ["/root/a"] } as never);
      expect.unreachable("muse should refuse");
    } catch (e) {
      const err = e as { issue: string; hint?: string };
      expect(err.issue).toBe("unsupported-option");
      expect(err.hint).toMatch(/no per-skill surface/);
    }
  });
});

describe("through the full builder", () => {
  it("pi argv carries the exact allowlist at the tail", () => {
    const argv = buildLaunchArgv(piCli, {
      prompt: "hi",
      skills: ["/root/only-this"],
    } as never);
    expect(argv[argv.length - 2]).toBe("--skill");
    expect(argv[argv.length - 1]).toBe("/root/only-this");
  });

  it("claude full argv (claude never throws; skills field is honored by the CLI layer)", () => {
    // claude renders via the CLI-layer complement; the descriptor-level
    // renderSkillsSelection returns [] and the tokens append in stream-turn.
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "hi",
      skills: ["/root/hcn"],
    } as never);
    expect(argv).not.toContain("--skill");
  });
});
