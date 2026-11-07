/**
 * Issue #454/#455: pure decoding, normalization and reply encoding for
 * Claude's `can_use_tool` control requests on a persistent session. Under
 * `--permission-prompt-tool stdio` (verified 2.1.319) the child asks the
 * host about each permission-gated tool call and waits for a
 * `control_response`; this module turns the native request into the
 * normalized `approval-request` proposal and a host decision back into the
 * native reply. No process logic lives here: the execution layer owns the
 * pending map, the write and the clearing.
 *
 * hcn decides nothing here: Claude resolves deny rules, hooks and the
 * managed policy before it asks, and the choices offered are exactly the
 * native ones (allow once, session-scoped native suggestions, deny) - no
 * rule of hcn's own, and nothing is offered that would write the user's
 * settings files (suggestions with other destinations are dropped).
 */
import type {
  ApprovalChoice,
  ApprovalQuestion,
  ApprovalQuestionOption,
} from "../knowledge/native-approvals.js";
import { asRecord } from "./shape.js";

export type SessionApprovalCategory = "tool" | "question" | "plan";

/** One offered choice. `update` carries the native permission
 * suggestion a `suggestion-N` choice replays verbatim as
 * `updatedPermissions` - and forwards to the host unchanged, so a host
 * can show the exact native update it grants. */
export interface SessionApprovalChoice extends ApprovalChoice {
  readonly update?: unknown;
}

/** The normalized proposal one `can_use_tool` request becomes. */
export interface SessionApprovalProposal {
  readonly category: SessionApprovalCategory;
  readonly tool: string;
  readonly details: string;
  /** The native tool input, unchanged. */
  readonly input: unknown;
  readonly choices: readonly SessionApprovalChoice[];
  /** `question` only: the normalized questions, keyed by their text. */
  readonly questions?: readonly ApprovalQuestion[];
  /** `plan` only: the input's plan text. */
  readonly plan?: string;
}

/** The native reply a decision becomes: an allow with the (possibly
 * amended) tool input, or a deny whose message reaches the model. */
export type SessionApprovalReply =
  | {
      readonly behavior: "allow";
      readonly updatedInput: unknown;
      readonly updatedPermissions?: readonly unknown[];
    }
  | { readonly behavior: "deny"; readonly message: string };

export const DEFAULT_DENY_MESSAGE = "The user denied this action.";
export const DEFAULT_DECLINE_MESSAGE = "The user declined to answer.";

/** A host decision as it reached the session stdin, structurally parsed. */
export interface SessionApprovalDecision {
  readonly choiceId: string;
  readonly message?: string;
  readonly answers?: Readonly<Record<string, string | readonly string[]>>;
}

export type SessionApprovalDecisionRejection =
  | "unknown-choice"
  | "invalid-answers"
  | "invalid-message";

const TOOL_NAMES: Readonly<Record<string, SessionApprovalCategory>> = {
  AskUserQuestion: "question",
  ExitPlanMode: "plan",
};

const isSessionApprovalCategory = (value: string): value is SessionApprovalCategory =>
  value === "tool" || value === "question" || value === "plan";

/** The label for one session-scoped native suggestion: setMode names the
 * mode, addRules names the rules it adds (`Tool`, or `Tool(ruleContent)`
 * for a scoped rule, joined with ", "), anything else keeps a generic
 * wording that still names the scope the choice grants. Shapes follow
 * Claude's documented PermissionUpdate / PermissionRule objects. */
const permissionRuleLabel = (rule: unknown): string | null => {
  const record = asRecord(rule);
  if (record === null || typeof record.toolName !== "string" || record.toolName === "") return null;
  return typeof record.ruleContent === "string" && record.ruleContent !== ""
    ? `${record.toolName}(${record.ruleContent})`
    : record.toolName;
};
const suggestionLabel = (suggestion: Record<string, unknown>): string => {
  if (suggestion.type === "setMode" && typeof suggestion.mode === "string") {
    const modeWords: Readonly<Record<string, string>> = {
      acceptEdits: "accept edits",
      bypassPermissions: "bypass permissions",
      default: "ask by default",
      dontAsk: "not ask",
    };
    const words = Object.hasOwn(modeWords, suggestion.mode)
      ? modeWords[suggestion.mode]
      : `switch to ${suggestion.mode} mode`;
    return `Allow, and ${words} for this session`;
  }
  if (
    suggestion.type === "addRules" &&
    Array.isArray(suggestion.rules) &&
    suggestion.rules.length > 0
  ) {
    const rules = suggestion.rules.map(permissionRuleLabel).filter((label) => label !== null);
    if (rules.length > 0) return `Allow, and always allow ${rules.join(", ")} for this session`;
  }
  return "Allow, and apply the suggested permission for this session";
};

/** A session-scoped suggestion is offered only when it widens what the
 * session allows, and that is a property of the update's TYPE:
 * `setMode` changes the mode, `addRules` with `behavior: "allow"` adds
 * allow rules, and `addDirectories` adds directories to scope by.
 * `removeRules`, `replaceRules` and `removeDirectories` narrow (or
 * rewrite) the session's permissions and are never a choice, whatever
 * behavior they carry. */
const offeredSuggestion = (suggestion: Record<string, unknown>): boolean => {
  if (suggestion.destination !== "session") return false;
  if (suggestion.type === "setMode" || suggestion.type === "addDirectories") return true;
  return suggestion.type === "addRules" && suggestion.behavior === "allow";
};

const normalizeQuestions = (input: unknown): readonly ApprovalQuestion[] => {
  const questions = asRecord(input)?.questions;
  if (!Array.isArray(questions)) return [];
  const out: ApprovalQuestion[] = [];
  for (const entry of questions) {
    const question = asRecord(entry);
    if (question === null) continue;
    const text = question.question;
    if (typeof text !== "string" || text === "") continue;
    const options: ApprovalQuestionOption[] = [];
    for (const rawOption of Array.isArray(question.options) ? question.options : []) {
      const option = asRecord(rawOption);
      if (option === null || typeof option.label !== "string" || option.label === "") continue;
      options.push({
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      });
    }
    if (options.length === 0) continue;
    out.push({
      question: text,
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
      options,
    });
  }
  return out;
};

/** Decode one parsed `control_request` record carrying a `can_use_tool`
 * request into the offered proposal, or null when the record is not one
 * (or carries no usable identity). Only `subtype === "can_use_tool"`
 * opens this channel: another control request that happens to carry a
 * `tool_name` stays out. */
export const decodeClaudePermissionRequest = (
  record: Record<string, unknown>,
): { readonly requestId: string; readonly proposal: SessionApprovalProposal } | null => {
  const requestId = record.request_id;
  if (typeof requestId !== "string" || requestId === "") return null;
  const request = asRecord(record.request);
  if (request === null || request.subtype !== "can_use_tool") return null;
  const tool = request.tool_name;
  if (typeof tool !== "string" || tool === "") return null;
  const rawCategory = TOOL_NAMES[tool];
  const category: SessionApprovalCategory = isSessionApprovalCategory(rawCategory ?? "")
    ? (rawCategory as SessionApprovalCategory)
    : "tool";
  const input = request.input;
  const displayName = typeof request.display_name === "string" ? request.display_name : tool;
  const details =
    typeof request.description === "string" && request.description !== ""
      ? request.description
      : displayName;
  const choices: SessionApprovalChoice[] = [];
  if (category === "question") {
    choices.push({ id: "answer", label: "Answer", scope: "once" });
    choices.push({ id: "decline", label: "Decline to answer", scope: "deny" });
  } else if (category === "plan") {
    choices.push({ id: "approve", label: "Approve", scope: "once" });
    choices.push({ id: "deny", label: "Deny", scope: "deny" });
  } else {
    choices.push({ id: "allow", label: "Allow", scope: "once" });
    const suggestions = Array.isArray(request.permission_suggestions)
      ? request.permission_suggestions
      : [];
    let index = 0;
    for (const rawSuggestion of suggestions) {
      const suggestion = asRecord(rawSuggestion);
      // Only session-destination suggestions that widen the session are
      // offered: hcn never writes the user's settings files (a persistent
      // destination would) and never offers an update whose type narrows
      // the session's permissions (offeredSuggestion owns the rule).
      if (suggestion === null || !offeredSuggestion(suggestion)) continue;
      index += 1;
      choices.push({
        id: `suggestion-${index}`,
        label: suggestionLabel(suggestion),
        scope: "session",
        update: rawSuggestion,
      });
    }
    choices.push({ id: "deny", label: "Deny", scope: "deny" });
  }
  const planInput = asRecord(input)?.plan;
  return {
    requestId,
    proposal: {
      category,
      tool,
      details,
      input,
      choices,
      ...(category === "question" ? { questions: normalizeQuestions(input) } : {}),
      ...(category === "plan" && typeof planInput === "string" ? { plan: planInput } : {}),
    },
  };
};

/** The `control_response` line that answers one request. */
export const encodeClaudeControlResponse = (
  requestId: string,
  reply: SessionApprovalReply,
): string =>
  `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response:
        reply.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: reply.updatedInput,
              ...(reply.updatedPermissions === undefined
                ? {}
                : { updatedPermissions: reply.updatedPermissions }),
            }
          : { behavior: "deny", message: reply.message },
    },
  })}\n`;

const allowWith = (
  input: unknown,
  updatedPermissions?: readonly unknown[],
): SessionApprovalReply =>
  updatedPermissions === undefined
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "allow", updatedInput: input, updatedPermissions };

/** Apply one structurally valid decision to a proposal: the closed choice
 * validation (answers required for `answer`, refused elsewhere; message
 * denied on allow-scope choices) and the native reply it becomes. Pure:
 * the caller owns consumption and the write. */
export const applySessionApprovalDecision = (
  proposal: SessionApprovalProposal,
  decision: SessionApprovalDecision,
):
  | { readonly ok: true; readonly reply: SessionApprovalReply }
  | { readonly ok: false; readonly reason: SessionApprovalDecisionRejection } => {
  const choice = proposal.choices.find((offered) => offered.id === decision.choiceId);
  if (choice === undefined) return { ok: false, reason: "unknown-choice" };
  // answers belongs to the `answer` choice alone; message is deny-scope.
  // A misplaced message gets its own reason, so the host reads which
  // field to fix rather than guessing between the two.
  if (choice.id !== "answer" && decision.answers !== undefined)
    return { ok: false, reason: "invalid-answers" };
  if (choice.scope !== "deny" && decision.message !== undefined)
    return { ok: false, reason: "invalid-message" };
  if (choice.scope !== "deny") {
    if (choice.id === "answer") {
      const questions = proposal.questions ?? [];
      const answers = decision.answers;
      if (answers === undefined || !isPlainRecord(answers)) {
        return { ok: false, reason: "invalid-answers" };
      }
      const entries = Object.entries(answers);
      if (entries.length === 0) return { ok: false, reason: "invalid-answers" };
      const known = new Set(questions.map((question) => question.question));
      const joined: Record<string, string> = {};
      for (const [question, value] of entries) {
        if (!known.has(question)) return { ok: false, reason: "invalid-answers" };
        if (typeof value === "string") {
          if (value === "") return { ok: false, reason: "invalid-answers" };
          joined[question] = value;
          continue;
        }
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((label) => typeof label !== "string" || label === "")
        ) {
          return { ok: false, reason: "invalid-answers" };
        }
        joined[question] = (value as readonly string[]).join(", ");
      }
      const input = isPlainRecord(proposal.input)
        ? { ...proposal.input, answers: joined }
        : { answers: joined };
      return { ok: true, reply: { behavior: "allow", updatedInput: input } };
    }
    // allow / approve / suggestion-N: the input passes through unchanged;
    // a suggestion additionally replays its native permission.
    return {
      ok: true,
      reply:
        choice.scope === "session" && choice.update !== undefined
          ? allowWith(proposal.input, [choice.update])
          : allowWith(proposal.input),
    };
  }
  // Deny scope: the message is optional, with a category default.
  const message =
    decision.message !== undefined && decision.message !== ""
      ? decision.message
      : choice.id === "decline"
        ? DEFAULT_DECLINE_MESSAGE
        : DEFAULT_DENY_MESSAGE;
  return { ok: true, reply: { behavior: "deny", message } };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
