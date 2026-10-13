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

  test("a leading harness slash command stays first; ask mode inserts the preamble between the command and the rest", () => {
    const composed = composeEscalatedPrompt("/skill:dev-mode do x", "ask");
    const expected = `/skill:dev-mode ${ESCALATION_PREAMBLE}\n\ndo x`;
    expect(composed).toBe(expected);
    // The command is the FIRST token the harness sees.
    expect(composed.startsWith("/skill:dev-mode ")).toBe(true);
  });

  test("a lone leading command composes with the preamble and no trailing blank line", () => {
    expect(composeEscalatedPrompt("/dev-mode", "ask")).toBe(`/dev-mode ${ESCALATION_PREAMBLE}`);
  });

  test("leading slash command picks the session preamble in ask session mode", () => {
    // RFC-04 session channel: same leading-command rule, swap the
    // preamble text. The session preamble is the only branch that
    // mentions "persistent session" - assert on that key phrase.
    const composed = composeEscalatedPrompt("/skill:dev-mode do x", "ask", "session");
    expect(composed.startsWith("/skill:dev-mode ")).toBe(true);
    expect(composed.endsWith("\n\ndo x")).toBe(true);
    expect(composed).toContain("persistent session");
    expect(composed).toContain("hcn-question");
  });

  test("assume mode keeps a leading command first and inserts the no-escalation preamble", () => {
    const composed = composeEscalatedPrompt("/skill:dev-mode do x", "assume");
    const expected = `/skill:dev-mode ${NO_ESCALATION_PREAMBLE}\n\ndo x`;
    expect(composed).toBe(expected);
    expect(composed.startsWith("/skill:dev-mode ")).toBe(true);
    expect(composed).not.toContain("```hcn-question");
  });

  test("an absolute-path prompt is not a command even when it starts with /", () => {
    // `/Users/kevin/x` matches `/Users` greedily, but the spec says the
    // token must end at whitespace or end-of-prompt. `/Users` here is
    // followed by `/`, so it is not a command - the prompt composes
    // the legacy way.
    const composed = composeEscalatedPrompt("/Users/kevin/x", "ask");
    expect(composed.startsWith(QUESTION_PREAMBLE_MARKER)).toBe(true);
    expect(composed).toBe(`${ESCALATION_PREAMBLE}\n\n/Users/kevin/x`);
  });

  test("a leading space means no command - the slash token is not at the start", () => {
    const composed = composeEscalatedPrompt(" /dev-mode", "ask");
    expect(composed).toBe(`${ESCALATION_PREAMBLE}\n\n /dev-mode`);
  });

  test("a prompt of only `/` is not a command", () => {
    // The token requires one alphanumeric char after `/`. A bare slash
    // is not a harness command and the prompt composes the legacy way.
    const composed = composeEscalatedPrompt("/", "ask");
    expect(composed).toBe(`${ESCALATION_PREAMBLE}\n\n/`);
  });

  test("idempotence: a leading-command prompt with a marker right after `<command> ` passes through unchanged", () => {
    // The marker in the position right after `<command> ` is the second
    // idempotence form. Recomposing must not double the preamble.
    const once = composeEscalatedPrompt("/skill:dev-mode do x", "ask");
    expect(once.startsWith("/skill:dev-mode [hcn question protocol]")).toBe(true);
    expect(composeEscalatedPrompt(once, "ask")).toBe(once);
    expect(composeEscalatedPrompt(once, "assume")).toBe(once);
    expect(composeEscalatedPrompt(once, "none")).toBe(once);
  });

  test("idempotence: composing a leading-command prompt twice in the same mode does not double the preamble", () => {
    const once = composeEscalatedPrompt("/dev-mode do it", "ask");
    const twice = composeEscalatedPrompt(once, "ask");
    expect(twice).toBe(once);
    // Sanity: exactly one marker line at the position right after the
    // command.
    const markerCount = once.split(QUESTION_PREAMBLE_MARKER).length - 1;
    expect(markerCount).toBe(1);
  });

  test("mode `none` with a leading command is unchanged - no preamble is added", () => {
    expect(composeEscalatedPrompt("/dev-mode do x", "none")).toBe("/dev-mode do x");
    expect(composeEscalatedPrompt("/dev-mode", "none")).toBe("/dev-mode");
  });

  test("leading command parse treats tab as a separator (same rule as space)", () => {
    // The token must end at whitespace; the spec's `<command>` form
    // inserts exactly one space in the composed output regardless of
    // which whitespace char the user typed.
    const composed = composeEscalatedPrompt("/dev-mode\tdo x", "ask");
    expect(composed.startsWith("/dev-mode ")).toBe(true);
    expect(composed.endsWith("\n\ndo x")).toBe(true);
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
