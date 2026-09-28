import { describe, expect, test } from "vitest";
import {
  ArgvRefusalError,
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
} from "../../src/interpretation/argv.js";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import { renderTurnOptions } from "../../src/interpretation/turn-options.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

/**
 * Map #288: named-agent selection. The caller picks among agents the
 * harness defines natively; hcn renders the native `--agent <name>` on
 * claude and antigravity and refuses everywhere else. Names pass through -
 * an unknown name is the harness's own native error, because no harness
 * exposes a stable machine roster to validate against (probed 2026-09-27,
 * captures under .scratch/wayfinder-agent-flag/).
 */

const NATIVE: readonly HarnessDescriptor[] = [claudeCode, antigravityCli, popeyeCli, piCli];
// pi's agent spec is extension-registered (map #300): the pure render
// tests below treat it like any spec - the CLI's pre-spawn gate owns the
// machine check (test/cli/extension-gate.test.ts).
const REFUSING: readonly HarnessDescriptor[] = [codexCli, museCode, cursorCli];
const SESSION_ID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

describe("named-agent render (claude, antigravity)", () => {
  test("launch renders the native --agent flag with the caller's name", () => {
    for (const h of NATIVE) {
      const argv = buildLaunchArgv(h, { prompt: "Reply OK", agent: "scout-agent" });
      expect(argv[argv.indexOf("--agent") + 1]).toBe("scout-agent");
    }
  });

  test("resume inherits the launch render (probed: claude --resume and agy --conversation compose)", () => {
    for (const h of NATIVE) {
      const { tokens } = renderTurnOptions(h, { prompt: "hi", agent: "scout-agent" }, "resume");
      expect(tokens).toEqual(["--agent", "scout-agent"]);
    }
    const resumed = buildResumeArgv(claudeCode, {
      prompt: "continue",
      sessionId: SESSION_ID,
      agent: "dev-agent",
    });
    expect(resumed[resumed.indexOf("--agent") + 1]).toBe("dev-agent");
  });

  test("session spawn renders the flag the launch path renders", () => {
    for (const h of NATIVE) {
      const argv = buildSessionArgv(h, { sessionId: SESSION_ID, agent: "scout-agent" });
      expect(argv[argv.indexOf("--agent") + 1]).toBe("scout-agent");
    }
  });

  test("a name failing the selector rule refuses as an invalid value", () => {
    try {
      buildLaunchArgv(claudeCode, { prompt: "hi", agent: "has space" });
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ArgvRefusalError);
      expect((e as ArgvRefusalError).issue).toBe("invalid-option-value");
    }
  });
});

describe("named-agent refusal (no spec)", () => {
  test("every harness without a spec refuses before spawn, naming the supporters", () => {
    for (const h of REFUSING) {
      try {
        buildLaunchArgv(h, { prompt: "hi", agent: "scout-agent" });
        throw new Error(`${h.name} did not refuse`);
      } catch (e) {
        expect(e).toBeInstanceOf(ArgvRefusalError);
        const err = e as ArgvRefusalError;
        expect(err.harness).toBe(h.name);
        expect(err.issue).toBe("unsupported-option");
        expect(err.supportedBy).toEqual([
          { harness: "claude", spelling: "--agent" },
          { harness: "pi", spelling: "--agent" },
          { harness: "antigravity", spelling: "--agent" },
          { harness: "popeye", spelling: "--agent" },
        ]);
      }
    }
  });
});

describe("namedAgents capability fact", () => {
  test("true exactly on the harnesses with an agent spec, on every model outcome", () => {
    for (const h of [...NATIVE, ...REFUSING]) {
      const expected =
        h.name === "claude" || h.name === "antigravity" || h.name === "popeye" || h.name === "pi";
      expect(capabilitiesOf(h, "", "headless-turn").namedAgents).toBe(expected);
    }
    // An uncurated model degrades the model-scoped claims but not this one:
    // the spec table is a harness fact (same rule as compactionReporting).
    expect(capabilitiesOf(claudeCode, "no-such-model", "headless-turn").namedAgents).toBe(true);
    expect(capabilitiesOf(codexCli, "no-such-model", "headless-turn").namedAgents).toBe(false);
    expect(capabilitiesOf(popeyeCli, "no-such-model", "headless-turn").namedAgents).toBe(true);
  });

  test("inspect prints the fact for planning, both surfaces", async () => {
    const capture = async (argv: readonly string[]): Promise<string> => {
      const originalStdout = process.stdout.write.bind(process.stdout);
      let out = "";
      (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk) => {
        out += String(chunk);
        return true;
      };
      const { dispatch } = await import("../../src/cli/index.js");
      try {
        await dispatch([...argv]);
      } finally {
        process.stdout.write = originalStdout as typeof process.stdout.write;
      }
      return out;
    };
    // Default descriptor block.
    const claude = JSON.parse(await capture(["inspect", "claude"]));
    expect(claude.namedAgents).toBe(true);
    expect(claude.extensionOptions).toBeNull();
    const codex = JSON.parse(await capture(["inspect", "codex"]));
    expect(codex.namedAgents).toBe(false);
    expect(codex.extensionOptions).toBeNull();
    // Map #300: pi's agent is extension-registered - the static block
    // declares it; per-machine truth is --runtime.
    const pi = JSON.parse(await capture(["inspect", "pi"]));
    expect(pi.extensionOptions).toEqual({
      agent: {
        providedBy: "subagent extension",
        probe: "pi --help contains --agent <value>",
      },
    });
    // Capabilities surface.
    const caps = JSON.parse(await capture(["inspect", "antigravity", "--capabilities"]));
    expect(caps.namedAgents).toBe(true);
    const codexCaps = JSON.parse(await capture(["inspect", "muse", "--capabilities"]));
    expect(codexCaps.namedAgents).toBe(false);
  });
});
