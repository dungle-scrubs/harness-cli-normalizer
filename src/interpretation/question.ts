/**
 * Question escalation (issue #41): the protocol that lets a headless
 * worker ask the CALLER's user a question. Transport is the prompt - no
 * harness ships native question conveyance - so hcn prepends a protocol
 * contract (escalateQuestions true, the default) or the state-the-
 * assumption instruction (false). The worker's final message then carries
 * a fenced `hcn-question` block; detection is structured-first (fields
 * parsed from the block, prose rendered downstream from them).
 *
 * Ratified design note (2026-08-19): autonomy and escalateQuestions are
 * independent flags carving the same substrate by ORIGIN - autonomy =
 * interrupts the harness raises (permission gates), escalateQuestions =
 * interrupts the model raises (judgment gaps). The true-mode preamble
 * must therefore never conflate asking with permission: "you may ask" is
 * never "you lack permission." Both preambles open with the same marker
 * so composition is idempotent (a composed prompt is never re-composed).
 */

/** The shared first line of both preambles - also the idempotence marker
 * for composeEscalatedPrompt. */
export const QUESTION_PREAMBLE_MARKER = "[hcn question protocol]";

export const ESCALATION_PREAMBLE = `${QUESTION_PREAMBLE_MARKER}
You are running headless: no one is watching this session live, but a caller relays answers between turns. This protocol never changes your permissions - asking is not how you obtain permission, and it never removes any permission this run already has. Use the tools you have exactly as granted.
If and only if a genuine decision you cannot make defensibly blocks correct progress, ask by ending your turn: emit one fenced code block tagged hcn-question, as the last content of your final message, containing a single JSON object:

\`\`\`hcn-question
{"question": "<the decision you need made>", "options": ["<option 1>", "<option 2>"], "recommended": "<one of options>"}
\`\`\`

Say nothing after the block. Your turn ends there; the caller's user will answer, and your next turn continues from that answer. For every choice you can make defensibly yourself, do not ask - decide, act, and state the decision you made.`;

export const NO_ESCALATION_PREAMBLE = `${QUESTION_PREAMBLE_MARKER}
You are running headless and no one will answer you in this session. Never ask a question, never request input or confirmation, and never end your turn awaiting a reply. When a decision is ambiguous, pick the most defensible reading, state the assumption you proceeded under in one sentence, and continue to completion.`;

/** Compose the transport preamble onto a prompt. Idempotent: a prompt
 * that already carries either preamble (re-composition on resume, a
 * caller that pre-composed) passes through unchanged. */
export const composeEscalatedPrompt = (prompt: string, escalate: boolean): string =>
  prompt.startsWith(QUESTION_PREAMBLE_MARKER)
    ? prompt
    : `${escalate ? ESCALATION_PREAMBLE : NO_ESCALATION_PREAMBLE}\n\n${prompt}`;

/** The structured question a worker asks (the block's fields). */
export interface QuestionBlock {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommended?: string;
}

/** Detection result: a parsed block, a named malformation (the worker
 * tried to ask but botched the shape - surfaced, never swallowed), or
 * null when no hcn-question block is present. */
export type QuestionDetection = { readonly block: QuestionBlock } | { readonly malformed: string };

/** One fenced-block candidate: the body text plus whether the fence was
 * properly closed (an unclosed opener at end-of-text is still examined -
 * the most likely formatting slip is forgetting the closing fence). */
interface FenceCandidate {
  readonly body: string;
  readonly closed: boolean;
}

const FENCE_OPEN = /(?:^|\n)[ \t]*```[ \t]*hcn-question[ \t]*(?=\n)/g;

/** All hcn-question fence bodies in a text, in order. */
const fenceBodies = (text: string): FenceCandidate[] => {
  const out: FenceCandidate[] = [];
  FENCE_OPEN.lastIndex = 0;
  for (let m = FENCE_OPEN.exec(text); m !== null; m = FENCE_OPEN.exec(text)) {
    const bodyStart = m.index + m[0].length;
    // The closing fence may be indented like the opener (probe evidence:
    // indented blocks occur), so match newline + optional spaces + ```.
    const close = text.slice(bodyStart).search(/\n[ \t]*```/);
    if (close === -1) {
      // Unclosed fence: the body runs to end-of-text. Only meaningful
      // when nothing follows the opener - take it as a candidate anyway.
      out.push({ body: text.slice(bodyStart), closed: false });
      break;
    }
    const bodyEnd = bodyStart + close;
    out.push({ body: text.slice(bodyStart, bodyEnd), closed: true });
    FENCE_OPEN.lastIndex = bodyEnd;
  }
  return out;
};

const parseBlock = (body: string): QuestionDetection => {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { malformed: `hcn-question block is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { malformed: "hcn-question block must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const { question, options, recommended } = obj;
  if (typeof question !== "string" || question.trim() === "") {
    return { malformed: 'hcn-question block field "question" must be a non-empty string' };
  }
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((o) => typeof o !== "string" || o.trim() === "")
  ) {
    return {
      malformed: 'hcn-question block field "options" must be an array of non-empty strings',
    };
  }
  if (recommended !== undefined && typeof recommended !== "string") {
    return { malformed: 'hcn-question block field "recommended" must be a string' };
  }
  return {
    block: {
      question,
      options,
      ...(recommended !== undefined ? { recommended } : {}),
    },
  };
};

/** Detect the hcn-question block in a message text. The LAST block wins
 * (the protocol makes the block the turn's final content; a corrected
 * re-emit supersedes an earlier one). An empty candidate body (a bare
 * unclosed opener with nothing after it) is not a detection. */
export const detectQuestionBlock = (text: string): QuestionDetection | null => {
  const candidates = fenceBodies(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (candidate.body.trim() === "") continue;
    return parseBlock(candidate.body);
  }
  return null;
};
