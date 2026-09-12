import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import type { HistoricalLoss, Method, TranscriptKnowledge } from "./wire.js";

export const CODEX_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  appliesTo: {
    formatId: "codex-rollout-0147",
    formatVersions: [],
    readerBuilds: [],
    scope:
      "Codex 0.147.0 uncompressed legacy and ordinal-bearing paginated rollouts; explicit history_base prefixes are assembled within the selected native namespace.",
    writerBuilds: [{ buildId: "be6e8eac029b183056b7e4402879f15d2c85f61b", version: "0.147.0" }],
  },
  reference:
    "https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout/src/recorder.rs",
  standing: "documented",
});
const lineageEvidence: Evidence = deepFreeze({
  ...CODEX_TRANSCRIPT_EVIDENCE,
  reference:
    "https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/thread-store/src/local/rollout_lineage.rs",
});
export const CODEX_TRANSCRIPT_CAPABILITIES: CapabilityMap = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: key === "active-branch" ? [] : [CODEX_TRANSCRIPT_EVIDENCE, lineageEvidence],
        prerequisiteRuleIds: ["codex-rollout-format-v1", "codex-rollout-prefix-v1"],
        reason:
          key === "active-branch"
            ? "Saved or live branch selection is not established by the rollout reader."
            : "All retained rollout records in the requested history are available, with original fields, source positions, batches and verified-prefix continuation.",
        status: key === "active-branch" ? "unknown" : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
const rules = [
  [
    "codex-rollout-resolution-v1",
    "resolution",
    "Resolve exact rollout-...-ID.jsonl names recursively under CODEX_HOME/sessions and archived_sessions (default ~/.codex). Check the selected header identity and reject multiple matches. Compressed candidates are recognized but not decoded by this method. Renamed or database-only locations require an explicit file; never query or initialize native SQLite.",
  ],
  [
    "codex-rollout-continuation-v1",
    "continuation",
    "Bookmark v1 binds codex-rollout-file-v1, requested native ID, global entry count and summed prefix byte boundaries. A single source uses its prefix SHA-256. Multiple sources hash the ordered nativeId/boundary/digest objects for their committed prefixes, including every source header. Base topology and cutoff changes invalidate continuation. Verify all fields; never silently restart.",
  ],
  [
    "codex-rollout-format-v1",
    "compatibility",
    "Require a session_meta header identifying cli_version 0.147.0 and a native thread ID. Absent history_mode means legacy. Paginated sources require contiguous exact ordinals, including metadata, and complete subagent initialization. Follow only history_base storage references; validate native identity, acyclic lineage, exact complete-line byte cutoff and exclusive ordinal cutoff. Reject unknown modes, legacy bases, missing ranges and compressed sources.",
  ],
  [
    "codex-rollout-passive-v1",
    "passivity",
    "Read contributing regular files through read-only I/O; never start app-server, consult a model, write SQLite, initialize stores, or modify history.",
  ],
  [
    "codex-rollout-order-v1",
    "ordering",
    "Legacy storage is one rollout. Paginated history is the native base lineage ordered oldest first, each ancestor bounded by its explicit byte and ordinal cutoff. Exclude each source header from records, retain it in nativeHeaders. Preserve every retained entry in physical byte order, including rollback and compaction. Do not apply projection or dereference parent_thread_id/forked_from_id.",
  ],
  [
    "codex-rollout-normalization-v1",
    "normalization",
    "Normalize only documented response_item message blocks and function-call/result fields. Retain every original object; unknown event shapes remain unknown. Positions are independent of optional native IDs.",
  ],
  [
    "codex-rollout-prefix-v1",
    "consistency",
    "Capture a finite regular-file prefix and native device/inode identity. Compare exact prefix bytes across two reads and reject replacement/truncation. Revalidate every contributing range after the complete lineage is captured. This relies on the selected recorder's append protocol, not arbitrary in-place writers. Native materialization/replacement invalidates observed changes; do not repair or migrate.",
  ],
] as const;
export const CODEX_TRANSCRIPT_RULES = deepFreeze(
  rules.map(([id, purpose, description]) => ({
    appliesTo: CODEX_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence: [CODEX_TRANSCRIPT_EVIDENCE, lineageEvidence],
    id,
    purpose,
  })),
);
export const CODEX_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities: CODEX_TRANSCRIPT_CAPABILITIES,
  cleanupTimeoutMs: 1000,
  formatIds: ["codex-rollout-0147"],
  id: "codex-rollout-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "codex-rollout-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [CODEX_TRANSCRIPT_EVIDENCE],
    prerequisiteRuleIds: ["codex-rollout-passive-v1"],
    reason: "Read-only file access without a native lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: CODEX_TRANSCRIPT_RULES.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});

export const CODEX_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities: CODEX_TRANSCRIPT_CAPABILITIES,
  methods: [CODEX_TRANSCRIPT_METHOD],
  rules: CODEX_TRANSCRIPT_RULES,
  sourceFormats: [
    {
      id: CODEX_TRANSCRIPT_EVIDENCE.appliesTo.formatId ?? "",
      versions: CODEX_TRANSCRIPT_EVIDENCE.appliesTo.formatVersions,
      description: CODEX_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [CODEX_TRANSCRIPT_EVIDENCE],
    },
  ],
});

export const CODEX_HISTORICAL_LOSS: HistoricalLoss = deepFreeze({
  state: "known-loss",
  details: [
    {
      kind: "not-persisted",
      description:
        "The selected native persistence policy omits transient events, including output deltas and approval requests. This file cannot establish which omitted events occurred.",
      reference: null,
    },
  ],
  evidence: [
    {
      ...CODEX_TRANSCRIPT_EVIDENCE,
      reference:
        "https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout/src/policy.rs",
    },
  ],
});
