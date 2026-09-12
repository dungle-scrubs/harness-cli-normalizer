import { deepFreeze } from "../descriptor.js";
import type { Capability, CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const PI_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  appliesTo: {
    formatId: "pi-jsonl-v3",
    formatVersions: ["3"],
    readerBuilds: [],
    scope:
      "Pi v3 append-only retained entries; no migration or native initialization. Compatible writers must preserve these semantics.",
    writerBuilds: [{ buildId: "914cf1472e715297caa30db4b9535d534a9eb718", version: "0.84.2" }],
  },
  reference:
    "https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts",
  standing: "documented",
});
const definitions = [
  [
    "pi-continuation-v1",
    "continuation",
    "Bookmark v1 binds pi-file-v1, native conversation ID, complete-entry count, byte boundary, and SHA-256 of the entire header and committed prefix. Verify all fields and the prefix before continuation. A new explicit location is allowed when the same native identity and bytes are established. Native IDs alone never validate a bookmark.",
  ],
  [
    "pi-file-resolution-v1",
    "resolution",
    "An explicit file selects its v3 native header ID. ID lookup is workspace-scoped under PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions, using the Pi v3 dash-wrapped workspace slug and the exact _ID.jsonl filename suffix. Reject multiple matches; validate the chosen header ID. Never initialize missing stores.",
  ],
  [
    "pi-format-v3",
    "compatibility",
    "Require a session header with version 3, nonempty id and cwd, and well-framed native entries with unique IDs. Reject unknown format versions without migration.",
  ],
  [
    "pi-passive-file-v1",
    "passivity",
    "Open regular files read-only. Never start Pi, load configuration or extensions, migrate, repair, or write history. Close the file on every exit.",
  ],
  [
    "pi-order-v1",
    "ordering",
    "The v3 JSONL file is one native conversation. Preserve every complete non-header entry in byte order, including abandoned branches.",
  ],
  [
    "pi-normalization-v1",
    "normalization",
    "Preserve original JSON values. Normalize message blocks, explicit parentId, toolCallId and firstKeptEntryId only. Saved selection is the final native entry under Pi's reload rule.",
  ],
  [
    "pi-prefix-v1",
    "consistency",
    "Capture one regular-file identity and finite byte size. Read that prefix twice through the same open handle and compare bytes and metadata. Exclude later appends. Existing Pi v3 histories append; format migrations and forks establish different format/identity. Fail detected replacement, truncation or changed prefix. No claim covers an arbitrary writer violating the declared append-only protocol.",
  ],
] as const;
export const PI_TRANSCRIPT_RULES = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: PI_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence: [PI_TRANSCRIPT_EVIDENCE],
    id,
    purpose,
  })),
);
export const PI_TRANSCRIPT_CAPABILITIES: CapabilityMap = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => {
      const status = key === "active-branch" ? "limited" : "available";
      const capability: Capability = {
        evidence: [PI_TRANSCRIPT_EVIDENCE],
        prerequisiteRuleIds: ["pi-format-v3", "pi-prefix-v1"],
        reason:
          key === "active-branch"
            ? "Saved reload selection only; live selection is not observable from the file."
            : "Complete retained Pi v3 file view under the verified format rules.",
        status,
      };
      return [key, capability];
    }),
  ) as unknown as CapabilityMap,
);
export const PI_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities: PI_TRANSCRIPT_CAPABILITIES,
  cleanupTimeoutMs: 1000,
  formatIds: ["pi-jsonl-v3"],
  id: "pi-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "pi-file-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [PI_TRANSCRIPT_EVIDENCE],
    prerequisiteRuleIds: ["pi-passive-file-v1"],
    reason: "Read-only filesystem I/O without native lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: PI_TRANSCRIPT_RULES.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});

export const PI_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities: PI_TRANSCRIPT_CAPABILITIES,
  methods: [PI_TRANSCRIPT_METHOD],
  rules: PI_TRANSCRIPT_RULES,
  sourceFormats: [
    {
      id: PI_TRANSCRIPT_EVIDENCE.appliesTo.formatId ?? "",
      versions: PI_TRANSCRIPT_EVIDENCE.appliesTo.formatVersions,
      description: PI_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [PI_TRANSCRIPT_EVIDENCE],
    },
  ],
});
