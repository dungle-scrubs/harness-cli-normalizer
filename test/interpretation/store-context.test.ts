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
