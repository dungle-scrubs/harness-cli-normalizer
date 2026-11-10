/**
 * Issue #469: pure decoding and reply encoding for pi's extension UI
 * dialogs on a persistent session. In RPC mode (verified 1.4.0) pi raises
 * a dialog as one stdout record
 *
 *   {"type":"extension_ui_request","id":"<uuid>","method":"select",
 *    "title":"..","options":["..",".."],"timeout":5000}
 *   {"type":"extension_ui_request","id":"<uuid>","method":"input",
 *    "title":"..","placeholder":".."}
 *
 * and waits for exactly one stdin line
 *
 *   {"type":"extension_ui_response","id":"<same id>","value":"<text>"}
 *   {"type":"extension_ui_response","id":"<same id>","cancelled":true}
 *
 * The `select` and `input` dialogs are forwarded: each is a question the
 * host can answer, and hcn maps it onto the same approval vocabulary the
 * Claude lane uses (`input` as a free-text question). `confirm` and
 * `editor` are emitted the same way and stay ignored, and the
 * fire-and-forget methods (`notify`, `setStatus`, `setWidget`,
 * `setTitle`, `set_editor_text`) carry no request id at all.
 *
 * Issue #470: an `editor` dialog whose title carries hcn's marker is
 * hcn's own structured question format - the prefill is the question
 * JSON, and hcn answers it with the whole question set. The marker and
 * the format version are descriptor data, and an unmarked `editor`
 * dialog stays ignored exactly as before.
 *
 * hcn decides nothing here: pi resolves the dialog itself when it expires
 * or when an abort cancels it, and the host's answer is written back
 * unchanged. No process logic lives here - the execution layer owns the
 * pending map, the write and the clearing.
 */
import type {
  PiExtensionDialogMethod,
  PiStructuredQuestionChannel,
} from "../knowledge/descriptor.js";
import type { ApprovalQuestion, ApprovalQuestionOption } from "../knowledge/native-approvals.js";
import { NATIVE_APPROVAL_LIMITS } from "../knowledge/native-approvals.js";
import { validateApprovalNotes } from "./approval-notes.js";
import type {
  SessionApprovalDecision,
  SessionApprovalDecisionRejection,
  SessionApprovalProposal,
} from "./session-approvals.js";
import { asRecord } from "./shape.js";

/** One decoded dialog: the native request id, the proposal the host
 * answers, and the native timeout when the dialog carries one (pi
 * resolves such a dialog itself when it expires). */
export interface PiExtensionDialog {
  readonly requestId: string;
  readonly proposal: SessionApprovalProposal;
  readonly timeoutMs?: number;
}

/** Issue #470: the outcome of reading one record as hcn's structured
 * question. `null` (from the decoder) means the record is not a marked
 * structured question at all; `invalid` means it is one whose prefill
 * hcn cannot read - the dialog is not forwarded and nothing is written,
 * but the host hears why. */
export type PiStructuredQuestionDecode =
  | { readonly kind: "question"; readonly dialog: PiExtensionDialog }
  | { readonly kind: "invalid"; readonly requestId: string; readonly message: string };

/** The dialog's own timeout in ms, when it carries a usable one: pi
 * resolves such a dialog itself when it expires. */
const nativeTimeoutOf = (record: Record<string, unknown>): number | undefined => {
  const timeout = record.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The option strings one `select` dialog offers, in the order pi lists
 * them. A non-empty array whose every entry is a non-empty string;
 * anything else is not a dialog hcn can answer (pi would have no option
 * to pick). */
const offeredOptions = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") return null;
    options.push(entry);
  }
  return options;
};

const isForwardedMethod = (
  method: unknown,
  dialogs: readonly PiExtensionDialogMethod[],
): method is PiExtensionDialogMethod =>
  (method === "select" || method === "input") && dialogs.includes(method);

/** The one question a dialog asks, or null when the record cannot be
 * answered (a select with no usable options). */
const questionOf = (
  method: PiExtensionDialogMethod,
  title: string,
  record: Record<string, unknown>,
): ApprovalQuestion | null => {
  if (method === "input") {
    const placeholder = record.placeholder;
    return {
      question: title,
      multiSelect: false,
      freeText: true,
      ...(typeof placeholder === "string" && placeholder !== "" ? { placeholder } : {}),
      // Issue #470: pi's own dialogs carry no free-text answer beyond
      // the offered options and no notes at all.
      allowOther: false,
      allowNotes: false,
      options: [],
    };
  }
  const options = offeredOptions(record.options);
  if (options === null) return null;
  return {
    question: title,
    multiSelect: false,
    allowOther: false,
    allowNotes: false,
    options: options.map((label) => ({ label })),
  };
};

/**
 * Decode one parsed pi record into the offered dialog, or null when the
 * record is not a dialog hcn forwards: its method must be one the
 * channel names in `dialogs`. A malformed record is ignored, never
 * half-decoded: an empty id, a missing title, or (for `select`) an empty
 * option list or a non-string option all read as "not a dialog".
 */
export const decodePiExtensionDialog = (
  record: Record<string, unknown>,
  dialogs: readonly PiExtensionDialogMethod[],
): PiExtensionDialog | null => {
  if (record.type !== "extension_ui_request") return null;
  const method = record.method;
  if (!isForwardedMethod(method, dialogs)) return null;
  const requestId = record.id;
  if (typeof requestId !== "string" || requestId === "") return null;
  const title = record.title;
  if (typeof title !== "string") return null;
  const question = questionOf(method, title, record);
  if (question === null) return null;
  const timeoutMs = nativeTimeoutOf(record);
  return {
    requestId,
    proposal: {
      category: "question",
      // The native dialog method. pi's dialog names no tool: the method
      // is the whole of what the native request says.
      tool: method,
      details: title,
      // The native request record, unchanged.
      input: record,
      questions: [question],
      choices: [
        { id: "answer", label: "Answer", scope: "once" },
        { id: "decline", label: "Decline to answer", scope: "deny" },
      ],
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
};

/**
 * Issue #470: hcn's own structured question format on pi's extension
 * UI. An extension raises one `editor` dialog whose title starts with
 * the marker the descriptor names, and whose prefill is the question
 * JSON:
 *
 *   {"v":1,"questions":[{"question":"Pick toppings","header":"Pizza",
 *     "options":[{"label":"Cheese","description":"optional"}],
 *     "multiSelect":true,"allowOther":true,"allowNotes":true}]}
 *
 * hcn decodes it into the same question shape every harness offers, and
 * answers it with the whole question set. The marker, the format
 * version and the bounds are hcn's own: the prefill is not a native
 * format, so hcn owns every rule of it.
 */

/** One optional boolean of a prefill question: false when the key is
 * absent, null when the key is present and is not a boolean (an invalid
 * prefill). */
const optionalBoolean = (value: unknown, present: boolean): boolean | null => {
  if (!present) return false;
  return typeof value === "boolean" ? value : null;
};

/** The questions one structured prefill carries, or null when the
 * prefill is not a valid one. The rules are hcn's: the format version,
 * the question and option counts, unique question texts, unique option
 * labels within a question, and a question with no options must allow
 * other text (it is then a free-text question). Unknown keys are
 * ignored. */
const structuredQuestions = (
  prefill: Record<string, unknown>,
  version: number,
): readonly ApprovalQuestion[] | null => {
  if (prefill.v !== version) return null;
  const raw = prefill.questions;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0 || raw.length > NATIVE_APPROVAL_LIMITS.structuredQuestions) return null;
  const out: ApprovalQuestion[] = [];
  const texts = new Set<string>();
  for (const entry of raw) {
    const question = asRecord(entry);
    if (question === null) return null;
    const text = question.question;
    if (typeof text !== "string" || text === "") return null;
    if (texts.has(text)) return null;
    texts.add(text);
    const header = question.header;
    if (header !== undefined && typeof header !== "string") return null;
    const multiSelect = optionalBoolean(question.multiSelect, "multiSelect" in question);
    const allowOther = optionalBoolean(question.allowOther, "allowOther" in question);
    const allowNotes = optionalBoolean(question.allowNotes, "allowNotes" in question);
    if (multiSelect === null || allowOther === null || allowNotes === null) return null;
    const rawOptions = question.options;
    if (rawOptions !== undefined && !Array.isArray(rawOptions)) return null;
    if (Array.isArray(rawOptions) && rawOptions.length > NATIVE_APPROVAL_LIMITS.structuredOptions) {
      return null;
    }
    const options: ApprovalQuestionOption[] = [];
    const labels = new Set<string>();
    for (const rawOption of Array.isArray(rawOptions) ? rawOptions : []) {
      const option = asRecord(rawOption);
      if (option === null) return null;
      const label = option.label;
      if (typeof label !== "string" || label === "") return null;
      if (labels.has(label)) return null;
      labels.add(label);
      options.push({
        label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      });
    }
    // A question with no options can only be answered with free text,
    // so it must say so.
    if (options.length === 0 && allowOther !== true) return null;
    out.push({
      question: text,
      ...(typeof header === "string" ? { header } : {}),
      multiSelect,
      allowOther,
      allowNotes,
      ...(options.length === 0 ? { freeText: true } : {}),
      options,
    });
  }
  return out;
};

/** The message one invalid prefill produces: it names the dialog, so
 * the extension author knows which one hcn could not read. */
const invalidPrefill = (requestId: string, detail: string): PiStructuredQuestionDecode => ({
  kind: "invalid",
  requestId,
  message: `pi dialog ${JSON.stringify(requestId)}: the hcn-question prefill is invalid (${detail})`,
});

/**
 * Decode one parsed pi record as hcn's structured question, or null when
 * the record is not one: the method must be the one the descriptor names
 * and the title must carry the marker. A marked dialog whose prefill
 * hcn cannot read is `invalid`: it is not forwarded and nothing is
 * written, but the host hears why nothing arrived.
 */
export const decodePiStructuredQuestion = (
  record: Record<string, unknown>,
  spec: PiStructuredQuestionChannel,
): PiStructuredQuestionDecode | null => {
  if (record.type !== "extension_ui_request") return null;
  if (record.method !== spec.method) return null;
  const title = record.title;
  if (typeof title !== "string" || !title.startsWith(spec.titleMarker)) return null;
  const requestId = record.id;
  if (typeof requestId !== "string" || requestId === "") return null;
  const prefill = record.prefill;
  if (typeof prefill !== "string") return invalidPrefill(requestId, "the prefill is not text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(prefill);
  } catch {
    return invalidPrefill(requestId, "the prefill is not JSON");
  }
  const body = asRecord(parsed);
  if (body === null) return invalidPrefill(requestId, "the prefill is not an object");
  const questions = structuredQuestions(body, spec.version);
  if (questions === null) return invalidPrefill(requestId, "the question set is not valid");
  const timeoutMs = nativeTimeoutOf(record);
  return {
    kind: "question",
    dialog: {
      requestId,
      proposal: {
        category: "question",
        // The native dialog method: the marked editor dialog is the
        // whole of what the native request says.
        tool: spec.method,
        // The title without the marker: what the dialog is about.
        details: title.slice(spec.titleMarker.length),
        // The native request record, unchanged.
        input: record,
        questions,
        choices: [
          { id: "answer", label: "Answer", scope: "once" },
          { id: "decline", label: "Decline to answer", scope: "deny" },
        ],
        // Issue #470: the native reply is the whole question set.
        structured: true,
      },
      // The same native timeout rule as the plain dialogs: pi resolves
      // a dialog that carries one itself when it expires.
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
};

/** The native reply line one answer becomes. */
export const encodePiExtensionResponse = (requestId: string, value: string): string =>
  `${JSON.stringify({ type: "extension_ui_response", id: requestId, value })}\n`;

/** The native reply line one decline becomes. pi's dialog carries no
 * message back - cancelling is all it accepts. */
export const encodePiExtensionCancel = (requestId: string): string =>
  `${JSON.stringify({ type: "extension_ui_response", id: requestId, cancelled: true })}\n`;

/**
 * Issue #470: the answers one structured question accepts. Every entry
 * is keyed by one of its questions. A value is a string, or an array of
 * non-empty strings (more than one only when the question is a
 * multi-select). Each value must be one of the question's offered
 * labels, unless the question allows other text - then any non-empty
 * text is accepted, alone or beside the labels.
 */
const structuredAnswers = (
  proposal: SessionApprovalProposal,
  answers: Readonly<Record<string, unknown>>,
): Record<string, string | readonly string[]> | null => {
  const questions = proposal.questions ?? [];
  const known = new Map(questions.map((question) => [question.question, question]));
  const entries = Object.entries(answers);
  if (entries.length === 0 || entries.length > questions.length) return null;
  const out: Record<string, string | readonly string[]> = {};
  for (const [question, value] of entries) {
    const offered = known.get(question);
    if (offered === undefined) return null;
    const labels = offered.options.map((option) => option.label);
    const accepts = (label: string): boolean =>
      offered.allowOther === true || labels.includes(label);
    if (typeof value === "string") {
      if (value === "" || !accepts(value)) return null;
      out[question] = value;
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) return null;
    // An array of one answers any question; more than one needs a
    // multi-select.
    if (value.length > 1 && offered.multiSelect !== true) return null;
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item === "" || !accepts(item)) return null;
      items.push(item);
    }
    out[question] = items;
  }
  return out;
};

/**
 * Issue #470: apply one decision to a structured question. The native
 * reply is the whole question set: the editor's value is the JSON of
 * `{"answers":{..},"notes":{..}}`, with the host's own values (no
 * joining) and no `notes` key when the decision carried none.
 */
const applyStructuredQuestionDecision = (
  requestId: string,
  proposal: SessionApprovalProposal,
  decision: SessionApprovalDecision,
):
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly reason: SessionApprovalDecisionRejection } => {
  // A pi dialog carries no message back: an allow-scope choice refuses
  // one with its own reason.
  if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
  const answers = decision.answers;
  if (!isPlainRecord(answers)) return { ok: false, reason: "invalid-answers" };
  const accepted = structuredAnswers(proposal, answers);
  if (accepted === null) return { ok: false, reason: "invalid-answers" };
  const questions = proposal.questions ?? [];
  const notesRejection = validateApprovalNotes(questions, "answer", answers, decision.notes);
  if (notesRejection !== null) return { ok: false, reason: notesRejection };
  const value = JSON.stringify({
    answers: accepted,
    ...(decision.notes === undefined ? {} : { notes: decision.notes }),
  });
  return { ok: true, line: encodePiExtensionResponse(requestId, value) };
};

/**
 * Apply one structurally valid decision to a pi dialog: the closed choice
 * validation and the native reply line it becomes. Pure: the caller owns
 * consumption and the write.
 *
 * `answer` carries exactly one answer, keyed by the dialog title, as a
 * string or a one-element array. For a `select` it must equal one of the
 * offered option strings exactly (pi matches the option, not a prefix of
 * it); for a free-text `input` any non-empty text is the answer.
 * `decline` cancels the dialog and accepts no message: pi's reply has no
 * field for one.
 *
 * Issue #470: a structured question (hcn's own marked editor dialog) is
 * answered by the whole question set, and pi's plain dialogs carry no
 * notes at all, so notes on one are refused.
 */
export const applyPiExtensionDialogDecision = (
  requestId: string,
  proposal: SessionApprovalProposal,
  decision: SessionApprovalDecision,
):
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly reason: SessionApprovalDecisionRejection } => {
  const choice = proposal.choices.find((offered) => offered.id === decision.choiceId);
  if (choice === undefined) return { ok: false, reason: "unknown-choice" };
  if (proposal.structured === true) {
    if (choice.id === "answer")
      return applyStructuredQuestionDecision(requestId, proposal, decision);
    // Decline: pi's cancel reply carries no message, no answers and no
    // notes.
    if (decision.answers !== undefined) return { ok: false, reason: "invalid-answers" };
    if (decision.notes !== undefined) return { ok: false, reason: "invalid-notes" };
    if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
    return { ok: true, line: encodePiExtensionCancel(requestId) };
  }
  if (choice.id === "answer") {
    // A pi dialog carries no message back: an allow-scope choice refuses
    // one with its own reason.
    if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
    // Issue #470: pi's own dialogs carry no notes.
    if (decision.notes !== undefined) return { ok: false, reason: "invalid-notes" };
    const answers = decision.answers;
    if (!isPlainRecord(answers)) return { ok: false, reason: "invalid-answers" };
    const entries = Object.entries(answers);
    if (entries.length !== 1) return { ok: false, reason: "invalid-answers" };
    const entry = entries[0];
    if (entry === undefined) return { ok: false, reason: "invalid-answers" };
    const [question, value] = entry;
    const offered = proposal.questions?.[0];
    if (offered === undefined || offered.question !== question) {
      return { ok: false, reason: "invalid-answers" };
    }
    let chosen: string;
    if (typeof value === "string") {
      chosen = value;
    } else if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
      chosen = value[0];
    } else {
      return { ok: false, reason: "invalid-answers" };
    }
    if (chosen === "") return { ok: false, reason: "invalid-answers" };
    if (offered.freeText !== true) {
      const labels = offered.options.map((option) => option.label);
      if (!labels.includes(chosen)) return { ok: false, reason: "invalid-answers" };
    }
    return { ok: true, line: encodePiExtensionResponse(requestId, chosen) };
  }
  // Decline: pi's cancel reply carries no message and no answers.
  if (decision.answers !== undefined) return { ok: false, reason: "invalid-answers" };
  // Issue #470: pi's own dialogs carry no notes.
  if (decision.notes !== undefined) return { ok: false, reason: "invalid-notes" };
  if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
  return { ok: true, line: encodePiExtensionCancel(requestId) };
};
