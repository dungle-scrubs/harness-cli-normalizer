import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import {
  defaultDescriptors,
  matcherOverridesOf,
  parseOverrides,
} from "../../src/knowledge/overrides.js";

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
    // grok stays unknown (blocked on ROADMAP.md); cursor joined the
    // registry in RFC-05 and no longer exercises this path.
    const doc = JSON.stringify({ grok: {} });
    expect(() => parseOverrides(doc, PATH)).toThrow(PATH);
    expect(() => parseOverrides(doc, PATH)).toThrow(/"grok"/);
  });

  test("an unknown descriptor section is refused, not silently carried", () => {
    expect(() => parseOverrides(JSON.stringify({ claude: { turboMode: true } }), PATH)).toThrow(
      /"turboMode"/,
    );
  });

  test("regex-bearing sections cannot be overridden from JSON", () => {
    // limitMatchers/authMatchers are now serializable objects and CAN be overridden
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { limitMatchers: [] } }), PATH),
    ).not.toThrow();
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { authMatchers: [] } }), PATH),
    ).not.toThrow();
    // but resume.idShape still carries a RegExp and must refuse
    expect(() =>
      parseOverrides(JSON.stringify({ claude: { resume: { idShape: ".*" } } }), PATH),
    ).toThrow(/idShape/);
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
    expect(() =>
      parseOverrides(
        JSON.stringify({ antigravity: { turnOptions: { effort: { argvPlacement: "later" } } } }),
        PATH,
      ),
    ).toThrow(/before-prompt/);
    expect(() =>
      parseOverrides(JSON.stringify({ antigravity: { resume: { onMissing: "guess" } } }), PATH),
    ).toThrow(/unknown/);
  });

  test("the cursor md5-hex slug survives override validation", () => {
    const merged = parseOverrides(
      JSON.stringify({ cursor: { store: { cwdSlug: "md5-hex" } } }),
      PATH,
    );
    expect(merged.cursor?.store.cwdSlug).toBe("md5-hex");
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
      parseOverrides(JSON.stringify({ codex: { sessionMode: { flags: ["-x"] } } }), PATH),
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

describe("trust matcher overrides (RFC-05 security claim)", () => {
  test("more than the per-kind bound of trust matchers refuses", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ pattern: `trust-${i}` }));
    expect(() => parseOverrides(JSON.stringify({ cursor: { trustMatchers: many } }), PATH)).toThrow(
      /more than 64/,
    );
  });

  test("a changed trust matcher list is counted for the spawn boundary event", () => {
    const merged = parseOverrides(
      JSON.stringify({ cursor: { trustMatchers: [{ pattern: "Trust Needed" }] } }),
      PATH,
    );
    const overridden = merged.cursor;
    const codeDefault = defaultDescriptors().cursor;
    if (overridden === undefined || codeDefault === undefined) {
      throw new Error("expected cursor defaults to exist");
    }
    expect(matcherOverridesOf.get(overridden)).toMatchObject({ trust: 1 });
    expect(matcherOverridesOf.get(codeDefault)).toBeUndefined();
  });
});
