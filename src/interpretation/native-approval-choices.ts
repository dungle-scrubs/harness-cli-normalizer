import type { ApprovalChoice } from "../knowledge/native-approvals.js";
import { asRecord } from "./shape.js";

export type PrivateApprovalChoice = ApprovalChoice & { readonly payload: unknown };

export function execpolicyAmendment(decision: unknown): readonly string[] | null {
  const record = asRecord(decision);
  const amendment = asRecord(record?.acceptWithExecpolicyAmendment);
  const prefix = amendment?.execpolicy_amendment;
  return record &&
    Object.keys(record).length === 1 &&
    amendment &&
    Object.keys(amendment).length === 1 &&
    Array.isArray(prefix) &&
    prefix.length > 0 &&
    prefix.every((part) => typeof part === "string")
    ? prefix
    : null;
}

export function nativeApprovalChoice(decision: unknown): PrivateApprovalChoice | null {
  if (decision === "accept")
    return { id: "once", label: "Approve once", scope: "once", payload: { decision } };
  else if (decision === "acceptForSession")
    return {
      id: "session",
      label: "Approve for this native session",
      scope: "session",
      payload: { decision },
    };
  else if (decision === "decline")
    return { id: "deny", label: "Deny", scope: "deny", payload: { decision } };
  else if (decision === "cancel")
    return {
      id: "cancel",
      label: "Cancel this response",
      scope: "cancel",
      payload: { decision },
    };
  else if (execpolicyAmendment(decision))
    return {
      id: "rule",
      label: "Approve and save this rule",
      scope: "persistent",
      payload: { decision },
    };
  else return null;
}
