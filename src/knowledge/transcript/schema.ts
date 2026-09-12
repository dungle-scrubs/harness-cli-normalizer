import { deepFreeze } from "../descriptor.js";

export const GUARANTEES = deepFreeze([
  "history",
  "branches",
  "original-records",
  "embedded-content",
] as const);
export const TRANSCRIPT_CAPABILITIES = deepFreeze([
  ...GUARANTEES,
  "active-branch",
  "incremental",
  "paging",
  "record-identity",
] as const);
export type Guarantee = (typeof GUARANTEES)[number];
export type CapabilityName = (typeof TRANSCRIPT_CAPABILITIES)[number];
export type CapabilityStatus = "available" | "limited" | "unavailable" | "unknown";
export interface Build {
  readonly buildId: string | null;
  readonly version: string | null;
}
export interface Applicability {
  readonly formatId: string | null;
  readonly formatVersions: readonly string[];
  readonly readerBuilds: readonly Build[];
  readonly scope: string;
  readonly writerBuilds: readonly Build[];
}
export interface Evidence {
  readonly appliesTo: Applicability;
  readonly reference: string | null;
  readonly standing: "documented" | "observed" | "unknown";
}
export interface Capability {
  readonly evidence: readonly Evidence[];
  readonly prerequisiteRuleIds: readonly string[];
  readonly reason: string;
  readonly status: CapabilityStatus;
}
export type CapabilityMap = Readonly<Record<CapabilityName, Capability>>;
