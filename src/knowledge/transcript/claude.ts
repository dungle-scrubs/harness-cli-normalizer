import { deepFreeze } from "../descriptor.js";
import type { Evidence } from "./schema.js";
import { unverifiedTranscriptKnowledge } from "./unverified.js";
import type { TranscriptKnowledge } from "./wire.js";

const evidence: Evidence = {
  appliesTo: {
    formatId: null,
    formatVersions: [],
    readerBuilds: [{ buildId: null, version: "0.3.233" }],
    writerBuilds: [{ buildId: null, version: "2.1.233" }],
    scope:
      "Claude 2.1.233 embedded persistence implementation and matched Agent SDK 0.3.233 source/probes. No full-source snapshot or passive HCN adapter is established.",
  },
  reference: "docs/transcript-evidence.md#claude-21233",
  standing: "documented",
};

export const CLAUDE_TRANSCRIPT: TranscriptKnowledge = deepFreeze(
  unverifiedTranscriptKnowledge(
    "Claude 2.1.233 supports in-place transcript truncation and rewriting as well as alternate storage backends. Agent SDK 0.3.233 returns a filtered branch projection and skips some malformed or pre-compaction data. Native source assembly and a consistency rule covering these writes remain unverified; retrieval is disabled. Inspect evidence with hcn inspect claude --transcript.",
    [evidence],
  ),
);
