import { deepFreeze } from "../descriptor.js";
import type { Evidence } from "./schema.js";
import { unverifiedTranscriptKnowledge } from "./unverified.js";
import type { TranscriptKnowledge } from "./wire.js";

const evidence: Evidence = {
  appliesTo: {
    formatId: null,
    formatVersions: [],
    readerBuilds: [{ buildId: "b934305d21", version: "1.1.1" }],
    writerBuilds: [],
    scope:
      "Muse 1.1.1-R2514.1 offline export of synthetic session envelopes; no native writer or concurrent-source guarantee was verified.",
  },
  reference: "docs/transcript-evidence.md#muse-111",
  standing: "observed",
};

export const MUSE_TRANSCRIPT: TranscriptKnowledge = deepFreeze(
  unverifiedTranscriptKnowledge(
    "Muse 1.1.1 export preserves unknown envelopes but rounds some decimal values and exits 0 for malformed or unidentified input. A verified HCN adapter still needs exact-value, identity, source-assembly, consistency and complete passive-lifecycle checks. Retrieval remains disabled. Inspect evidence with hcn inspect muse --transcript.",
    [evidence],
  ),
);
