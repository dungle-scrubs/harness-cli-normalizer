import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import { SNAPSHOT_EVIDENCE, TRANSCRIPT_SNAPSHOT } from "./snapshot.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const CLAUDE_TRANSCRIPT_ENTRY_TYPES: readonly string[] = deepFreeze([
  "user",
  "assistant",
  "system",
  "attachment",
  "progress",
]);

export const CLAUDE_NATIVE_EVIDENCE: Evidence = {
  appliesTo: {
    formatId: "claude-jsonl-main",
    formatVersions: [],
    readerBuilds: [],
    writerBuilds: [{ buildId: null, version: "2.1.233" }],
    scope:
      "Claude 2.1.233 main local JSONL history. Separate agent files, remote/v5 stores and SDK projections are not this format. A filesystem snapshot is required because the native writer can rewrite retained bytes.",
  },
  reference: "docs/transcript-evidence.md#claude-21233",
  standing: "documented",
};

export const CLAUDE_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  ...CLAUDE_NATIVE_EVIDENCE,
  appliesTo: {
    ...CLAUDE_NATIVE_EVIDENCE.appliesTo,
    writerBuilds: [],
    scope:
      "Main local Claude JSONL with one session identity, retained records and native parent/fork fields. Compatibility is conditional on these format semantics, not a writer version label. Unknown payloads remain opaque; clone consistency is independent of native write scheduling.",
  },
});

const definitions = [
  [
    "claude-local-resolution-v1",
    "resolution",
    "An explicit main local file supplies its native sessionId from a recognized transcript row. ID lookup scans CLAUDE_CONFIG_DIR/projects or ~/.claude/projects for exact ID.jsonl filenames, rejects multiple matches and validates the embedded sessionId. Separate agent sidechains, remote backends and SDK stores require other methods; never merge parent or child conversations.",
  ],
  [
    "claude-main-format-v1",
    "compatibility",
    "Read complete UTF-8 LF-delimited JSON objects without duplicate keys or conflicting native entry IDs. Validate known message structure; preserve unfamiliar payloads. Evidence is selected Claude 2.1.233 native persistence, separately from the harness runtime pin.",
  ],
  [
    "claude-snapshot-v1",
    "consistency",
    "Clone one regular source through macOS fclonefileat or Linux FICLONE, with no ordinary-copy fallback. Read complete framing units from that immutable byte view. A snapshot can occur between native writes; it does not assert a native multi-write transaction. Require a supported filesystem and remove the private clone before success. See docs/transcript-snapshot.md.",
  ],
  [
    "claude-passive-v1",
    "passivity",
    "HCN's bounded clone helper opens the native source read-only and creates only a private in-call clone. It never starts Claude, loads native configuration, resumes, migrates or repairs history. Close resources and remove temporary files on every handled exit.",
  ],
  [
    "claude-order-v1",
    "ordering",
    "Preserve every retained record in physical byte order, including metadata, pre-compaction rows and abandoned branches. Parent/fork links are references and never filters. A saved explicit leaf is not live selection.",
  ],
  [
    "claude-normalization-v1",
    "normalization",
    "Retain exact native JSON values and byte positions. Interpret only established message/content blocks, native transcript UUIDs, parent/fork fields, saved leaf and compaction fields; leave unfamiliar values opaque.",
  ],
  [
    "claude-continuation-v1",
    "continuation",
    "Bookmarks bind the method, native conversation ID, complete entry count, byte boundary and SHA-256 of the full committed prefix. Revalidate against a new snapshot. Any prior-prefix change requires a fresh read; no silent restart.",
  ],
] as const;
const rules = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: CLAUDE_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence:
      purpose === "consistency" || purpose === "passivity"
        ? [SNAPSHOT_EVIDENCE]
        : [CLAUDE_TRANSCRIPT_EVIDENCE, CLAUDE_NATIVE_EVIDENCE],
    id,
    purpose,
  })),
);
const capabilities = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: [CLAUDE_TRANSCRIPT_EVIDENCE, CLAUDE_NATIVE_EVIDENCE],
        prerequisiteRuleIds: ["claude-main-format-v1", "claude-snapshot-v1"],
        reason:
          key === "active-branch"
            ? "Only an explicit saved leaf is observable; live selection remains unknown."
            : "Retained main-file history under the Claude format and filesystem snapshot rules.",
        status: key === "active-branch" ? "limited" : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
export const CLAUDE_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities,
  cleanupTimeoutMs: TRANSCRIPT_SNAPSHOT.cleanupTimeoutMs,
  formatIds: ["claude-jsonl-main"],
  id: "claude-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "claude-local-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [CLAUDE_TRANSCRIPT_EVIDENCE, CLAUDE_NATIVE_EVIDENCE],
    prerequisiteRuleIds: ["claude-passive-v1"],
    reason:
      "Read-only native source plus a bounded HCN filesystem clone helper; no native harness lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: rules.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});
export const CLAUDE_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities,
  methods: [CLAUDE_TRANSCRIPT_METHOD],
  rules,
  sourceFormats: [
    {
      id: "claude-jsonl-main",
      versions: [],
      description: CLAUDE_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [CLAUDE_TRANSCRIPT_EVIDENCE, CLAUDE_NATIVE_EVIDENCE],
    },
  ],
});
