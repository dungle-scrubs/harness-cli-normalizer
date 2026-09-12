/**
 * Hint curation (D8): every confirmed hint string is pinned here, so a
 * wording drift fails CI. The durable record is
 * test/fixtures/phase0/hints-confirmed.md (25 instances total: 3 shipped
 * in Phase 3 raise sites + 22 in the hints table), plus the issue #48
 * payload-stripping hints ratified 2026-08-20 (3 entries: muse systemPrompt,
 * muse appendSystemPrompt, codex appendSystemPrompt).
 */
import { describe, expect, it } from "vitest";
import { allHints, hintFor } from "../../src/interpretation/hints.js";

describe("hint table (confirmed instances)", () => {
  it("carries exactly 32 entries (24 confirmed + 3 issue #48 ratified + 4 tools + 1 memory ratified 2026-08-26)", () => {
    expect(allHints().length).toBe(32);
  });

  it("covers exactly the confirmed harness-dimension pairs", () => {
    const keys = allHints()
      .map((h) => `${h.harness}/${h.option}`)
      .sort();
    expect(keys).toEqual(
      [
        "claude/discovery.instructionFiles",
        "claude/discovery.tools",
        "claude/maxSteps",
        "claude/provider",
        "claude/sandbox",
        "claude/shell",
        "claude/write",
        "codex/discovery.extensions",
        "codex/discovery.instructionFiles",
        "codex/discovery.skills",
        "codex/discovery.tools",
        "codex/appendSystemPrompt",
        "codex/excludeTools",
        "codex/maxSteps",
        "codex/provider",
        "codex/shell",
        "codex/tools",
        "codex/write",
        "muse/discovery.instructionFiles",
        "muse/memory",
        "muse/discovery.skills",
        "muse/discovery.tools",
        "muse/appendSystemPrompt",
        "muse/excludeTools",
        "muse/provider",
        "muse/sandbox",
        "muse/systemPrompt",
        "muse/tools",
        "pi/maxSteps",
        "pi/sandbox",
        "pi/shell",
        "pi/write",
      ].sort(),
    );
  });

  it("spot-checks locked wording (drift fails)", () => {
    expect(hintFor("claude", "sandbox")).toContain("per-tool allowlist");
    expect(hintFor("claude", "shell")).toContain("Monitor can still run commands");
    expect(hintFor("pi", "sandbox")).toContain("minimal tool grant");
    expect(hintFor("muse", "sandbox")).toContain("--disable-sandbox exists to turn it OFF");
    expect(hintFor("codex", "write")).toContain("--sandbox read-only");
    expect(hintFor("codex", "discovery.extensions")).toContain("codex mcp remove");
    expect(hintFor("muse", "discovery.skills")).toContain("no unconditional skills-off switch");
    expect(hintFor("claude", "provider")).toContain("no separate provider selector");
    expect(hintFor("muse", "memory")).toContain("no CLI flag or config key");
  });

  it("every hint names a concrete control or bounds strategy (no dead ends)", () => {
    for (const h of allHints()) {
      // stay-on-harness: never suggests switching harnesses (the word
      // "switch" alone is allowed where it means a toggle, as in
      // "skills-off switch")
      expect(h.text).not.toMatch(/switch harness|route.*harness that supports/i);
      // actionable: mentions a flag, config key, or caller-side bound
      expect(h.text).toMatch(/--[a-z]|config|prompt|timeout|container|remove|directory/i);
    }
  });

  it("unknown pairs return undefined, never a wrong hint", () => {
    expect(hintFor("pi", "provider")).toBeUndefined(); // pi HAS provider
    expect(hintFor("codex", "sandbox")).toBeUndefined(); // codex HAS sandbox
    expect(hintFor("claude", "tools")).toBeUndefined(); // claude HAS tools
  });
});
