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
 * hcn decides nothing here: pi resolves the dialog itself when it expires
 * or when an abort cancels it, and the host's answer is written back
 * unchanged. No process logic lives here - the execution layer owns the
 * pending map, the write and the clearing.
 */
import type { PiExtensionDialogMethod } from "../knowledge/descriptor.js";
import type { ApprovalQuestion } from "../knowledge/native-approvals.js";
import type {
  SessionApprovalDecision,
  SessionApprovalDecisionRejection,
  SessionApprovalProposal,
} from "./session-approvals.js";

/** One decoded dialog: the native request id, the proposal the host
 * answers, and the native timeout when the dialog carries one (pi
 * resolves such a dialog itself when it expires). */
export interface PiExtensionDialog {
  readonly requestId: string;
  readonly proposal: SessionApprovalProposal;
  readonly timeoutMs?: number;
}

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
      options: [],
    };
  }
  const options = offeredOptions(record.options);
  if (options === null) return null;
  return {
    question: title,
    multiSelect: false,
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
  const timeout = record.timeout;
  const timeoutMs =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
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

/** The native reply line one answer becomes. */
export const encodePiExtensionResponse = (requestId: string, value: string): string =>
  `${JSON.stringify({ type: "extension_ui_response", id: requestId, value })}\n`;

/** The native reply line one decline becomes. pi's dialog carries no
 * message back - cancelling is all it accepts. */
export const encodePiExtensionCancel = (requestId: string): string =>
  `${JSON.stringify({ type: "extension_ui_response", id: requestId, cancelled: true })}\n`;

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
  if (choice.id === "answer") {
    // A pi dialog carries no message back: an allow-scope choice refuses
    // one with its own reason.
    if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
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
  if (decision.message !== undefined) return { ok: false, reason: "invalid-message" };
  return { ok: true, line: encodePiExtensionCancel(requestId) };
};
