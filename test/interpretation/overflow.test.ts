import { describe, expect, test } from "vitest";
import { overflowIsEcho } from "../../src/interpretation/overflow.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";

/**
 * The echo rule: a discarded line whose head starts with a record that
 * only repeats what hcn already read (pi's `turn_end` and `agent_end`)
 * lost nothing. The rule is conservative on purpose - a head that does
 * not start with the echo record is not an echo, and the line is judged
 * on its own.
 */
describe("overflowIsEcho", () => {
  test("a pi turn_end or agent_end head is an echo", () => {
    expect(overflowIsEcho(piCli, '{"type":"turn_end","message":')).toBe(true);
    expect(overflowIsEcho(piCli, '{"type":"agent_end","messages":')).toBe(true);
  });

  test("a record hcn reads is not an echo", () => {
    expect(overflowIsEcho(piCli, '{"type":"message_end","message":')).toBe(false);
    expect(overflowIsEcho(piCli, '{"type":"message_update","assistantMessageEvent":')).toBe(false);
  });

  test("the type field must be the first key", () => {
    expect(overflowIsEcho(piCli, '{"message":{},"type":"agent_end"')).toBe(false);
    // A head cut before the value ends is not an echo.
    expect(overflowIsEcho(piCli, '{"type":"agent_en')).toBe(false);
  });

  test("JSON whitespace around the key and the colon is allowed", () => {
    expect(overflowIsEcho(piCli, '  {  "type" : "agent_end" , "messages"')).toBe(true);
    expect(overflowIsEcho(piCli, '{"type"\t:\n"turn_end"')).toBe(true);
  });

  test("a harness with no echo records never has one", () => {
    expect(overflowIsEcho(claudeCode, '{"type":"turn_end","message":')).toBe(false);
    expect(overflowIsEcho(claudeCode, '{"subtype":"success"}')).toBe(false);
  });

  test("a head that is not an object, or is cut short, is not an echo", () => {
    expect(overflowIsEcho(piCli, "not json at all")).toBe(false);
    expect(overflowIsEcho(piCli, '{"type":"agent_')).toBe(false);
    expect(overflowIsEcho(piCli, "")).toBe(false);
  });
});
