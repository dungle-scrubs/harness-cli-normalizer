import { cursorSdkFailureOf } from "../interpretation/cursor-sdk.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { Clock } from "./deps.js";
import {
  DIAGNOSTIC_MAX,
  type FailureSummary,
  failureFromAuth,
  failureFromLimit,
  failureFromNative,
  failureFromNativeRejection,
  failureFromTransport,
  isLimitFailure,
  redactBounded,
} from "./failure.js";

/** SDK exception types take precedence over message matching. A generic
 * native error still uses the runner's startup/work-verdict fallback. */
export const failureFromCursorSdkRecord = (
  h: HarnessDescriptor,
  parsed: Record<string, unknown>,
  clock: Clock,
): FailureSummary | null => {
  const failure = cursorSdkFailureOf(parsed);
  if (failure === null) return null;
  const detail = redactBounded(failure.message, DIAGNOSTIC_MAX);
  switch (failure.kind) {
    case "auth": {
      const precise = failureFromNativeRejection(h, detail, clock);
      return precise.class === "auth" ? precise : failureFromAuth(undefined, detail);
    }
    case "rate-limit": {
      const precise = failureFromNativeRejection(h, detail, clock);
      return isLimitFailure(precise) ? precise : failureFromLimit("rate-limit", detail);
    }
    case "transport":
      return failureFromTransport(detail);
    case "config":
    case "not-found":
      return failureFromNative(null, [detail]);
    case "native":
      return null;
  }
};
