import type { HarnessName } from "../descriptor.js";
import type {
  Applicability,
  Build,
  Capability,
  CapabilityMap,
  Evidence,
  Guarantee,
} from "./schema.js";

export type Phase = "validate" | "resolve" | "read" | "verify" | "cleanup" | "emit";
export type Requirement =
  | "input"
  | "retrieval"
  | "passivity"
  | "identity"
  | "format"
  | "consistency"
  | "bookmark"
  | "paging"
  | "incremental"
  | "output"
  | "cleanup";
export type Issue =
  | "invalid-option-value"
  | "mutually-exclusive-options"
  | "transcript-divergence"
  | "transcript-unverified"
  | "passive-read-unverified"
  | "source-not-found"
  | "source-ambiguous"
  | "source-identity-mismatch"
  | "source-inaccessible"
  | "source-malformed"
  | "fresh-read-required"
  | "source-changed"
  | "guarantee-unmet"
  | "native-read-failed"
  | "interrupted"
  | "cleanup-failed"
  | "output-failed";
export interface TranscriptFailure {
  readonly issue: Issue;
  readonly phase: Phase;
  readonly requirement: Requirement | null;
  readonly guarantee: Guarantee | null;
  readonly message: string;
  readonly hint: {
    readonly message: string;
    readonly methodId: string | null;
    readonly requiredAcceptedLimits: readonly Guarantee[];
  } | null;
  readonly position: Position | null;
  readonly nativeExitCode: number | null;
}
export interface Rule {
  readonly id: string;
  readonly purpose:
    | "resolution"
    | "compatibility"
    | "passivity"
    | "ordering"
    | "normalization"
    | "consistency"
    | "continuation";
  readonly description: string;
  readonly appliesTo: Applicability;
  readonly evidence: readonly Evidence[];
}
export interface Method {
  readonly id: string;
  readonly transport: "file" | "api" | "export-process";
  readonly formatIds: readonly string[];
  readonly selectors: readonly ("id" | "file")[];
  readonly idResolutionRuleId: string | null;
  readonly preference: number;
  readonly passivity: Capability;
  readonly capabilities: CapabilityMap;
  readonly incrementalStrategy: "native" | "revalidate-prefix" | "none" | "unknown";
  readonly identityKinds: readonly ("native-id" | "source-position")[];
  readonly ruleIds: readonly string[];
  readonly bookmarkCompatibility: readonly {
    readonly fromMethodId: string;
    readonly fromBookmarkVersion: number;
    readonly toMethodId: string;
    readonly ruleId: string;
  }[];
  readonly cleanupTimeoutMs: number;
}
export interface TranscriptKnowledge {
  readonly capabilities: CapabilityMap;
  readonly methods: readonly Method[];
  readonly rules: readonly Rule[];
  readonly sourceFormats: readonly {
    readonly id: string;
    readonly versions: readonly string[];
    readonly description: string;
    readonly evidence: readonly Evidence[];
  }[];
}
export interface CapabilityDocument extends TranscriptKnowledge {
  readonly schemaVersion: 1;
  readonly kind: "transcript-capabilities";
  readonly harness: HarnessName;
  readonly hcnVersion: string;
  readonly verifiedAgainst: string | null;
}
export interface Assessment {
  readonly state: "complete" | "limited" | "unknown" | "not-applicable";
  readonly reason: string;
  readonly evidence: readonly Evidence[];
}
export type CoverageMap = Readonly<Record<Guarantee, Assessment>>;
export interface HistoricalLoss {
  readonly state: "known-loss" | "none-established" | "unknown";
  readonly details: readonly {
    readonly kind: "deleted" | "not-persisted" | "truncated" | "other";
    readonly description: string;
    readonly reference: Reference | null;
  }[];
  readonly evidence: readonly Evidence[];
}
export interface Position {
  readonly sourceKey: string;
  readonly unit: "byte-offset" | "entry-index" | "native-cursor";
  readonly value: string;
}
export interface Reference {
  readonly kind: "entry" | "tool-call" | "conversation";
  readonly nativeId: string | null;
  readonly position: Omit<Position, "sourceKey"> | null;
  readonly scope: {
    readonly harness: HarnessName | null;
    readonly conversationId: string | null;
    readonly sourceKey: string | null;
    readonly location: string | null;
  };
}
export type JsonPath = readonly (string | number)[];
export interface Relation {
  readonly state: "known" | "none" | "unknown" | "not-applicable";
  readonly targets: readonly Reference[];
  readonly basis: "native-field" | "format-rule" | "unknown";
  readonly originalPaths: readonly JsonPath[];
  readonly ruleId: string | null;
}
export type RelationshipMap = Readonly<
  Record<
    "parent-entry" | "tool-call" | "first-kept-entry" | "branch-origin" | "parent-conversation",
    Relation
  >
>;
export interface Part {
  readonly kind:
    | "text"
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "image"
    | "audio"
    | "video"
    | "file-reference"
    | "custom"
    | "unknown";
  readonly originalPath: JsonPath;
  readonly text: string | null;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly contentStatus: "included" | "not-included" | "unknown";
}
export interface RecordEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "record";
  readonly sourceKey: string;
  readonly nativeId: string | null;
  readonly position: Position | null;
  readonly originalKind: "saved-record" | "api-record";
  readonly original: Readonly<Record<string, unknown>>;
  readonly normalized: {
    readonly kind:
      | "message"
      | "tool-result"
      | "compaction"
      | "branch-summary"
      | "metadata"
      | "custom"
      | "unknown";
    readonly role: "user" | "assistant" | "system" | "tool" | "custom" | "unknown" | null;
    readonly timestamp: string | null;
    readonly parts: readonly Part[];
    readonly relationships: RelationshipMap;
  };
}
export interface BranchObservation {
  readonly state: "known" | "unknown" | "not-applicable";
  readonly view: "live" | "saved" | "unknown";
  readonly selection: Reference | null;
  readonly evidence: readonly Evidence[];
}
export interface Compatibility {
  readonly state: "verified" | "unverified" | "incompatible";
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly evidence: readonly Evidence[];
}
export interface SourceEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "source";
  readonly harness: HarnessName | null;
  readonly hcnVersion: string;
  readonly conversation: { readonly nativeId: string | null } | null;
  readonly selection: {
    readonly kind: "id" | "file" | "unknown";
    readonly value: string | null;
    readonly workspace: string | null;
    readonly storeRoots: readonly string[];
  };
  readonly sources: readonly {
    readonly key: string;
    readonly kind: "file" | "api-resource" | "export-resource";
    readonly nativeId: string | null;
    readonly location: string | null;
    readonly formatId: string | null;
    readonly formatVersion: string | null;
    readonly writerBuild: Build;
  }[];
  readonly nativeHeaders: readonly {
    readonly sourceKey: string;
    readonly original: Readonly<Record<string, unknown>>;
  }[];
  readonly methodId: string | null;
  readonly readerBuild: Build | null;
  readonly verification: readonly Evidence[];
  readonly appliedRuleIds: readonly string[];
  readonly compatibility: Compatibility;
  readonly requested: readonly Guarantee[];
  readonly acceptedLimits: readonly Guarantee[];
  readonly capabilities: CapabilityMap;
  readonly coverage: CoverageMap;
  readonly historicalLoss: HistoricalLoss;
}
export interface Check {
  readonly ruleId: string;
  readonly outcome: "passed" | "failed" | "unknown";
  readonly description: string;
}
export interface Boundary {
  readonly sourceKey: string;
  readonly observedEntries: string | null;
  readonly progressEntries: string | null;
  readonly observedThrough: Position | null;
  readonly progressThrough: Position | null;
}
export interface Consistency {
  readonly method: "native-snapshot" | "validated-prefix" | "unknown";
  readonly ruleIds: readonly string[];
  readonly boundaries: readonly Boundary[];
  readonly checks: readonly Check[];
  readonly assumptions: readonly string[];
}
export interface Continuation {
  readonly input: "absent" | "verified" | "invalid" | "not-checked";
  readonly output: "advanced" | "same-boundary" | "unavailable";
}
export interface ResultEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "result";
  readonly status: "complete" | "refused" | "failed";
  readonly exitCode: 0 | 1 | 2;
  readonly recordsReturned: number;
  readonly coverage: CoverageMap;
  readonly limits: readonly {
    readonly guarantee: Guarantee;
    readonly accepted: boolean;
    readonly requested: "complete";
    readonly available: Assessment;
    readonly returned: Assessment;
  }[];
  readonly historicalLoss: HistoricalLoss;
  readonly capabilities: CapabilityMap;
  readonly compatibility: Compatibility;
  readonly appliedRuleIds: readonly string[];
  readonly more: boolean | null;
  readonly incompleteTail: { readonly position: Position; readonly reason: string } | null;
  readonly activeBranch: BranchObservation;
  readonly consistency: Consistency;
  readonly continuation: Continuation;
  readonly bookmark: string | null;
  readonly failure: TranscriptFailure | null;
}
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
