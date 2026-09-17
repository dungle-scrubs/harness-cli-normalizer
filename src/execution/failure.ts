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

import {
  detectAuthFailureInLine,
  detectTransportInLine,
  detectTrustRefusal,
  detectUnavailableInLine,
} from "../interpretation/limits.js";
import type { RefusalIssue } from "../interpretation/refusal.js";
import type {
  AuthFailureKind,
  DiscoveryFacet,
  HarnessDescriptor,
  LimitCode,
} from "../knowledge/descriptor.js";
import type { NativeApprovalFailure } from "../knowledge/native-approvals.js";

export const FAILURE_CLASSES = Object.freeze([
  "rate-limit",
  "usage-limit",
  "quota",
  "auth",
  "budget",
  "task",
  "transport",
  "unavailable",
  "rejected",
  "native",
  "timeout",
  "trust-refused",
] as const);
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureSummary {
  readonly nativeApproval?: import("../knowledge/native-approvals.js").NativeApprovalFailure;
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
  /** D6: the harness process's own exit code for a native failure - data,
   * because native conventions differ from hcn's (codex usage errors exit
   * 2, which hcn reserves for refusals). */
  readonly nativeExitCode?: number;
}

export const retryableOf = (cls: FailureClass): boolean =>
  cls !== "task" && cls !== "budget" && cls !== "rejected" && cls !== "native" && cls !== "timeout";

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
    case "unavailable":
      return `Provider cannot serve this route${detail ? ` (${detail})` : ""} - route to another model or provider`;
    case "rejected":
      return `Request rejected${detail ? ` (${detail})` : ""} - change options or harness`;
    case "timeout":
      // D11: hcn's wall-clock budget expired and the run was killed. The
      // caller chose this number (arg or config); retrying unchanged will
      // hit the same wall - retry only with a raised budget.
      return `Timeout: run exceeded its wall-clock budget and was killed (SIGTERM, then SIGKILL after grace) - raise --timeout for this workload or split the task`;
    case "trust-refused":
      // RFC-05: the gate fires before any inference, so the remedy is a
      // different call, not a different model. Trusted-directory first,
      // then what --autonomy grants; --trust is never named (hcn has no
      // working channel for it, probes 40/41).
      return `Workspace trust refused${detail ? ` (${detail})` : ""} - run \`agent\` interactively in that directory once, or use a directory Cursor already trusts; --autonomy grants unattended edits and shell for that run without persisting trust`;
    case "native":
      // D6: labeled NATIVE so it can never be confused with an hcn error.
      // The harness's own message follows verbatim; the process exit code
      // rides as data (nativeExitCode), because harness conventions differ
      // (codex exits 2 on usage errors - the same code hcn uses for
      // refusals, so hcn owns its own exit code and reports the native one).
      return `NATIVE ERROR from harness${detail ? `: ${detail}` : ""} - the harness rejected or failed on its own arguments; this is not an hcn error`;
    default:
      return `Failure${detail ? ` (${detail})` : ""}`;
  }
}; /** D11: the run outlived its caller-set wall-clock budget. */
export const failureFromTimeout = (): FailureSummary => ({
  class: "timeout",
  retryable: retryableOf("timeout"),
  message: messageFor("timeout"),
});

/** D6: a failure that belongs to the harness, not hcn. Carries the
 * native stderr verbatim and the native exit code as data. */
export const failureFromNative = (
  nativeExitCode: number | null,
  stderrTail: readonly string[],
): FailureSummary => ({
  class: "native",
  retryable: retryableOf("native"),
  message: messageFor(
    "native",
    stderrTail.slice(-3).join(" | ").slice(0, 512) || `exit ${nativeExitCode}`,
  ),
  nativeExitCode: nativeExitCode ?? undefined,
});

/** A limit, from a wall phrasing (detail defaults to the code) or from a
 * structured record that names its status and, sometimes, a reset time. */
export const failureFromLimit = (
  code: LimitCode,
  detail: string = code,
  resetsAt?: number,
): FailureSummary => {
  const cls: FailureClass =
    code === "rate-limit"
      ? "rate-limit"
      : code === "credits" || code === "quota"
        ? "quota"
        : "usage-limit";
  return {
    class: cls,
    retryable: retryableOf(cls),
    message: messageFor(cls, detail),
    code,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
};

export const failureFromAuth = (kind: AuthFailureKind): FailureSummary => ({
  class: "auth",
  retryable: retryableOf("auth"),
  message: messageFor("auth", kind),
  authKind: kind,
});

/** A terminal error the harness reported on its stream: classify by what
 * it says. An auth wall or a transport fault reached no verdict on the
 * work (retryable); anything else is the model's own failure (task). */
export const failureFromTerminalError = (h: HarnessDescriptor, message: string): FailureSummary => {
  const auth = detectAuthFailureInLine(h, message);
  if (auth !== null) return failureFromAuth(auth);
  if (detectTrustRefusal(h, message)) return failureFromTrust(message);
  if (detectTransportInLine(message)) return failureFromTransport(message);
  if (detectUnavailableInLine(message)) return failureFromUnavailable(message);
  return failureFromTask(message);
};

export const failureFromTask = (detail?: string): FailureSummary => ({
  class: "task",
  retryable: retryableOf("task"),
  message: messageFor("task", detail),
});

export const failureFromBudget = (detail?: string): FailureSummary => ({
  class: "budget",
  retryable: retryableOf("budget"),
  message: messageFor("budget", detail),
});

export const failureFromTransport = (detail?: string): FailureSummary => ({
  class: "transport",
  retryable: retryableOf("transport"),
  message: messageFor("transport", detail),
});

/** Short detail shared by the blocked-approval error event and failure. */
export const blockedApprovalDetail = (
  harness: import("../knowledge/descriptor.js").HarnessName,
  subject: "approval" | "input",
  kind: string,
): string => {
  const safe = /^[A-Za-z]+$/.test(kind) ? kind : "native";
  return subject === "input"
    ? `${harness} is waiting on user input this headless run cannot answer`
    : `${harness} is waiting on a ${safe} approval this headless run cannot answer`;
};

/** Issue #179: the harness waits on a native approval (or user-input
 * request) that a headless run can never answer - muse exec omits pending
 * approvals from stdout, so without observation the turn hangs until
 * --timeout. A task failure, non-retryable: the remedy is answering in the
 * harness, or --autonomy only when unattended approvals are acceptable -
 * never auto-routing the same work elsewhere. The subject kind names the
 * blocked subject (network, shell, fileAccess, process, tool, or user
 * input); native payload values (commands, hosts, paths) are never copied
 * here. */
export const failureFromBlockedApproval = (
  harness: import("../knowledge/descriptor.js").HarnessName,
  subject: "approval" | "input",
  kind: string,
): FailureSummary => {
  return {
    class: "task",
    retryable: retryableOf("task"),
    message: messageFor(
      "task",
      `${blockedApprovalDetail(harness, subject, kind)} - the run was stopped; answer it in ${harness}, or rerun with --autonomy only if unattended approvals are acceptable`,
    ),
  };
};

/** The observer itself failed (helper spawn, helper crash, repeated
 * unreadable samples): the pending set is unknown, never empty. Fail
 * closed - a turn hcn cannot supervise must not hang silently until
 * --timeout. A transport failure, retryable: hcn's own supervision broke,
 * not the model's work, so routing the same work elsewhere is safe. */
export const failureFromApprovalUnobserved = (
  harness: import("../knowledge/descriptor.js").HarnessName,
): FailureSummary => ({
  class: "transport",
  retryable: retryableOf("transport"),
  message: messageFor(
    "transport",
    `${harness} approval status could not be observed - hcn could not watch the pending approval set for this turn, so the run was stopped rather than risk a silent hang`,
  ),
});

export const failureFromUnavailable = (detail?: string): FailureSummary => ({
  class: "unavailable",
  retryable: retryableOf("unavailable"),
  message: messageFor("unavailable", detail),
});

/** L5: the installed muse helper speaks an MSP surface hcn cannot use
 * (an operation or the handshake was rejected as unknown). Classed
 * `native`, not `transport`: per ADR 0001 the harness failing on hcn's
 * own protocol call is a harness-side failure, not a verdict on the
 * model's work (`task`) and not hcn refusing to build the call
 * (`rejected`). Native is non-retryable, so a caller that retries the
 * same muse route cannot loop the way retryable transport would - the
 * remedy is a newer hcn, a different harness, or --autonomy, never the
 * same call again. */
export const failureFromMuseIncompatibleSurface = (
  harness: import("../knowledge/descriptor.js").HarnessName,
  verifiedAgainst: string,
  method: string,
  code: number | null,
): FailureSummary => {
  const reason =
    code === -32601
      ? "method-not-found -32601"
      : code === -32600
        ? "invalid-request -32600"
        : code === -32602
          ? "invalid-params -32602"
          : code === null
            ? "rejected handshake"
            : `error ${code}`;
  return {
    class: "native",
    retryable: retryableOf("native"),
    message: messageFor(
      "native",
      `${harness} speaks an MSP surface incompatible with hcn (verified against ${harness} ${verifiedAgainst}; ${method} answered ${reason}) - update hcn to a version that supports this ${harness} release, or rerun with --autonomy only if unattended approvals are acceptable`,
    ),
  };
};

/** RFC-05: Cursor refused an untrusted workspace before any inference ran.
 * Retryable derives true from the provider-unavailable family; the
 * messageFor arm names the remedy.
 * RFC-06 Phase 5 ordering note: on `--continue` the no-session check
 * (`No previous chats found.`, exit 1) fires before the trust gate, so a
 * resume-last turn in an untrusted empty cwd fails as native, never
 * trust-refused. That stderr never matches trustMatchers; it falls
 * through to the native arm with verbatim stderr. */
export const failureFromTrust = (detail?: string): FailureSummary => ({
  class: "trust-refused",
  retryable: retryableOf("trust-refused"),
  message: messageFor("trust-refused", detail),
});

/** The post-queue nonzero-exit tail scan (stream-turn.ts): transport first,
 * then unavailable, then the trust gate, then the native fallthrough, and
 * transport on an empty tail (a silent nonzero exit reads as environment,
 * not harness judgment). One owner so the precedence is unit-tested
 * directly; the supervisor per-line check usually fires first, so the
 * trust arm here is defense-in-depth. */
export const failureFromStderrTail = (
  h: HarnessDescriptor,
  exitCode: number | null,
  tail: readonly string[],
): FailureSummary => {
  const transportLine = tail.find((line) => detectTransportInLine(line));
  const unavailableLine = tail.find((line) => detectUnavailableInLine(line));
  const trustLine = tail.find((line) => detectTrustRefusal(h, line));
  if (transportLine !== undefined) return failureFromTransport(transportLine);
  if (unavailableLine !== undefined) return failureFromUnavailable(unavailableLine);
  if (trustLine !== undefined) return failureFromTrust(trustLine);
  if (tail.length > 0) return failureFromNative(exitCode, tail);
  return failureFromTransport(`nonzero exit ${exitCode}`);
};

export const nativeApprovalPreflightEvidence = (issue: RefusalIssue): NativeApprovalFailure => ({
  phase: "preflight",
  process: "not-attempted",
  prompt: "not-submitted",
  reason:
    issue === "native-settings-changed" || issue === "native-settings-unavailable"
      ? issue
      : "request-refused",
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
  retryable: retryableOf("rejected"),
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
  unavailable: 2,
  budget: 3,
  task: 3,
  transport: 4,
  timeout: 3,
  // rejected stands alone (checked before precedence applies); native is
  // terminal-by-classification, never reduced into anything else.
  rejected: 0,
  native: 0,
  // RFC-05: the trust gate fires before any inference, so it shares the
  // provider-unavailable family with the messageFor arm above.
  "trust-refused": 2,
};

export const reduceFailures = (failures: readonly FailureSummary[]): FailureSummary | undefined => {
  if (failures.length === 0) return undefined;
  const first = failures[0];
  if (failures.length === 1) return first;
  if (first === undefined) return undefined;
  // Sort by precedence, then by earliest (stable). Lower precedence number wins.
  let best = first;
  let bestPrec = PRECEDENCE[best.class] ?? 99;
  for (let i = 1; i < failures.length; i++) {
    const cur = failures[i];
    if (cur === undefined) continue;
    const curPrec = PRECEDENCE[cur.class] ?? 99;
    if (curPrec < bestPrec) {
      best = cur;
      bestPrec = curPrec;
    }
    // ties keep earliest (do nothing)
  }
  return best;
};
