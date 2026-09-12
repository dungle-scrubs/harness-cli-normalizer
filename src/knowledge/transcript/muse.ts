import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import { SNAPSHOT_EVIDENCE, TRANSCRIPT_SNAPSHOT } from "./snapshot.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const MUSE_NATIVE_EVIDENCE: Evidence = {
  appliesTo: {
    formatId: "muse-session-envelope-v1",
    formatVersions: ["1"],
    readerBuilds: [],
    writerBuilds: [{ buildId: "1.1.1-R2514.1", version: "1.1.1" }],
    scope:
      "Muse 1.1.1-R2514.1 bundled session-log documentation and diagnostic field mappings. One native session.jsonl contains schema-1 envelopes; separate child logs and external tool-output files are not merged. Snapshot acquisition avoids an unverified append-only assumption.",
  },
  reference: "docs/transcript-evidence.md#muse-111",
  standing: "documented",
};

export const MUSE_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  ...MUSE_NATIVE_EVIDENCE,
  appliesTo: {
    ...MUSE_NATIVE_EVIDENCE.appliesTo,
    writerBuilds: [],
    scope:
      "Schema-1 Muse session envelopes with one stream identity, increasing native sequence and retained original payloads. Compatibility is conditional on these format semantics, not a writer version label. Unknown payload versions remain opaque; clone consistency is independent of native write scheduling.",
  },
});

const definitions = [
  [
    "muse-local-resolution-v1",
    "resolution",
    "An explicit native session.jsonl supplies its session identity from schema-1 envelope stream.kind=session and stream.id. ID lookup scans XDG_DATA_HOME/muse/sessions or ~/.local/share/muse/sessions for exact ID/session.jsonl suffixes, rejects multiple matches and validates the embedded stream ID. Require the same stream identity throughout; child conversations remain separate.",
  ],
  [
    "muse-envelope-v1",
    "compatibility",
    "Require complete UTF-8 LF-delimited schema-1 JSON envelopes with unique record IDs, one native session stream, nonnegative integer sequence/time/schema metadata and object payloads. Reject duplicate JSON keys and conflicting/decreasing sequences. Preserve unknown payload versions and values without interpreting them.",
  ],
  [
    "muse-snapshot-v1",
    "consistency",
    "Clone one regular source through macOS fclonefileat or Linux FICLONE, with no ordinary-copy fallback. Read complete framing units from that immutable byte view. A snapshot can occur between native writes; it does not assert a native multi-write transaction. Require a supported filesystem and remove the private clone before success. See docs/transcript-snapshot.md.",
  ],
  [
    "muse-passive-v1",
    "passivity",
    "HCN's bounded clone helper opens the native source read-only and creates only a private in-call clone. It never starts Muse or its exporter, loads native configuration, resumes, migrates or repairs history. Close resources and remove temporary files on every handled exit.",
  ],
  [
    "muse-order-v1",
    "ordering",
    "Return every retained envelope in physical file order after checking increasing native sequence values. Gaps or a nonzero first sequence do not prove why prior records are absent; historical loss remains unknown. Do not sort, deduplicate or project a compacted model context.",
  ],
  [
    "muse-normalization-v1",
    "normalization",
    "Preserve exact JSON values and source byte positions. Normalize documented schema-1 runtime.session messages, user steering, tool calls and tool results. Leave unfamiliar payloads opaque, preserve external content references without opening them, and do not infer live branch selection.",
  ],
  [
    "muse-continuation-v1",
    "continuation",
    "Bookmarks bind the method, native conversation ID, complete entry count, byte boundary and SHA-256 of the full committed prefix. Revalidate against a new snapshot. Any prior-prefix change requires a fresh read; no silent restart.",
  ],
] as const;
const rules = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: MUSE_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence:
      purpose === "consistency" || purpose === "passivity"
        ? [SNAPSHOT_EVIDENCE]
        : [MUSE_TRANSCRIPT_EVIDENCE, MUSE_NATIVE_EVIDENCE],
    id,
    purpose,
  })),
);
const capabilities = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: [MUSE_TRANSCRIPT_EVIDENCE, MUSE_NATIVE_EVIDENCE],
        prerequisiteRuleIds: ["muse-envelope-v1", "muse-snapshot-v1"],
        reason:
          key === "active-branch"
            ? "The selected native envelope format does not establish saved or live branch selection."
            : "All retained envelopes in the selected session log under its format and filesystem snapshot rules.",
        status: key === "active-branch" ? "unknown" : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
export const MUSE_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities,
  cleanupTimeoutMs: TRANSCRIPT_SNAPSHOT.cleanupTimeoutMs,
  formatIds: ["muse-session-envelope-v1"],
  id: "muse-file-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "muse-local-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [MUSE_TRANSCRIPT_EVIDENCE, MUSE_NATIVE_EVIDENCE],
    prerequisiteRuleIds: ["muse-passive-v1"],
    reason:
      "Read-only native source plus a bounded HCN filesystem clone helper; no native harness lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: rules.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});
export const MUSE_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities,
  methods: [MUSE_TRANSCRIPT_METHOD],
  rules,
  sourceFormats: [
    {
      id: "muse-session-envelope-v1",
      versions: ["1"],
      description: MUSE_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [MUSE_TRANSCRIPT_EVIDENCE, MUSE_NATIVE_EVIDENCE],
    },
  ],
});
