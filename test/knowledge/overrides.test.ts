import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { defaultDescriptors, parseOverrides } from "../../src/knowledge/overrides.js";

const PATH = "/Users/kevin/.config/harness-cli/overrides.json";

describe("code defaults (D-006)", () => {
  test("defaults load without any override file", () => {
    const all = defaultDescriptors();
    expect(all.claude).toBe(claudeCode);
  });
});

describe("override merge (D-006: override wins)", () => {
  test("an override file field replaces the code default for that harness", () => {
    const merged = parseOverrides(
      JSON.stringify({ claude: { vocabulary: { models: ["claude-opus-6"] } } }),
      PATH,
    );
    expect(merged.claude?.vocabulary.models).toEqual(["claude-opus-6"]);
    // Untouched sections keep their code defaults.
    expect(merged.claude?.vocabulary.efforts).toEqual(claudeCode.vocabulary.efforts);
    expect(merged.claude?.resume).toEqual(claudeCode.resume);
    // The code default object itself is never mutated.
    expect(claudeCode.vocabulary.models).toContain("claude-opus-5");
  });
});

describe("override refusals name the file and the offending harness", () => {
  test("malformed JSON throws with the file path in the message", () => {
    expect(() => parseOverrides("{not json", PATH)).toThrow(PATH);
  });

  test("an unknown harness names the file AND the harness", () => {
    const doc = JSON.stringify({ cursor: {} });
    expect(() => parseOverrides(doc, PATH)).toThrow(PATH);
    expect(() => parseOverrides(doc, PATH)).toThrow(/"cursor"/);
  });

  test("an unknown descriptor section is refused, not silently carried", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { turboMode: true } }), PATH)).toThrow(
      /"turboMode"/,
    );
  });

  test("regex-bearing sections cannot be overridden from JSON", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { limitMatchers: [] } }), PATH)).toThrow(
      /limitMatchers/,
    );
  });

  test("a non-object top level or harness value is refused with the path", () => {
    expect(() => parseOverrides(JSON.stringify([1, 2]), PATH)).toThrow(PATH);
    expect(() => parseOverrides(JSON.stringify({ claude: 7 }), PATH)).toThrow(/"claude"/);
  });
});
