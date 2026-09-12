import type { HarnessName } from "../../knowledge/descriptor.js";
import { type Evidence, GUARANTEES, type Guarantee } from "../../knowledge/transcript/schema.js";
import type {
  Assessment,
  BranchObservation,
  Compatibility,
  CoverageMap,
  HistoricalLoss,
  Issue,
  Mutable,
  Phase,
  Requirement,
  ResultEnvelope,
  SourceEnvelope,
  TranscriptFailure,
} from "../../knowledge/transcript/wire.js";
import { unknownTranscriptCapabilities } from "../transcript-capabilities.js";
export type TranscriptSelection =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "id"; readonly nativeId: string };
export interface ReadTranscriptRequest {
  readonly nativeStoreRoot?: string;
  readonly acceptedLimits: readonly Guarantee[];
  readonly selection: TranscriptSelection;
  readonly harness: HarnessName | null;
  readonly hcnVersion: string;
  readonly limit?: number | null;
  readonly since?: string | null;
  readonly workspace: string;
}
const unknownBranch: BranchObservation = {
  evidence: [],
  selection: null,
  state: "unknown",
  view: "unknown",
};
const historicalLoss: HistoricalLoss = { details: [], evidence: [], state: "unknown" };
export function assessments(state: Assessment["state"], evidence?: Evidence): CoverageMap {
  const value: Assessment = {
    state,
    evidence: state === "complete" && evidence ? [evidence] : [],
    reason:
      state === "complete"
        ? "Every retained entry is included in the accessible view."
        : "Source coverage is not established.",
  };
  return { history: value, branches: value, "original-records": value, "embedded-content": value };
}
export function failure(
  issue: Issue,
  phase: Phase,
  requirement: Requirement,
  message: string,
): TranscriptFailure {
  return {
    guarantee: null,
    hint: null,
    issue,
    message,
    nativeExitCode: null,
    phase,
    position: null,
    requirement,
  };
}
export function emptyTranscript(
  request: Omit<ReadTranscriptRequest, "selection"> & {
    readonly selection: TranscriptSelection | { readonly kind: "unknown" };
  },
): {
  result: Mutable<ResultEnvelope>;
  source: Mutable<SourceEnvelope>;
} {
  const coverage = assessments("not-applicable");
  const capabilities = unknownTranscriptCapabilities("Source has not been evaluated.");
  const compatibility: Compatibility = {
    evidence: [],
    reason: "Source has not been evaluated.",
    ruleIds: [],
    state: "unverified",
  };
  const source: Mutable<SourceEnvelope> = {
    acceptedLimits: request.acceptedLimits,
    appliedRuleIds: [],
    capabilities,
    compatibility,
    conversation: null,
    coverage,
    harness: request.harness,
    hcnVersion: request.hcnVersion,
    historicalLoss,
    kind: "source",
    methodId: null,
    nativeHeaders: [],
    readerBuild: null,
    requested: GUARANTEES,
    schemaVersion: 1,
    selection: {
      kind: request.selection.kind,
      storeRoots: [],
      value:
        request.selection.kind === "file"
          ? request.selection.path
          : request.selection.kind === "id"
            ? request.selection.nativeId
            : null,
      workspace: request.workspace,
    },
    sources: [],
    verification: [],
  };
  const result: Mutable<ResultEnvelope> = {
    activeBranch: unknownBranch,
    appliedRuleIds: [],
    bookmark: null,
    capabilities,
    compatibility,
    consistency: { assumptions: [], boundaries: [], checks: [], method: "unknown", ruleIds: [] },
    continuation: { input: request.since ? "not-checked" : "absent", output: "unavailable" },
    coverage,
    exitCode: 2,
    failure: null,
    historicalLoss,
    incompleteTail: null,
    kind: "result",
    limits: [],
    more: null,
    recordsReturned: 0,
    schemaVersion: 1,
    status: "refused",
  };
  return { result, source };
}
