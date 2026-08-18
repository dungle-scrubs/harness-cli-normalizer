/**
 * failure: typed taxonomy for every way a turn can fail, and the reduction
 * that collapses many observations into one self-sufficient summary on `done`.
 *
 * Provider-unavailable vs work-verdict is the load-bearing split: a provider-
 * unavailable failure (rate-limit, usage-limit, quota, auth, transport) reached
 * no verdict on the work, so routing the same work elsewhere is safe. A
 * work-verdict failure (task, budget) means the model did the work and the
 * work is wrong or incomplete - the router must NOT auto-route it elsewhere,
 * or it would hide a model error behind a retry. `rejected` is the library
 * refusing to build the call at all (unexpressible option, bad value); it is
 * non-retryable across the whole model chain because the remedy is different
 * options or a different harness, not a different model.
 */

import type { RefusalIssue } from "../interpretation/refusal.js";
import type {
  AuthFailureKind,
  DiscoveryFacet,
  LimitCode,
  TurnOptionKey,
} from "../knowledge/descriptor.js";

export const FAILURE_CLASSES = Object.freeze([
  "rate-limit",
  "usage-limit",
  "quota",
  "auth",
  "budget",
  "task",
  "transport",
  "rejected",
] as const);
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureSummary {
  readonly class: FailureClass;
  readonly retryable: boolean;
  readonly message: string;
  readonly code?: LimitCode;
  readonly authKind?: AuthFailureKind;
  readonly resetsAt?: number;
  readonly issue?: RefusalIssue;
  readonly option?: import("../interpretation/refusal.js").RefusalOption;
  readonly facet?: DiscoveryFacet;
  readonly supported?: readonly string[];
  /** D7: cross-harness support entries derived from descriptors. */
  readonly supportedBy?: ReadonlyArray<{ harness: string; spelling: string }>;
  /** D8: nearest-alternative hint for the current harness. */
  readonly hint?: string;
}

export const retryableOf = (cls: FailureClass): boolean =>
  cls !== "task" && cls !== "budget" && cls !== "rejected";

const messageFor = (cls: FailureClass, detail?: string): string => {
  switch (cls) {
    case "rate-limit":
      return `Rate limit hit${detail ? ` (${detail})` : ""} - retry after backoff or route to another provider`;
    case "usage-limit":
      return `Usage limit reached${detail ? ` (${detail})` : ""} - wait for reset or route to another provider`;
    case "quota":
      return `Quota exceeded${detail ? ` (${detail})` : ""} - replenish quota or route to another provider`;
    case "auth":
      return `Authentication failed${detail ? ` (${detail})` : ""} - re-authenticate this provider`;
    case "budget":
      return `Step budget exhausted${detail ? ` (${detail})` : ""} - raise the step cap and retry on the same model`;
    case "task":
      return `Task failed${detail ? ` (${detail})` : ""} - surface to caller, do not auto-route`;
    case "transport":
      return `Transport failure${detail ? ` (${detail})` : ""} - retry or route to another provider`;
    case "rejected":
      return `Request rejected${detail ? ` (${detail})` : ""} - change options or harness`;
    default:
      return `Failure${detail ? ` (${detail})` : ""}`;
  }
};

export const failureFromLimit = (code: LimitCode): FailureSummary => {
  const cls: FailureClass =
    code === "rate-limit"
      ? "rate-limit"
      : code === "credits" || code === "quota"
        ? "quota"
        : "usage-limit";
  return {
    class: cls,
    retryable: retryableOf(cls),
    message: messageFor(cls, code),
    code: code as LimitCode,
  };
};

export const failureFromAuth = (kind: AuthFailureKind): FailureSummary => ({
  class: "auth",
  retryable: true,
  message: messageFor("auth", kind),
  authKind: kind,
});

export const failureFromTask = (detail?: string): FailureSummary => ({
  class: "task",
  retryable: false,
  message: messageFor("task", detail),
});

export const failureFromBudget = (detail?: string): FailureSummary => ({
  class: "budget",
  retryable: false,
  message: messageFor("budget", detail),
});

export const failureFromTransport = (detail?: string): FailureSummary => ({
  class: "transport",
  retryable: true,
  message: messageFor("transport", detail),
});

export const failureFromRejected = (opts: {
  issue: RefusalIssue;
  option?: import("../interpretation/refusal.js").RefusalOption;
  facet?: DiscoveryFacet;
  supported?: readonly string[];
  supportedBy?: ReadonlyArray<{ harness: string; spelling: string }>;
  hint?: string;
  detail?: string;
}): FailureSummary => ({
  class: "rejected",
  retryable: false,
  // D8: hint first, support list second - prose order matches the
  // structured fields so an agent scanning the message hits the
  // stay-on-harness suggestion before the switch temptation.
  message: messageFor("rejected", opts.detail ?? opts.issue),
  issue: opts.issue,
  option: opts.option,
  facet: opts.facet,
  supported: opts.supported,
  supportedBy: opts.supportedBy,
  hint: opts.hint,
});

/** Precedence for reduction: lower number = higher priority (wins). */
const PRECEDENCE: Record<FailureClass, number> = {
  auth: 1,
  "rate-limit": 2,
  "usage-limit": 2,
  quota: 2,
  budget: 3,
  task: 3,
  transport: 4,
  rejected: 0, // rejected is separate, not reduced with others? But per spec, rejected is non-retryable and stands alone
};

export const reduceFailures = (failures: readonly FailureSummary[]): FailureSummary | undefined => {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  // Sort by precedence, then by earliest (stable). Lower precedence number wins.
  let best = failures[0]!;
  let bestPrec = PRECEDENCE[best.class] ?? 99;
  for (let i = 1; i < failures.length; i++) {
    const cur = failures[i]!;
    const curPrec = PRECEDENCE[cur.class] ?? 99;
    if (curPrec < bestPrec) {
      best = cur;
      bestPrec = curPrec;
    }
    // ties keep earliest (do nothing)
  }
  return best;
};
