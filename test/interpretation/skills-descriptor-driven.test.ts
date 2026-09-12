/**
 * RFC-02 change 2: skills rendering is descriptor-driven. The turn option
 * carries the caller's picks and the registry's known names; one
 * interpretation function renders all three supporting harnesses from
 * descriptor data, the refusal derives its support list, and the launch
 * builder's argv carries the tokens - no CLI copies, no hidden field.
 */
import { describe, expect, test } from "vitest";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { renderSkillsSelection } from "../../src/interpretation/skills-selection.js";
import { supportedBy } from "../../src/interpretation/support.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";
import { piCli } from "../../src/knowledge/pi.js";

const skills = { picks: ["/registry/hcn"], known: ["hcn", "other", "third"] };

describe("skills rendering is descriptor-driven", () => {
  test("pi: discovery off through the descriptor's facet render, then one load per pick", () => {
    expect(renderSkillsSelection(piCli, skills)).toEqual(["-ns", "--skill", "/registry/hcn"]);
  });

  test("claude: the complement off through skillOverrides settings", () => {
    expect(renderSkillsSelection(claudeCode, skills)).toEqual([
      "--settings",
      JSON.stringify({ skillOverrides: { other: "off", third: "off" } }),
    ]);
  });

  test("codex: the complement off through the skills.config array", () => {
    expect(renderSkillsSelection(codexCli, skills)).toEqual([
      "-c",
      'skills.config=[{path="/registry/other/SKILL.md", enabled=false}, {path="/registry/third/SKILL.md", enabled=false}]',
    ]);
  });

  test("muse refuses with a support list derived from the descriptors", () => {
    let caught: unknown;
    try {
      renderSkillsSelection(museCode, skills);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ issue: "unsupported-option", option: "skills" });
    expect((caught as { supportedBy: unknown }).supportedBy).toEqual(
      supportedBy(defaultDescriptors(), "skills"),
    );
  });

  test("the support query reads skills spellings from the descriptors", () => {
    expect(supportedBy(defaultDescriptors(), "skills")).toEqual([
      { harness: "claude", spelling: "skillOverrides" },
      { harness: "codex", spelling: "-c skills.config" },
      { harness: "pi", spelling: "--skill" },
    ]);
  });

  test("the launch builder's argv carries the tokens for every harness", () => {
    expect(buildLaunchArgv(claudeCode, { prompt: "hi", skills })).toContain("--settings");
    expect(buildLaunchArgv(codexCli, { prompt: "hi", skills }).join(" ")).toContain(
      "skills.config=",
    );
    expect(buildLaunchArgv(piCli, { prompt: "hi", skills })).toContain("--skill");
  });

  test("no picks renders nothing", () => {
    expect(renderSkillsSelection(claudeCode, { picks: [], known: ["hcn"] })).toEqual([]);
  });
});
