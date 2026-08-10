import { describe, expect, test } from "vitest";
import { capabilitiesOf } from "../../src/interpretation/capabilities.js";
import {
  discoveryDisableFlagsOf,
  providerFlagOf,
  stdinPolicyOf,
  toolsFlagOf,
} from "../../src/interpretation/dimensions.js";
import { isInteractive } from "../../src/interpretation/presence.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("presence / isInteractive (claude)", () => {
  const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";

  test("a live interactive process resuming the id is presence", () => {
    const rows = [{ argv: "vim notes.md" }, { argv: `claude --resume ${sid}` }];
    expect(isInteractive(claudeCode, sid, rows)).toBe(true);
  });

  test("no matching process, or only headless -p processes, is not presence", () => {
    expect(isInteractive(claudeCode, sid, [{ argv: "claude" }])).toBe(false);
    expect(isInteractive(claudeCode, sid, [{ argv: `claude -p --resume ${sid}` }])).toBe(false);
  });
});

describe("flag dimensions (claude)", () => {
  test("stdin policy, provider, tools, discovery flags come from descriptor data", () => {
    expect(stdinPolicyOf(claudeCode)).toBe("inherit");
    expect(providerFlagOf(claudeCode)).toBeNull();
    expect(toolsFlagOf(claudeCode)).toBe("--allowedTools");
    expect(discoveryDisableFlagsOf(claudeCode)).toEqual(["--setting-sources", "project"]);
  });
});

describe("capabilitiesOf (claude)", () => {
  test("returns the full capability shape per (harness, model, mode)", () => {
    const caps = capabilitiesOf(claudeCode, "claude-opus-5", "headless-session");
    expect(caps).toEqual({
      vision: true,
      images: true,
      streaming: "token",
      session: true,
      source: "curated",
      confidence: "medium",
    });
  });

  test("interactive mode narrows streaming to message granularity", () => {
    expect(capabilitiesOf(claudeCode, "claude-opus-5", "interactive").streaming).toBe("message");
  });

  test("an unknown model degrades to unknown source, no streaming claim", () => {
    const caps = capabilitiesOf(claudeCode, "mystery-model", "headless-session");
    expect(caps.source).toBe("unknown");
    expect(caps.confidence).toBe("none");
    expect(caps.streaming).toBe("none");
    expect(caps.vision).toBe(false);
  });
});

describe("stdin close-required policy (pi-shaped descriptors)", () => {
  test("a descriptor declaring close-required reports it - backgrounded spawns must close stdin", () => {
    const piShaped = { ...claudeCode, stdin: "close-required" as const };
    expect(stdinPolicyOf(piShaped)).toBe("close-required");
  });
});
