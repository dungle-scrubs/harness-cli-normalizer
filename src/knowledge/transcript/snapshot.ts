import { deepFreeze } from "../descriptor.js";
import type { Evidence } from "./schema.js";

export const TRANSCRIPT_SNAPSHOT = deepFreeze({
  consistency: "snapshot" as const,
  acquisitionTimeoutMs: 5000,
  cleanupTimeoutMs: 1000,
});

export const SNAPSHOT_EVIDENCE: Evidence = deepFreeze({
  appliesTo: {
    formatId: null,
    formatVersions: [],
    readerBuilds: [],
    writerBuilds: [],
    scope:
      "One regular file cloned with macOS fclonefileat or Linux FICLONE on compatible storage; no ordinary-copy fallback and no native multi-write transaction claim.",
  },
  reference: "docs/transcript-snapshot.md",
  standing: "documented",
});
