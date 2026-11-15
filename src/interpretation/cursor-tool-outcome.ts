/**
 * The canonical cursor tool-outcome helpers (issue #440): one pure module
 * owns how a cursor native tool result settles - rejected / error /
 * success / unknown. The one execution backend (the SDK worker) and the
 * historical CLI reader it must stay compatible with both read through
 * here, so neither re-implements a copy.
 *
 * Two native spellings exist and both are read here, as pure data:
 *
 * - the legacy CLI result payload `{rejected:{reason}} | {error} |
 *   {success:{...}}` (the fixture corpus's shape), and
 * - the SDK's status/value wrapper `{status:'success', value:{...}} |
 *   {status:'error', error:{message,...}}`, which the SDK itself builds
 *   from the typed proto oneof (installed @cursor/sdk 1.0.38,
 *   dist/cjs/748.js): native shell success AND failure both map onto
 *   status:'success' (the exitCode is the only failure signal), while
 *   rejection, timeout and spawn errors all map onto status:'error'.
 *
 * The SDK conversion loses the rejection CATEGORY for ordinary built-in
 * tools - the public API exposes no field that separates a denied command
 * from a failed one - but the reason text survives in error.message. A
 * denial is therefore classified ONLY from an explicit `rejected` payload
 * (the legacy CLI arm); it is never inferred from error-message prose.
 */
import type { ContentEvent } from "./content.js";
import { asRecord, readPath } from "./shape.js";

/** A refused tool call as an error observation, for the readers that can
 * see an explicit rejection. */
export const cursorDenialEvent = (tool: string, reason: string): ContentEvent => ({
  kind: "error",
  message:
    reason === "" ? `cursor denied ${tool} (no reason given)` : `cursor denied ${tool}: ${reason}`,
  denial: { tool, reason },
});

export type ToolOutcome =
  | { readonly kind: "success"; readonly isError?: boolean }
  | { readonly kind: "error"; readonly isError: true }
  | { readonly kind: "unknown" }
  | { readonly kind: "rejected"; readonly reason: string; readonly isError: true };

const numberOr = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The settled outcome of a cursor native tool call (rejected / error /
 * success / unknown). `call` carries the record's raw result payload -
 * the legacy CLI shape, or the SDK's status/value wrapper. */
export const cursorToolOutcome = (
  call: Record<string, unknown>,
  toolName: string,
): ToolOutcome | null => {
  const result = asRecord(call.result);
  if (result === null || Object.keys(result).length === 0) return null;
  const rejected = asRecord(result.rejected);
  if (rejected !== null)
    return {
      kind: "rejected",
      isError: true,
      reason: typeof rejected.reason === "string" ? rejected.reason : "",
    };
  if (result.error != null) return { kind: "error", isError: true };
  if (Object.hasOwn(result, "success")) {
    const exitCode = numberOr(readPath(result, "success.exitCode"));
    if (toolName === "shellToolCall" && exitCode === undefined) return { kind: "success" };
    return { kind: "success", isError: exitCode !== undefined && exitCode !== 0 };
  }
  // The SDK wrapper: status success covers native shell success AND
  // failure, so a nonzero exitCode is the only failure signal; status
  // error covers rejection, timeout and runtime errors alike. The
  // rejection category does not survive the conversion (the reason text
  // does, in error.message), so an error wrapper is a generic error -
  // never a denial classified from its message prose.
  if (result.status === "success") {
    const exitCode = numberOr(readPath(result, "value.exitCode"));
    return { kind: "success", isError: exitCode !== undefined && exitCode !== 0 };
  }
  if (result.status === "error") return { kind: "error", isError: true };
  return { kind: "unknown" };
};
