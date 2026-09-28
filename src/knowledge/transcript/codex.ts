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
      "Codex uncompressed legacy and ordinal-bearing paginated rollouts, documented against the 0.147.0 recorder and applied to any writer build whose rollout meets those structural rules; each source reports the cli_version its own header names. Explicit history_base prefixes are assembled within the selected native namespace.",
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
const subagentEvidence: Evidence = deepFreeze({
  ...CODEX_TRANSCRIPT_EVIDENCE,
  appliesTo: {
    ...CODEX_TRANSCRIPT_EVIDENCE.appliesTo,
    scope:
      "A spawned agent thread's paginated rollout may inline its parent's prefix: the parent's session_meta and records follow the child's header under one contiguous ordinal sequence, ending just before the header's subagent_history_start_ordinal. Documented against the 0.155.1 recorder (LiveThread::create_with_inherited_model_context copies the parent's persisted items, including its session_meta, into the child's rollout) and a real 0.155.1 rollout; the child's header is the identity, the parent's meta line is retained in nativeHeaders and stays in the entry sequence.",
    writerBuilds: [{ buildId: "be2951ea34f0d295ed0becf97079f92fa5f6950e", version: "0.155.1" }],
  },
  reference:
    "https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/thread-store/src/live_thread.rs",
});
export const CODEX_TRANSCRIPT_CAPABILITIES: CapabilityMap = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence:
          key === "active-branch"
            ? []
            : [CODEX_TRANSCRIPT_EVIDENCE, lineageEvidence, subagentEvidence],
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
    "Require a session_meta header naming a native thread ID, and report the cli_version that header declares rather than requiring a particular one; the writer build is evidence for the caller, not an admission gate. Absent history_mode means legacy. Paginated sources require contiguous exact ordinals, including metadata, and complete subagent initialization. A spawned agent thread's rollout may inline its parent's prefix: admitted only when the header declares thread_source subagent, a source.subagent spawn, and a subagent_history_start_ordinal; the parent's meta then follows as the first record with its own native ID and keeps its ordinal, and any further session_meta is rejected. Follow only history_base storage references; validate native identity, acyclic lineage, exact complete-line byte cutoff and exclusive ordinal cutoff. Reject unknown modes, legacy bases, missing ranges and compressed sources.",
  ],
  [
    "codex-rollout-passive-v1",
    "passivity",
    "Read contributing regular files through read-only I/O; never start app-server, consult a model, write SQLite, initialize stores, or modify history.",
  ],
  [
    "codex-rollout-order-v1",
    "ordering",
    "Legacy storage is one rollout. Paginated history is the native base lineage ordered oldest first, each ancestor bounded by its explicit byte and ordinal cutoff. Exclude each source header from records, retain it in nativeHeaders; a header of an admitted inlined parent prefix is the one exception, kept in the entry sequence so the single ordinal sequence stays gap-free, and the inherited records it opens are rows of this conversation. Preserve every retained entry in physical byte order, including rollback and compaction. Do not apply projection or dereference parent_thread_id/forked_from_id.",
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
    evidence: [CODEX_TRANSCRIPT_EVIDENCE, lineageEvidence, subagentEvidence],
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
