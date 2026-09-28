/**
 * Skills allowlist rendering (issue #38), descriptor-driven (RFC-02
 * change 2):
 * - pi: the discovery.skills facet off + one --skill per resolved path
 * - claude: complement-off via skillOverrides settings JSON
 * - codex: complement-off via -c skills.config=[{path, enabled=false}]
 * - muse: refuse with the standard hint shape
 */
import { describe, expect, it } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { renderSkillsSelection } from "../../src/interpretation/skills-selection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

describe("pi rendering", () => {
  it("discovery off + one load flag per skill", () => {
    const argv = buildLaunchArgv(piCli, {
      prompt: "hi",
      skills: { picks: ["/root/a", "/root/b"], known: ["a", "b", "c"] },
    });
    const i = argv.indexOf("-ns");
    expect(i).toBeGreaterThan(0);
    expect(argv.filter((a) => a === "--skill")).toEqual(["--skill", "--skill"]);
    expect(argv[argv.indexOf("--skill") + 1]).toBe("/root/a");
    const second = argv.indexOf("--skill", argv.indexOf("--skill") + 1);
    expect(argv[second + 1]).toBe("/root/b");
  });

  it("no picks emits nothing", () => {
    const argv = buildLaunchArgv(piCli, { prompt: "hi", skills: { picks: [], known: ["a"] } });
    expect(argv).not.toContain("-ns");
    expect(argv).not.toContain("--skill");
  });
});

describe("claude rendering", () => {
  it("complement-off: every known name except the picks", () => {
    const tokens = renderSkillsSelection(claudeCode, {
      picks: ["/root/hcn"],
      known: ["hcn", "grill", "bro", "research"],
    });
    expect(tokens[0]).toBe("--settings");
    const parsed = JSON.parse(tokens[1] as string) as {
      skillOverrides: Record<string, string>;
    };
    expect(parsed.skillOverrides).toEqual({ grill: "off", bro: "off", research: "off" });
    expect(parsed.skillOverrides.hcn).toBeUndefined();
  });

  it("all known picked: empty overrides object, still emitted", () => {
    const tokens = renderSkillsSelection(claudeCode, { picks: ["/root/hcn"], known: ["hcn"] });
    expect(JSON.parse(tokens[1] as string)).toEqual({ skillOverrides: {} });
  });
});

describe("codex rendering", () => {
  it("complement-off plus picks restated on, both selectors per skill", () => {
    const tokens = renderSkillsSelection(codexCli, {
      picks: ["/tmp/skills/hcn"],
      known: ["hcn", "grill", "bro", "research"],
    });
    expect(tokens[0]).toBe("-c");
    const value = tokens[1] as string;
    expect(value).toContain("skills.config=");
    // the pick: both selectors, enabled=true
    expect(value).toContain('{path="/tmp/skills/hcn/SKILL.md", enabled=true}');
    expect(value).toContain('{name="hcn", enabled=true}');
    // the complement: both selectors, enabled=false
    for (const name of ["grill", "bro", "research"]) {
      expect(value).toContain(`{path="/tmp/skills/${name}/SKILL.md", enabled=false}`);
      expect(value).toContain(`{name="${name}", enabled=false}`);
    }
    expect(value).not.toContain('"hcn\\/SKILL.md"');
    expect((value.match(/enabled=true/g) ?? []).length).toBe(2);
    expect((value.match(/enabled=false/g) ?? []).length).toBe(6);
  });

  it("a non-empty selection never renders zero enabled entries (#209)", () => {
    for (const known of [["hcn", "grill"], ["grill"], []]) {
      const tokens = renderSkillsSelection(codexCli, {
        picks: ["/tmp/skills/hcn"],
        known,
      });
      expect(tokens[1] as string).toContain("enabled=true");
    }
  });

  it("all known picked: only enabled entries", () => {
    const tokens = renderSkillsSelection(codexCli, { picks: ["/root/a"], known: ["a"] });
    const value = tokens[1] as string;
    expect(value).toContain("enabled=true");
    expect(value).not.toContain("enabled=false");
  });

  it("emitted value is a TOML-like array with quoted paths", () => {
    const tokens = renderSkillsSelection(codexCli, { picks: ["/root/a"], known: ["a", "b"] });
    expect(tokens).toHaveLength(2);
    const value = tokens[1] as string;
    expect(value).toMatch(/^skills\.config=\[/);
    expect(value).toContain('"/root/b/SKILL.md"');
  });

  it("picking every known skill emits only the enabled picks, no disables", () => {
    const tokens = renderSkillsSelection(codexCli, {
      picks: ["/tmp/skills/hcn", "/tmp/skills/grill"],
      known: ["hcn", "grill"],
    });
    const value = tokens[1] as string;
    expect((value.match(/enabled=true/g) ?? []).length).toBe(4);
    expect(value).not.toContain("enabled=false");
  });

  it("the builder's argv carries the config pair", () => {
    const argv = buildLaunchArgv(codexCli, {
      prompt: "hi",
      skills: { picks: ["/root/a"], known: ["a", "b"] },
    });
    expect(argv).toContain("-c");
    expect(argv.some((t) => t.startsWith("skills.config="))).toBe(true);
  });
});

describe("muse refusal", () => {
  it("refuses on the descriptor when skills is null", () => {
    try {
      buildLaunchArgv(museCode, { prompt: "hi", skills: { picks: ["/root/a"], known: ["a"] } });
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
      skills: { picks: ["/root/only-this"], known: ["only-this"] },
    });
    expect(argv[argv.length - 2]).toBe("--skill");
    expect(argv[argv.length - 1]).toBe("/root/only-this");
  });

  it("claude argv carries the settings pair, never pi's load flag", () => {
    const argv = buildLaunchArgv(claudeCode, {
      prompt: "hi",
      skills: { picks: ["/root/hcn"], known: ["hcn", "other"] },
    });
    expect(argv).not.toContain("--skill");
    expect(argv).toContain("--settings");
  });
});

describe("popeye refusal", () => {
  it("names the plugin-name spelling on the descriptor when skills is null", async () => {
    const { popeyeCli } = await import("../../src/knowledge/popeye.js");
    try {
      buildLaunchArgv(popeyeCli, { prompt: "hi", skills: { picks: ["/root/a"], known: ["a"] } });
      expect.unreachable("popeye should refuse");
    } catch (e) {
      const err = e as { issue: string; hint?: string };
      expect(err.issue).toBe("unsupported-option");
      expect(err.hint).toMatch(/plugin names/);
    }
  });
});
