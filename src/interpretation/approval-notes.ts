/**
 * Issue #470: the notes a host decision may carry, and the one rule
 * every harness shares about them. A note belongs to a question, so it
 * rides the `answer` choice alone, and every note key must name a
 * question that allows notes and is answered in the same decision - a
 * note on an unanswered question has nothing to annotate.
 *
 * The rule is one rule on every harness, so it lives in its own module:
 * the Claude lane (session-approvals.ts) and the pi lane
 * (pi-extension-dialogs.ts) both use it, and neither imports the other
 * for it.
 */
import type { ApprovalQuestion } from "../knowledge/native-approvals.js";

/** The reason a decision's notes are refused, or null when they are
 * allowed. The vocabulary is the approval decision vocabulary, closed on
 * purpose: a host reads which field to fix. */
export type ApprovalNotesRejection = "invalid-notes";

export const validateApprovalNotes = (
  questions: readonly ApprovalQuestion[],
  choiceId: string,
  answers: Readonly<Record<string, unknown>> | undefined,
  notes: Readonly<Record<string, string>> | undefined,
): ApprovalNotesRejection | null => {
  if (notes === undefined) return null;
  if (choiceId !== "answer") return "invalid-notes";
  // An empty map says nothing, like an empty answers map: refusing it
  // keeps a note-free reply byte-identical to one sent without notes.
  if (Object.keys(notes).length === 0) return "invalid-notes";
  for (const [question, note] of Object.entries(notes)) {
    if (typeof note !== "string" || note === "") return "invalid-notes";
    const offered = questions.find((entry) => entry.question === question);
    if (offered === undefined || offered.allowNotes !== true) return "invalid-notes";
    if (answers === undefined || !Object.hasOwn(answers, question)) return "invalid-notes";
  }
  return null;
};
