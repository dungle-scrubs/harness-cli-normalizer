/**
 * Issue #41 question escalation - interpretation unit tests: preamble
 * composition per mode (incl. idempotence), block detection
 * (structured-first, malformed surfacing, last-block wins), and the
 * fixture evidence from the live probes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  composeEscalatedPrompt,
  detectQuestionBlock,
  ESCALATION_PREAMBLE,
  NO_ESCALATION_PREAMBLE,
  QUESTION_PREAMBLE_MARKER,
} from "../../src/interpretation/question.js";

describe("composeEscalatedPrompt", () => {
  test("ask mode prepends the protocol contract", () => {
    const composed = composeEscalatedPrompt("do the task", "ask");
    expect(composed.startsWith(QUESTION_PREAMBLE_MARKER)).toBe(true);
    expect(composed.endsWith("do the task")).toBe(true);
    expect(composed).toContain("hcn-question");
    expect(composed).toContain("recommended");
  });

  test("ask session mode uses session preamble", () => {
    const composed = composeEscalatedPrompt("do the task", "ask", "session");
    expect(composed.startsWith(QUESTION_PREAMBLE_MARKER)).toBe(true);
    expect(composed).toContain("persistent session");
    expect(composed).toContain("hcn-question");
  });

  test("assume mode prepends the state-the-assumption instruction", () => {
    const composed = composeEscalatedPrompt("do the task", "assume");
    expect(composed.startsWith(QUESTION_PREAMBLE_MARKER)).toBe(true);
    expect(composed).toContain("state the assumption");
    expect(composed).not.toContain("```hcn-question");
  });

  test("none mode injects nothing", () => {
    const composed = composeEscalatedPrompt("do the task", "none");
    expect(composed).toBe("do the task");
  });

  test("both preambles keep asking separate from permission", () => {
    // Design note ratified 2026-08-19: the true-mode preamble must never
    // conflate asking with permission - it says the protocol does not
    // change permissions; the false-mode preamble constrains questions,
    // not tools.
    expect(ESCALATION_PREAMBLE).toContain("never changes your permissions");
    expect(ESCALATION_PREAMBLE).toContain("asking is not how you obtain permission");
    expect(NO_ESCALATION_PREAMBLE).not.toMatch(/permission|allowed/i);
  });

  test("composition is idempotent", () => {
    const once = composeEscalatedPrompt("do the task", "ask");
    expect(composeEscalatedPrompt(once, "ask")).toBe(once);
    expect(composeEscalatedPrompt(once, "assume")).toBe(once);
    expect(composeEscalatedPrompt(once, "none")).toBe(once);
  });

  test("marker passthrough still short-circuits all three modes", () => {
    const marked = `${QUESTION_PREAMBLE_MARKER} already composed`;
    expect(composeEscalatedPrompt(marked, "ask")).toBe(marked);
    expect(composeEscalatedPrompt(marked, "assume")).toBe(marked);
    expect(composeEscalatedPrompt(marked, "none")).toBe(marked);
  });
});

describe("detectQuestionBlock", () => {
  const goodBlock = (extra = "") =>
    `prose before\n\n\`\`\`hcn-question\n{"question":"env?","options":["staging","production"],"recommended":"staging"}${extra}\n\`\`\`\n`;

  test("parses a well-formed block from prose", () => {
    expect(detectQuestionBlock(`Answer below.\n\n${goodBlock()}`)).toEqual({
      block: { question: "env?", options: ["staging", "production"], recommended: "staging" },
    });
  });

  test("block-only message parses (codex/muse probe shape)", () => {
    expect(
      detectQuestionBlock(
        '```hcn-question\n{"question":"q","options":["a","b"],"recommended":"a"}\n```\n',
      ),
    ).toEqual({ block: { question: "q", options: ["a", "b"], recommended: "a" } });
  });

  test("recommended is optional", () => {
    expect(detectQuestionBlock('```hcn-question\n{"question":"q","options":["a"]}\n```\n')).toEqual(
      { block: { question: "q", options: ["a"] } },
    );
  });

  test("no block is null", () => {
    expect(detectQuestionBlock("plain answer, no fence")).toBeNull();
    expect(detectQuestionBlock('```json\n{"question":"q"}\n```\n')).toBeNull();
  });

  test("tolerates indented fences and compact JSON (probe shapes)", () => {
    const text = `text\n  \`\`\`hcn-question\n  {"question":"which?","options":["x","y"],"recommended":"x"}\n  \`\`\`\n`;
    expect(detectQuestionBlock(text)).toEqual({
      block: { question: "which?", options: ["x", "y"], recommended: "x" },
    });
  });

  test("malformed JSON surfaces as a named malformation", () => {
    const d = detectQuestionBlock("```hcn-question\n{not json}\n```\n");
    expect(d !== null && "malformed" in d).toBe(true);
    if (d !== null && "malformed" in d) expect(d.malformed).toMatch(/not valid JSON/);
  });

  test("shape violations are named malformations", () => {
    const cases: Array<[string, RegExp]> = [
      ['{"options":["a"]}', /"question"/],
      ['{"question":"q"}', /"options"/],
      ['{"question":"q","options":[]}', /"options"/],
      ['{"question":"q","options":["a",""],"recommended":"a"}', /"options"/],
      ['{"question":"q","options":[1],"recommended":"a"}', /"options"/],
      ['{"question":"q","options":["a"],"recommended":7}', /"recommended"/],
      ['["not","object"]', /JSON object/],
    ];
    for (const [body, re] of cases) {
      const d = detectQuestionBlock(`\`\`\`hcn-question\n${body}\n\`\`\`\n`);
      expect(d !== null && "malformed" in d).toBe(true);
      if (d !== null && "malformed" in d) expect(d.malformed).toMatch(re);
    }
  });

  test("last block wins", () => {
    const text = [
      "```hcn-question",
      '{"question":"first","options":["a"]}',
      "```",
      "```hcn-question",
      '{"question":"second","options":["b"]}',
      "```",
    ].join("\n");
    expect(detectQuestionBlock(text)).toEqual({ block: { question: "second", options: ["b"] } });
  });

  test("a good block after a malformed one still parses", () => {
    const text = [
      "```hcn-question",
      "{broken",
      "```",
      "```hcn-question",
      '{"question":"q","options":["a"]}',
      "```",
    ].join("\n");
    expect(detectQuestionBlock(text)).toEqual({ block: { question: "q", options: ["a"] } });
  });

  test("unclosed opener at end of text is still examined", () => {
    const d = detectQuestionBlock('prose\n```hcn-question\n{"question":"q","options":["a"]}');
    expect(d).toEqual({ block: { question: "q", options: ["a"] } });
  });

  test("a bare unclosed opener with no body is null", () => {
    expect(detectQuestionBlock("prose\n```hcn-question")).toBeNull();
  });
});

describe("probe fixtures (grounding evidence)", () => {
  const dir = new URL("../fixtures/", import.meta.url).pathname;

  test("every ask fixture's final message carries a parseable block", () => {
    for (const harness of ["claude", "codex", "pi", "muse"]) {
      const raw = readFileSync(`${dir}phase7-questions/ask-${harness}.ndjson`, "utf8");
      const messages = raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { kind?: string; text?: string })
        .filter((e) => e.kind === "message");
      expect(messages.length, `${harness} has a final message`).toBeGreaterThan(0);
      const last = messages.at(-1)?.text ?? "";
      const detection = detectQuestionBlock(last);
      expect(detection !== null, `${harness} block detected`).toBe(true);
      if (detection !== null && "block" in detection) {
        expect(detection.block.question.length).toBeGreaterThan(0);
        expect(detection.block.options.length).toBeGreaterThanOrEqual(2);
        expect(detection.block.options).toContain(detection.block.recommended);
      } else {
        throw new Error(`${harness}: expected block, got ${JSON.stringify(detection)}`);
      }
    }
  });
});
