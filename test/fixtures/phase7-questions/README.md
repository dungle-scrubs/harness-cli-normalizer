# Phase 7 question-escalation probes (issue #41)

Grounding rule from repo history: run one live probe per harness with the
preamble in the prompt BEFORE coding the detector, and keep the evidence.
Captured 2026-09-24 on Kevins-MacBook-Air (claude 2.1.235, codex-cli
0.146.1, pi 0.84.2, muse 0.2.1).

Prompt: `ask-probe-prompt.md` - the ESCALATION_PREAMBLE verbatim plus a
genuine-decision task (deploy-target.txt: staging vs production,
mutually exclusive, no evidence in tree, not recoverable).

Raw hcn event streams: `ask-<harness>.ndjson` (pre-feature hcn; the
question event did not exist yet - the interesting content is the final
assistant message). All four exited 0, cause clean.

Findings, one per harness:

1. claude: final message ends with a fenced hcn-question block, JSON
   well-formed, fields question/options/recommended as specified. Prose
   precedes the block; nothing follows it.
2. codex: final message is the bare fenced block, JSON well-formed,
   compact (no spaces) separators. Block-only final message is fine.
3. pi: same shape as claude - reasoning prose then the block, last
   content of the final message.
4. muse: same shape as codex - block only.

Detector requirements derived from the evidence:

- Detection must run on the COMPLETE final assistant message text
  (content.ts message events), not on token deltas.
- Fence matching must tolerate indentation before the opener and
  arbitrary JSON formatting inside the body.
- The block is the LAST fenced hcn-question block in the text (last
   wins); JSON must parse with all three fields shape-valid.
- Malformed blocks surface as error events (worker tried to ask but
  botched the shape), never silently ignored.

Resume path (id continuity per harness) verified live in the phase 7
e2e scenario `question-roundtrip`; see scripts/e2e.ts.
