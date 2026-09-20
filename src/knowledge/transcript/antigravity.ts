import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import { SNAPSHOT_EVIDENCE, TRANSCRIPT_SNAPSHOT } from "./snapshot.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const ANTIGRAVITY_NATIVE_EVIDENCE: Evidence = {
  appliesTo: {
    formatId: "antigravity-step-log-v1",
    formatVersions: [],
    readerBuilds: [],
    writerBuilds: [{ buildId: null, version: "1.2.7" }],
    scope:
      "Antigravity CLI 1.2.7 brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl step logs observed on local headless runs. The sibling transcript.jsonl truncates fields and marks them in truncated_fields; transcript_full.jsonl carried no truncation marker. The conversations/<id>.db store is a separate format.",
  },
  reference: "docs/transcript-evidence.md#antigravity-127",
  standing: "observed",
};

export const ANTIGRAVITY_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  ...ANTIGRAVITY_NATIVE_EVIDENCE,
  appliesTo: {
    ...ANTIGRAVITY_NATIVE_EVIDENCE.appliesTo,
    writerBuilds: [],
    scope:
      "Untruncated Antigravity step logs with contiguous step_index values from 0, one conversation per brain directory and retained original step objects. Compatibility is conditional on these format semantics, not a writer version label. Unknown step types remain opaque; clone consistency is independent of native write scheduling.",
  },
});

const definitions = [
  [
    "antigravity-local-resolution-v1",
    "resolution",
    "The conversation ID is the brain/<id> directory that holds .system_generated/logs/transcript_full.jsonl; step entries carry no conversation identity. ID lookup opens exactly that path under ~/.gemini/antigravity-cli/brain. An explicit file must sit at the same layout. The truncated transcript.jsonl and the conversations/<id>.db store are other formats.",
  ],
  [
    "antigravity-step-log-v1",
    "compatibility",
    "Require complete UTF-8 LF-delimited JSON objects without duplicate keys, with string type, source and status fields and an integer step_index. Refuse entries that declare truncated_fields. Preserve unknown step types and fields without interpreting them.",
  ],
  [
    "antigravity-snapshot-v1",
    "consistency",
    "Clone one regular source through macOS fclonefileat or Linux FICLONE, with no ordinary-copy fallback. Read complete framing units from that immutable byte view. A snapshot can occur between native writes; it does not assert a native multi-write transaction. Require a supported filesystem and remove the private clone before success. See docs/transcript-snapshot.md.",
  ],
  [
    "antigravity-passive-v1",
    "passivity",
    "HCN's bounded clone helper opens the native source read-only and creates only a private in-call clone. It never starts Antigravity, loads native configuration, resumes, migrates or repairs history. Close resources and remove temporary files on every handled exit.",
  ],
  [
    "antigravity-order-v1",
    "ordering",
    "Return every step in physical file order. step_index must start at 0 and increase by 1 per entry; a gap, repeat or nonzero start fails instead of being sorted or skipped, because the log could then omit retained steps.",
  ],
  [
    "antigravity-normalization-v1",
    "normalization",
    "Preserve exact JSON values and source byte positions. USER_INPUT is a user message, SYSTEM_MESSAGE a system message, PLANNER_RESPONSE an assistant message with thinking, content and tool_calls parts, and GENERIC a tool execution result. Tool calls carry no native call ID, so tool-call relationships stay unknown.",
  ],
  [
    "antigravity-continuation-v1",
    "continuation",
    "Bookmarks bind the method, native conversation ID, complete entry count, byte boundary and SHA-256 of the full committed prefix. Revalidate against a new snapshot. Any prior-prefix change requires a fresh read; no silent restart.",
  ],
] as const;
const rules = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: ANTIGRAVITY_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence:
      purpose === "consistency" || purpose === "passivity"
        ? [SNAPSHOT_EVIDENCE]
        : [ANTIGRAVITY_TRANSCRIPT_EVIDENCE, ANTIGRAVITY_NATIVE_EVIDENCE],
    id,
    purpose,
  })),
);
const capabilities = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: [ANTIGRAVITY_TRANSCRIPT_EVIDENCE, ANTIGRAVITY_NATIVE_EVIDENCE],
        prerequisiteRuleIds: ["antigravity-step-log-v1", "antigravity-snapshot-v1"],
        reason:
          key === "active-branch"
            ? "The step log records one linear conversation and no branch selection."
            : key === "record-identity"
              ? "Steps carry no native ID; source positions identify them within one conversation."
              : "All retained steps in the selected untruncated step log under its format and filesystem snapshot rules.",
        status:
          key === "active-branch" ? "unknown" : key === "record-identity" ? "limited" : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
export const ANTIGRAVITY_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities,
  cleanupTimeoutMs: TRANSCRIPT_SNAPSHOT.cleanupTimeoutMs,
  formatIds: ["antigravity-step-log-v1"],
  id: "antigravity-file-v1",
  identityKinds: ["source-position"],
  idResolutionRuleId: "antigravity-local-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [ANTIGRAVITY_TRANSCRIPT_EVIDENCE, ANTIGRAVITY_NATIVE_EVIDENCE],
    prerequisiteRuleIds: ["antigravity-passive-v1"],
    reason:
      "Read-only native source plus a bounded HCN filesystem clone helper; no native harness lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: rules.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});
export const ANTIGRAVITY_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities,
  methods: [ANTIGRAVITY_TRANSCRIPT_METHOD],
  rules,
  sourceFormats: [
    {
      id: "antigravity-step-log-v1",
      versions: [],
      description: ANTIGRAVITY_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [ANTIGRAVITY_TRANSCRIPT_EVIDENCE, ANTIGRAVITY_NATIVE_EVIDENCE],
    },
  ],
});
