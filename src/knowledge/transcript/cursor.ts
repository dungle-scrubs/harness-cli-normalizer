import { deepFreeze } from "../descriptor.js";
import type { CapabilityMap, Evidence } from "./schema.js";
import { TRANSCRIPT_CAPABILITIES } from "./schema.js";
import { SNAPSHOT_EVIDENCE, TRANSCRIPT_SNAPSHOT } from "./snapshot.js";
import type { Method, TranscriptKnowledge } from "./wire.js";

export const CURSOR_NATIVE_EVIDENCE: Evidence = {
  appliesTo: {
    formatId: "cursor-chat-store-v1",
    formatVersions: [],
    readerBuilds: [],
    writerBuilds: [{ buildId: "d2fe57e", version: "2026.09.15" }],
    scope:
      "Cursor CLI 2026.09.15-d2fe57e chats/<md5-of-cwd>/<agent-id>/store.db SQLite stores observed on local headless runs: a blobs table of SHA-256-addressed blobs and a meta table whose hex JSON names the agent ID and latest root blob. The root blob's protobuf field 1 lists message blob IDs in order; message blobs are AI SDK message JSON. Every earlier root observed was a prefix of the latest root.",
  },
  reference: "docs/transcript-evidence.md#cursor-20260915-d2fe57e",
  standing: "observed",
};

export const CURSOR_TRANSCRIPT_EVIDENCE: Evidence = deepFreeze({
  ...CURSOR_NATIVE_EVIDENCE,
  appliesTo: {
    ...CURSOR_NATIVE_EVIDENCE.appliesTo,
    writerBuilds: [],
    scope:
      "Checkpointed Cursor chat stores with the observed two-table schema, one agent ID and a latest root whose message list extends every earlier root. Compatibility is conditional on these format semantics, not a writer version label. Unknown message fields and part types remain opaque; clone consistency is independent of native write scheduling.",
  },
});

const definitions = [
  [
    "cursor-local-resolution-v1",
    "resolution",
    "An explicit store.db supplies its agent ID from the meta table. ID lookup scans chats/*/<id>/store.db below CURSOR_CONFIG_DIR, XDG_CONFIG_HOME/cursor or ~/.cursor, rejects multiple matches and validates the embedded agent ID.",
  ],
  [
    "cursor-chat-store-v1",
    "compatibility",
    "Read the SQLite image with HCN's pure page reader: UTF-8 encoding, the exact blobs and meta table schemas, one meta row with a hex JSON agentId and latestRootBlobId, every blob's SHA-256 equal to its ID, and root blobs whose field-1 references all resolve to JSON message objects with a role. Reject duplicate JSON keys. Preserve unknown fields; never emit the meta blobEncryptionKey.",
  ],
  [
    "cursor-snapshot-v1",
    "consistency",
    "Require store.db-wal and store.db-journal to be absent or empty before the clone and after the read, so the main file holds every committed write. Clone one regular source through macOS fclonefileat or Linux FICLONE, with no ordinary-copy fallback. A checkpoint that starts and ends inside the clone window is not excluded by these checks; blob hash verification and reference resolution reject a view that mixes page versions. The sibling checks follow the resolved source path. See docs/transcript-snapshot.md.",
  ],
  [
    "cursor-passive-v1",
    "passivity",
    "HCN's bounded clone helper opens the native source read-only and creates only a private in-call clone. No SQLite engine opens the store, so no checkpoint, recovery or lock can touch it. It never starts Cursor, loads native configuration, resumes, migrates or repairs history. Close resources and remove temporary files on every handled exit.",
  ],
  [
    "cursor-order-v1",
    "ordering",
    "Return messages in latest-root order. Every other non-message blob that parses as a root must be a prefix of that order with resolvable references; any other earlier root fails the read instead of being merged or dropped. The same message blob can occur more than once. Positions are byte offsets in HCN's projected view, which stays stable while the prefix does.",
  ],
  [
    "cursor-normalization-v1",
    "normalization",
    "Preserve exact JSON values. Normalize AI SDK roles and text, reasoning, redacted-reasoning, tool-call, tool-result, image and file parts; redacted reasoning is retained but not included as text. Tool call IDs link calls and results. Messages carry no timestamps.",
  ],
  [
    "cursor-continuation-v1",
    "continuation",
    "Bookmarks bind the method, agent ID, complete entry count, projected byte boundary and SHA-256 of the full committed projected prefix. Revalidate against a new snapshot. Any prior-prefix change requires a fresh read; no silent restart.",
  ],
] as const;
const rules = deepFreeze(
  definitions.map(([id, purpose, description]) => ({
    appliesTo: CURSOR_TRANSCRIPT_EVIDENCE.appliesTo,
    description,
    evidence:
      purpose === "consistency" || purpose === "passivity"
        ? [SNAPSHOT_EVIDENCE, CURSOR_NATIVE_EVIDENCE]
        : [CURSOR_TRANSCRIPT_EVIDENCE, CURSOR_NATIVE_EVIDENCE],
    id,
    purpose,
  })),
);
const capabilities = deepFreeze(
  Object.fromEntries(
    TRANSCRIPT_CAPABILITIES.map((key) => [
      key,
      {
        evidence: [CURSOR_TRANSCRIPT_EVIDENCE, CURSOR_NATIVE_EVIDENCE],
        prerequisiteRuleIds: ["cursor-chat-store-v1", "cursor-snapshot-v1", "cursor-order-v1"],
        reason:
          key === "active-branch"
            ? "The store records one message order and no branch selection."
            : key === "record-identity"
              ? "Blob IDs address message content; a repeated identical message shares one ID, so source positions identify occurrences."
              : "All messages of the latest root, which extends every earlier root in the store, under its format and snapshot rules.",
        status:
          key === "active-branch" ? "unknown" : key === "record-identity" ? "limited" : "available",
      },
    ]),
  ) as unknown as CapabilityMap,
);
export const CURSOR_TRANSCRIPT_METHOD: Method = deepFreeze({
  bookmarkCompatibility: [],
  capabilities,
  cleanupTimeoutMs: TRANSCRIPT_SNAPSHOT.cleanupTimeoutMs,
  formatIds: ["cursor-chat-store-v1"],
  id: "cursor-store-v1",
  identityKinds: ["native-id", "source-position"],
  idResolutionRuleId: "cursor-local-resolution-v1",
  incrementalStrategy: "revalidate-prefix",
  passivity: {
    evidence: [CURSOR_TRANSCRIPT_EVIDENCE, CURSOR_NATIVE_EVIDENCE],
    prerequisiteRuleIds: ["cursor-passive-v1"],
    reason:
      "Read-only native source plus a bounded HCN filesystem clone helper and a pure page reader; no native harness or SQLite lifecycle.",
    status: "available",
  },
  preference: 0,
  ruleIds: rules.map((rule) => rule.id),
  selectors: ["id", "file"],
  transport: "file",
});
export const CURSOR_TRANSCRIPT: TranscriptKnowledge = deepFreeze({
  capabilities,
  methods: [CURSOR_TRANSCRIPT_METHOD],
  rules,
  sourceFormats: [
    {
      id: "cursor-chat-store-v1",
      versions: [],
      description: CURSOR_TRANSCRIPT_EVIDENCE.appliesTo.scope,
      evidence: [CURSOR_TRANSCRIPT_EVIDENCE, CURSOR_NATIVE_EVIDENCE],
    },
  ],
});
