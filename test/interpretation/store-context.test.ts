import { describe, expect, test } from "vitest";
import { contextEventFrom } from "../../src/interpretation/context.js";
import { storePath } from "../../src/interpretation/store.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("storePath (claude)", () => {
  test("resolves the transcript tail path with the '/'-to-'-' project slug", () => {
    // Ground truth from the A-001 fixture's memory_paths:
    // /Users/kevin/.claude/projects/-Users-kevin-dev-lucid-v2-spikes/...
    expect(
      storePath(claudeCode, {
        home: "/Users/kevin",
        cwd: "/Users/kevin/dev/lucid-v2/spikes",
        sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
      }),
    ).toBe(
      "/Users/kevin/.claude/projects/-Users-kevin-dev-lucid-v2-spikes/eb04301d-8756-4a8b-ae3e-aac0e71f7265.jsonl",
    );
  });
});

describe("contextEventFrom (claude)", () => {
  test("maps the statusline context_window payload to a context HarnessEvent", () => {
    expect(contextEventFrom(claudeCode, { context_window: { used_percentage: 42.5 } })).toEqual({
      kind: "context",
      usedPct: 42.5,
    });
  });

  test("payloads without the hook's shape map to nothing", () => {
    expect(contextEventFrom(claudeCode, { type: "system", subtype: "init" })).toBeNull();
    expect(contextEventFrom(claudeCode, "not json shaped")).toBeNull();
  });
});

describe("storePath hardening", () => {
  test("a traversal-shaped session id never becomes a path segment", () => {
    expect(() =>
      storePath(claudeCode, { home: "/H", cwd: "/a/b", sessionId: "../../../etc/passwd" }),
    ).toThrow(/session id/i);
  });

  test("dots and trailing slashes in cwd slug correctly (real ~/.claude/projects shapes)", () => {
    expect(
      storePath(claudeCode, { home: "/H", cwd: "/Users/kevin/.cache/x/", sessionId: "id-1" }),
    ).toBe("/H/.claude/projects/-Users-kevin--cache-x/id-1.jsonl");
  });
});

describe("contextEventFrom sanitation", () => {
  test("non-finite gauges are rejected, out-of-range gauges are clamped", () => {
    expect(contextEventFrom(claudeCode, { context_window: { used_percentage: NaN } })).toBeNull();
    expect(
      contextEventFrom(claudeCode, { context_window: { used_percentage: Infinity } }),
    ).toBeNull();
    expect(contextEventFrom(claudeCode, { context_window: { used_percentage: 999 } })).toEqual({
      kind: "context",
      usedPct: 100,
    });
    expect(contextEventFrom(claudeCode, { context_window: { used_percentage: -5 } })).toEqual({
      kind: "context",
      usedPct: 0,
    });
  });
});
