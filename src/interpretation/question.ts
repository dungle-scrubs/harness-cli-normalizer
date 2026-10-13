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

/** Session-mode variant (issue #44): the worker lives in ONE persistent
 * session with a live stdin - the ask stops generation but the session
 * stays open, and the answer arrives as the next user message on the
 * same session. No exit, no resume. */
export const SESSION_ESCALATION_PREAMBLE = `${QUESTION_PREAMBLE_MARKER}
You are running in a persistent session: no one is watching live, but the caller relays answers back into this same session. This protocol never changes your permissions - asking is not how you obtain permission, and it never removes any permission this run already has. Use the tools you have exactly as granted.
If and only if a genuine decision you cannot make defensibly blocks correct progress, ask by stopping: emit one fenced code block tagged hcn-question, as the last content of your reply, containing a single JSON object:

\`\`\`hcn-question
{"question": "<the decision you need made>", "options": ["<option 1>", "<option 2>"], "recommended": "<one of options>"}
\`\`\`

Say nothing after the block and stop generating. The caller's user will answer, and the answer arrives as the next user message in this session - continue from it. For every choice you can make defensibly yourself, do not ask - decide, act, and state the decision you made.`;

/** The wrapper hcn composes around the user's answer to an escalated
 * question, so a consumer never re-derives it (RFC-01; the README quotes
 * the exact text). One owner for both session surfaces. */
export const composeAnswer = (question: string, answer: string): string =>
  `The user answered the question: "${question}" with: ${answer}. Continue accordingly.`;

export type QuestionMode = "ask" | "assume" | "none";

export const QUESTION_MODES: readonly QuestionMode[] = ["ask", "assume", "none"] as const;

export const isQuestionMode = (value: string): value is QuestionMode =>
  (QUESTION_MODES as readonly string[]).includes(value);

/** What a leading-harness-command split looks like: the slash token the
 * harness should match first, plus the prompt text that follows it
 * (one whitespace char consumed). A null result means there is no
 * leading command and the prompt is composed the legacy way. */
interface LeadingCommand {
  readonly command: string;
  readonly rest: string;
}

/** Detect a leading harness slash command. The token is `/` + one
 * `[A-Za-z0-9]` + zero or more `[A-Za-z0-9_:.-]`, and the token must
 * end at whitespace or end-of-prompt - so `/Users/kevin/x` is not a
 * command (the token `/Users` is followed by `/`, not whitespace) and
 * ` /dev-mode` is not (the prompt does not start with `/`). */
const LEADING_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)/;

const parseLeadingCommand = (prompt: string): LeadingCommand | null => {
  const m = LEADING_COMMAND_RE.exec(prompt);
  if (m === null) return null;
  // `m[0]` is the WHOLE token including the leading `/` - that is what
  // we hand back as the command so the composed prompt keeps the `/`.
  const command = m[0];
  const after = prompt.slice(command.length);
  if (after === "") return { command, rest: "" };
  // Token must end at whitespace or end-of-prompt; consume one
  // whitespace char so the remaining text is `<rest>`. Only one of
  // space, tab, or newline separates the command from its tail.
  if (after[0] !== " " && after[0] !== "\t" && after[0] !== "\n" && after[0] !== "\r") {
    return null;
  }
  return { command, rest: after.slice(1) };
};

/** Choose the preamble by mode (and the channel only matters for ask). */
const preambleFor = (mode: QuestionMode, channel: "turn" | "session"): string => {
  if (mode === "assume") return NO_ESCALATION_PREAMBLE;
  return channel === "session" ? SESSION_ESCALATION_PREAMBLE : ESCALATION_PREAMBLE;
};

/** Compose the transport preamble onto a prompt. `mode` selects which
 * preamble to inject (ask/assume/none), and `channel` selects the
 * contract wording: "turn" (exit-and-resume transport, hcn run) or
 * "session" (live channel, hcn session). Idempotent: a prompt that
 * already carries any preamble passes through unchanged - a turn-mode
 * preamble is never re-composed into a session one (the marker matches
 * both; the already-composed contract stands).
 *
 * Leading slash command: when a prompt begins with a harness command
 * (`/skill:dev-mode do x`, `/dev-mode`), hcn puts the command FIRST and
 * inserts the preamble between it and the rest of the prompt -
 * `<command> <preamble>\n\n<rest>`. The harness therefore still sees
 * the command as the first token and continues to invoke its native
 * mode (dev-mode, etc.). When `<rest>` is empty, the trailing blank
 * line is dropped: `<command> <preamble>`. */
export const composeEscalatedPrompt = (
  prompt: string,
  mode: QuestionMode,
  channel: "turn" | "session" = "turn",
): string => {
  if (prompt.startsWith(QUESTION_PREAMBLE_MARKER)) return prompt;
  if (mode === "none") return prompt;
  const leading = parseLeadingCommand(prompt);
  if (leading === null) {
    return `${preambleFor(mode, channel)}\n\n${prompt}`;
  }
  // Idempotence for the leading-command form: if the text right after
  // `<command> ` already starts with the marker, the preamble is
  // already composed and we pass through unchanged. Composing twice
  // never doubles the preamble.
  if (leading.rest.startsWith(QUESTION_PREAMBLE_MARKER)) return prompt;
  const preamble = preambleFor(mode, channel);
  return leading.rest === ""
    ? `${leading.command} ${preamble}`
    : `${leading.command} ${preamble}\n\n${leading.rest}`;
};

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

/** What a turn's close found, recorded on `done` (RFC-01). */
export type QuestionDetectionKind = "block" | "malformed" | "none";

/** The typed question event a detected block becomes: the fields ARE the
 * question; prose renders from them downstream. */
export interface QuestionEvent {
  readonly kind: "question";
  readonly question: string;
  readonly options: readonly string[];
  readonly recommended?: string;
}

/** The one place a detected block becomes a question event (RFC-02
 * change 5). Both runners call it at turn close with the last assistant
 * message: detection is armed only in `ask` mode; a malformed block names
 * its malformation and is never a silent no-op. */
export const questionEventOf = (
  lastAssistantText: string | null,
  mode: QuestionMode,
):
  | { readonly detection: "none" }
  | { readonly detection: "malformed"; readonly malformed: string }
  | { readonly detection: "block"; readonly event: QuestionEvent } => {
  if (mode !== "ask" || lastAssistantText === null) return { detection: "none" };
  const detected = detectQuestionBlock(lastAssistantText);
  if (detected === null) return { detection: "none" };
  if ("malformed" in detected) return { detection: "malformed", malformed: detected.malformed };
  return {
    detection: "block",
    event: {
      kind: "question",
      question: detected.block.question,
      options: detected.block.options,
      ...(detected.block.recommended !== undefined
        ? { recommended: detected.block.recommended }
        : {}),
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
