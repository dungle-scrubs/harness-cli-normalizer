import { GUARANTEES, type Guarantee } from "../../knowledge/transcript/schema.js";
import type {
  Issue,
  Method,
  Requirement,
  TranscriptFailure,
  TranscriptKnowledge,
} from "../../knowledge/transcript/wire.js";

interface MethodRequest {
  readonly acceptedLimits: readonly Guarantee[];
  readonly selector: "id" | "file";
  readonly incremental: boolean;
  readonly paging: boolean;
}
function refusal(issue: Issue, requirement: Requirement): TranscriptFailure {
  return {
    issue,
    phase: "validate",
    requirement,
    guarantee: null,
    message: "No verified native read method can express this request.",
    hint: null,
    position: null,
    nativeExitCode: null,
  };
}
export function chooseTranscriptMethod(
  knowledge: TranscriptKnowledge | null,
  request: MethodRequest,
): { readonly method: Method | null; readonly failure: TranscriptFailure | null } {
  const methods = knowledge?.methods ?? [];
  if (knowledge && methods.length === 0)
    return {
      method: null,
      failure: {
        ...refusal("passive-read-unverified", "passivity"),
        message: knowledge.capabilities.history.reason,
      },
    };
  const passive = methods.filter(
    (method) => method.passivity.status === "available" && method.passivity.evidence.length > 0,
  );
  if (!passive.length)
    return { method: null, failure: refusal("passive-read-unverified", "passivity") };
  const selected = passive.filter((method) => method.selectors.includes(request.selector));
  if (!selected.length)
    return { method: null, failure: refusal("transcript-unverified", "identity") };
  const ranked = [...selected].sort((a, b) => {
    const reductions = (method: Method): number =>
      GUARANTEES.filter((key) => method.capabilities[key].status !== "available").length;
    return reductions(a) - reductions(b) || a.preference - b.preference;
  });
  let rejected: TranscriptFailure | null = null;
  for (const method of ranked) {
    let error: TranscriptFailure | null = null;
    for (const key of GUARANTEES) {
      const status = method.capabilities[key].status;
      if (
        status === "unavailable" ||
        (status !== "available" && !request.acceptedLimits.includes(key))
      ) {
        error = {
          ...refusal(
            status === "unknown" ? "transcript-unverified" : "transcript-divergence",
            "retrieval",
          ),
          guarantee: key,
        };
        break;
      }
    }
    for (const [key, required] of [
      ["incremental", request.incremental],
      ["paging", request.paging],
    ] as const) {
      if (!error && required && method.capabilities[key].status !== "available")
        error = refusal(
          method.capabilities[key].status === "unavailable"
            ? "transcript-divergence"
            : "transcript-unverified",
          key,
        );
    }
    if (!error) return { method, failure: null };
    rejected ??= error;
  }
  const alternative = ranked.find(
    (method) =>
      GUARANTEES.every((key) => method.capabilities[key].status !== "unavailable") &&
      (!request.incremental || method.capabilities.incremental.status === "available") &&
      (!request.paging || method.capabilities.paging.status === "available"),
  );
  const error = rejected ?? refusal("transcript-unverified", "retrieval");
  return {
    method: null,
    failure: alternative
      ? {
          ...error,
          hint: {
            message: "This same-conversation method requires explicit coverage opt-ins.",
            methodId: alternative.id,
            requiredAcceptedLimits: GUARANTEES.filter(
              (key) => alternative.capabilities[key].status !== "available",
            ),
          },
        }
      : error,
  };
}
