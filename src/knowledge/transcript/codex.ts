import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import type { HistoricalLoss, Method, TranscriptKnowledge } from "./wire.js";

export const CODEX_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  appliesTo: {
    formatId: "codex-legacy-0147",
    formatVersions: [],
    readerBuilds: [],
    scope:
      "Codex 0.147.0 append-only legacy rollout, with no inherited history_base. Paginated storage is not covered.",
    writerBuilds: [{ buildId: "be6e8eac029b183056b7e4402879f15d2c85f61b", version: "0.147.0" }],
  },
  reference:
    "https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/rollout/src/recorder.rs",
  standing: "documented",
});
export const CODEX_TRANSCRIPT_CAPABILITIES: CapabilityMap = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence:
          key === "active-branch" || key === "incremental" || key === "paging"
            ? []
            : [CODEX_TRANSCRIPT_EVIDENCE],
        prerequisiteRuleIds: ["codex-legacy-format-v1", "codex-legacy-prefix-v1"],
        reason:
          key === "active-branch" || key === "incremental" || key === "paging"
            ? "This operation is not established by the legacy file reader."
            : "All retained legacy rollout records are available, including original fields and source positions.",
        status:
          key === "active-branch" || key === "incremental" || key === "paging"
            ? "unknown"
            : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
const rules = [
  [
    "codex-legacy-format-v1",
    "compatibility",
    "Require a session_meta header identifying cli_version 0.147.0 and a native thread ID. Absent history_mode means legacy in this selected version. Reject paginated, unknown history_mode, and non-null history_base rather than assuming a suffix is full history.",
  ],
  [
    "codex-legacy-passive-v1",
    "passivity",
    "Read one regular file through read-only I/O; never start app-server, consult a model, write SQLite, initialize stores, or modify history.",
  ],
  [
    "codex-legacy-order-v1",
    "ordering",
    "Legacy storage is one retained rollout file. Preserve all non-header JSONL entries in byte order, including rollback and compaction records. Do not apply rollback to the exported view.",
  ],
  [
    "codex-legacy-normalization-v1",
    "normalization",
    "Normalize only documented response_item message blocks and function-call/result fields. Retain every original object; unknown event shapes remain unknown. Positions are independent of optional native IDs.",
  ],
  [
    "codex-legacy-prefix-v1",
    "consistency",
    "Capture a finite regular-file prefix and native device/inode identity. Compare exact prefix bytes across two reads and reject replacement/truncation. This relies on the selected recorder's append-only legacy write protocol, not arbitrary in-place writers.",
  ],
] as const;
export const CODEX_TRANSCRIPT_RULES = deepFreeze(
  rules.map(([id, purpose, description]) => ({
    appliesTo: CODEX_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence: [CODEX_TRANSCRIPT_EVIDENCE],
    id,
    purpose,
  })),
);
export const CODEX_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities: CODEX_TRANSCRIPT_CAPABILITIES,
  cleanupTimeoutMs: 1000,
  formatIds: ["codex-legacy-0147"],
  id: "codex-legacy-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: null,
  incrementalStrategy: "unknown",
  passivity: {
    evidence: [CODEX_TRANSCRIPT_EVIDENCE],
    prerequisiteRuleIds: ["codex-legacy-passive-v1"],
    reason: "Read-only file access without a native lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: CODEX_TRANSCRIPT_RULES.map((rule) => rule.id),
  selectors: ["file"],
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
