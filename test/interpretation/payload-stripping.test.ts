/**
 * Issue #48 unit tests: payload-stripping dimensions. Per-harness render
 * (flag-value with companion exclusion on claude, plain flag on pi,
 * config-kv verbatim on codexCli, refusal + hint on muse), flag parsing,
 * config keys, opt-in-only (no profile entry), and the claude
 * setting-sources divergence line.
 */
import { describe, expect, test } from "vitest";
import { parseTurnOptions } from "../../src/cli/args.js";
import { parseUserConfig } from "../../src/cli/config.js";
import { buildLaunchArgv } from "../../src/interpretation/argv.js";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { DEFAULT_TURN_PROFILE } from "../../src/knowledge/profile.js";

const opts = (extra: Record<string, unknown>) =>
  ({ prompt: "task", __explicitPrompt: true, ...extra }) as never;

describe("systemPrompt render per harness", () => {
  test("claude: flag-value with the dynamic-section exclusion companion", () => {
    const argv = buildLaunchArgv(claudeCode, opts({ systemPrompt: "You are a haiku machine." }));
    const i = argv.indexOf("--system-prompt");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("You are a haiku machine.");
    // the exclusion rides BEFORE the value pair (probe-verified pairing)
    expect(argv.indexOf("--exclude-dynamic-system-prompt-sections")).toBe(i - 1);
  });

  test("pi: plain flag-value, no companion (pi injects no dynamic sections)", () => {
    const argv = buildLaunchArgv(piCli, opts({ systemPrompt: "PI-NAKED" }));
    const i = argv.indexOf("--system-prompt");
    expect(argv[i + 1]).toBe("PI-NAKED");
    expect(argv).not.toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("codex: config-kv verbatim (literal and path both ride unquoted)", () => {
    const literal = buildLaunchArgv(codexCli, opts({ systemPrompt: "You are a counter." }));
    expect(literal).toContain("-c");
    expect(literal[literal.indexOf("-c") + 1]).toBe("instructions=You are a counter.");
    const path = buildLaunchArgv(codexCli, opts({ systemPrompt: "/tmp/sys.txt" }));
    expect(path[path.indexOf("-c") + 1]).toBe("instructions=/tmp/sys.txt");
  });

  test("muse: refuses with the ratified structural hint", () => {
    expect(() => buildLaunchArgv(museCode, opts({ systemPrompt: "x" }))).toThrow(ArgvRefusalError);
    try {
      buildLaunchArgv(museCode, opts({ systemPrompt: "x" }));
      expect.unreachable();
    } catch (e) {
      const err = e as ArgvRefusalError;
      expect(err.hint).toMatch(
        /muse has no system-prompt surface; its built-in prompt always applies/,
      );
    }
  });

  test("appendSystemPrompt: claude/pi render; codex/muse refuse with hints", () => {
    for (const h of [claudeCode, piCli]) {
      const argv = buildLaunchArgv(h, opts({ appendSystemPrompt: "extra" }));
      const i = argv.indexOf("--append-system-prompt");
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe("extra");
    }
    for (const h of [codexCli, museCode]) {
      try {
        buildLaunchArgv(h, opts({ appendSystemPrompt: "extra" }));
        expect.unreachable();
      } catch (e) {
        expect((e as ArgvRefusalError).hint).toMatch(/append/);
      }
    }
  });

  test("empty prompt text refuses (non-empty contract)", () => {
    expect(() => buildLaunchArgv(claudeCode, opts({ systemPrompt: "  " }))).toThrow(/non-empty/);
  });
});

describe("flag and config surface", () => {
  test("--system-prompt / --append-system-prompt map onto the fields", () => {
    const o = parseTurnOptions({
      "system-prompt": "S",
      "append-system-prompt": "A",
    } as Record<string, unknown>);
    expect(o.systemPrompt).toBe("S");
    expect(o.appendSystemPrompt).toBe("A");
  });

  test("config keys parse (schema v1, both dimensions)", () => {
    expect(parseUserConfig('{"version":1,"systemPrompt":"S","appendSystemPrompt":"A"}')).toEqual({
      systemPrompt: "S",
      appendSystemPrompt: "A",
    });
  });

  test("opt-in-only ratified: neither dimension enters the profile", () => {
    expect("systemPrompt" in DEFAULT_TURN_PROFILE).toBe(false);
    expect("appendSystemPrompt" in DEFAULT_TURN_PROFILE).toBe(false);
  });
});
