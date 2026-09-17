/**
 * Claude `result` is_error carries the harness's own failure text (probed
 * 2026-09-17: a scrubbed-env run ends `result` subtype success with
 * `is_error: true`, zero tokens, and the wall text in `result`). The
 * terminal error event must carry that text, not just the subtype, or the
 * classifier below degrades an auth wall to a work-verdict `task`
 * (non-retryable, do-not-route) instead of retryable `auth`.
 */
import { describe, expect, test } from "vitest";
import { failureFromTerminalError } from "../../src/execution/failure.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

describe("claude result is_error text", () => {
  test("the terminal error names the subtype and carries the result text", () => {
    const events = contentEventsOf("claude", {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in. Please run /login",
    });
    expect(events).toEqual([
      {
        kind: "error",
        message: "turn failed: success (Not logged in. Please run /login)",
        terminal: true,
      },
    ]);
  });

  test("a result without text keeps the bare subtype shape", () => {
    const events = contentEventsOf("claude", {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    });
    expect(events).toEqual([
      { kind: "error", message: "turn failed: error_max_turns", terminal: true },
    ]);
  });

  test("the carried text classifies an auth wall as auth, not task", () => {
    const [event] = contentEventsOf("claude", {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in. Please run /login",
    });
    if (event?.kind !== "error") throw new Error("expected a terminal error event");
    expect(failureFromTerminalError(claudeCode, event.message).class).toBe("auth");
  });
});
