import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";

/**
 * Gate 2->3 guard: every dimension of the PLAN.md 3.1 table has an owner on
 * the descriptor. A new descriptor cannot ship with a dimension silently
 * missing - the type demands them, and this test names the mapping.
 */
describe("descriptor dimension coverage (PLAN.md 3.1)", () => {
  test("all 16 table dimensions have a concrete owner on the claude descriptor", () => {
    const d = claudeCode;
    const owners: Record<string, unknown> = {
      sessionId: d.identity.authority,
      resume: d.resume,
      resumeLast: d.resumeLast, // null is a valid owner: claude has no --last
      provider: d.provider,
      effort: d.vocabulary.efforts,
      model: d.vocabulary.models,
      autonomy: d.autonomy,
      tools: d.launch.toolsFlag,
      output: d.output,
      sessionMode: d.sessionMode,
      storePath: d.store,
      presence: d.presence,
      parseResume: d.resume.flag, // parseResumeCommand consumes this
      argvOrder: d.launch.promptStyle,
      limitMatchers: d.limitMatchers,
      stdin: d.stdin,
      contextHook: d.contextHook,
      capabilities: d.capabilities,
      discoveryFlags: d.discoveryDisableFlags,
    };
    for (const [dimension, owner] of Object.entries(owners)) {
      expect(owner, `dimension ${dimension} has no owner`).not.toBeUndefined();
    }
  });
});
