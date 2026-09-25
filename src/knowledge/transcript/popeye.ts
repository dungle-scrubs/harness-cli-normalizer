import { deepFreeze } from "../descriptor.js";
import type { Capability, CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const POPEYE_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  appliesTo: {
    formatId: "popeye-journal-v1",
    formatVersions: ["1"],
    readerBuilds: [],
    scope:
      "Popeye journal v1 flat session files; header plus entry/record lines with session binding. Compatible writers must preserve these semantics.",
    writerBuilds: [
      { buildId: null, version: "0.1.0" },
      { buildId: null, version: "0.1.3" },
    ],
  },
  reference: null,
  standing: "observed",
});
const definitions = [
  [
    "popeye-continuation-v1",
    "continuation",
    "Bookmark v1 binds popeye-file-v1, header session ID, acknowledged-entry count, byte offset, and SHA-256 of the first offset bytes. Verify all fields and the prefix before continuation. No digest, no continuation.",
  ],
  [
    "popeye-file-resolution-v1",
    "resolution",
    "An explicit file selects its journal header session ID. ID lookup is flat under the session directory with the exact <sessionId>.jsonl filename. Reject multiple matches; validate the chosen header ID. Never initialize missing stores.",
  ],
  [
    "popeye-format-v1",
    "compatibility",
    "Require a journal header (format popeye_journal, version 1) with a nonempty session ID matching the filename stem, and well-framed entry/record lines each naming the header session. Reject unknown format versions without migration.",
  ],
  [
    "popeye-passive-file-v1",
    "passivity",
    "Open regular files read-only. Never start Popeye, repair a torn tail, or write history. A torn tail reports incompleteTail with the intact prefix. Close the file on every exit.",
  ],
  [
    "popeye-order-v1",
    "ordering",
    "The journal file is one session in durable order. Preserve every acknowledged non-header line in byte order.",
  ],
  [
    "popeye-normalization-v1",
    "normalization",
    "Preserve original line JSON values. Normalize message roles, parent-entry links from parentId, tool-call links from toolCallId, and first-kept-entry from retainedTailIds. Timestamps are absent: rows report timestamp null.",
  ],
  [
    "popeye-prefix-v1",
    "consistency",
    "Capture one regular-file identity and finite byte size. Read that prefix twice through the same open handle and compare bytes and metadata. Exclude later appends. Fail detected replacement, truncation or changed prefix.",
  ],
] as const;
export const POPEYE_TRANSCRIPT_RULES = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: POPEYE_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence: [POPEYE_TRANSCRIPT_EVIDENCE],
    id,
    purpose,
  })),
);
const STATUSES: Readonly<Record<string, { status: Capability["status"]; reason: string }>> = {
  history: {
    status: "available",
    reason: "Every retained entry is included in the acknowledged prefix.",
  },
  branches: {
    status: "limited",
    reason: "leaf_moved records mark branch points; only the current branch prefix is a live view.",
  },
  "original-records": {
    status: "limited",
    reason: "Entry payloads are preserved verbatim in original; no native id beyond the popeye id.",
  },
  "embedded-content": { status: "unavailable", reason: "Journal payloads are text only." },
  "active-branch": {
    status: "limited",
    reason: "Saved leaf selection only; live selection is not observable from the file.",
  },
  incremental: {
    status: "available",
    reason: "Digest bookmarks revalidate the acknowledged prefix on continuation.",
  },
  paging: { status: "unknown", reason: "No paging probe exists for the journal export read." },
  "record-identity": {
    status: "available",
    reason: "Every line carries a stable entry or record id.",
  },
};
export const POPEYE_TRANSCRIPT_CAPABILITIES: CapabilityMap = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => {
      const entry = STATUSES[key] ?? {
        status: "unknown",
        reason: "No observation recorded.",
      };
      const capability: Capability = {
        evidence: [POPEYE_TRANSCRIPT_EVIDENCE],
        prerequisiteRuleIds: ["popeye-format-v1", "popeye-prefix-v1"],
        reason: entry.reason,
        status: entry.status,
      };
      return [key, capability];
    }),
  ) as unknown as CapabilityMap,
);
export const POPEYE_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities: POPEYE_TRANSCRIPT_CAPABILITIES,
  cleanupTimeoutMs: 1000,
  formatIds: ["popeye-journal-v1"],
  id: "popeye-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "popeye-file-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [POPEYE_TRANSCRIPT_EVIDENCE],
    prerequisiteRuleIds: ["popeye-passive-file-v1"],
    reason: "Read-only filesystem I/O without native lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: POPEYE_TRANSCRIPT_RULES.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});

export const POPEYE_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities: POPEYE_TRANSCRIPT_CAPABILITIES,
  methods: [POPEYE_TRANSCRIPT_METHOD],
  rules: POPEYE_TRANSCRIPT_RULES,
  sourceFormats: [
    {
      id: POPEYE_TRANSCRIPT_EVIDENCE.appliesTo.formatId ?? "",
      versions: POPEYE_TRANSCRIPT_EVIDENCE.appliesTo.formatVersions,
      description: POPEYE_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [POPEYE_TRANSCRIPT_EVIDENCE],
    },
  ],
});
