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

describe("boundary-review regression pins", () => {
  test("prototype-chain keys never pass as known sections", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { toString: "pwned" } }), PATH)).toThrow(
      /toString/,
    );
    // Raw text: an object literal with __proto__ would set the literal's
    // prototype and stringify to {} - the attack only exists as raw JSON.
    expect(() => parseOverrides('{"claude":{"__proto__":{"evil":true}}}', PATH)).toThrow(
      /__proto__/,
    );
    expect(() =>
      parseOverrides('{"claude":{"vocabulary":{"aliases":{"__proto__":{"evil":true}}}}}', PATH),
    ).toThrow(/__proto__/);
  });

  test("wrong-typed values are refused with the path, never merged", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { stdin: 42 } }), PATH)).toThrow(PATH);
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { vocabulary: { models: "claude-opus-5" } } }), PATH),
    ).toThrow(/models/);
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { launch: { baseFlags: "-p" } } }), PATH),
    ).toThrow(/baseFlags/);
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { vocabulary: { turbo: 1 } } }), PATH),
    ).toThrow(/turbo/);
  });

  test("closed vocabularies are enforced - a typo'd literal refuses loudly", () => {
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { store: { cwdSlug: "Verbatim" } } }), PATH),
    ).toThrow(/dash-separators/);
    expect(() => parseOverrides(JSON.stringify({ claude: { stdin: "sometimes" } }), PATH)).toThrow(
      /inherit/,
    );
  });

  test("a partial depth-3 override keeps its sibling keys (recursive merge)", () => {
    const merged = parseOverrides(
      JSON.stringify({ claude: { capabilities: { streamingByMode: { interactive: "none" } } } }),
      PATH,
    );
    expect(merged.claude?.capabilities.streamingByMode).toEqual({
      "headless-turn": "token",
      "headless-session": "token",
      interactive: "none",
    });
  });

  test("a supported session input kind survives recursive override validation", () => {
    const merged = parseOverrides(
      JSON.stringify({ claude: { sessionMode: { input: { kind: "claude-sdk-user-message" } } } }),
      PATH,
    );

    expect(merged.claude?.sessionMode?.input).toEqual({ kind: "claude-sdk-user-message" });
  });

  test("an unsupported session input kind is refused as a closed vocabulary", () => {
    expect(() =>
      parseOverrides(
        JSON.stringify({ claude: { sessionMode: { input: { kind: "other-wire-shape" } } } }),
        PATH,
      ),
    ).toThrow(/claude-sdk-user-message/);
  });

  test("the registry key cannot be renamed from an override", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { name: "codex" } }), PATH)).toThrow(
      /name/,
    );
  });

  test("null sections have no shape to validate and refuse overrides", () => {
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { provider: { flag: "-x" } } }), PATH),
    ).toThrow(/null/);
  });

  test("regex refusal is value-derived: resume.style merges, resume.idShape refuses", () => {
    const merged = parseOverrides(
      JSON.stringify({ claude: { resume: { flag: "--continue" } } }),
      PATH,
    );
    expect(merged.claude?.resume.flag).toBe("--continue");
    expect(merged.claude?.resume.idShape).toBe(claudeCode.resume.idShape);
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { resume: { idShape: ".*" } } }), PATH),
    ).toThrow(/regular expression/);
  });

  test("a store template containing '..' is refused - it reaches the filesystem", () => {
    expect(() =>
      parseOverrides(
        JSON.stringify({ claude: { store: { template: "{home}/../../etc/{sessionId}" } } }),
        PATH,
      ),
    ).toThrow(/\.\./);
  });

  test("code defaults are frozen - an in-place edit throws instead of corrupting", () => {
    expect(() => {
      (claudeCode.vocabulary.models as string[]).push("evil");
    }).toThrow();
  });
});
