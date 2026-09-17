ready: 0 blocking/high

# Review: RFC-06 hcn --resume-last across harnesses (draft-04, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`
  - Frontmatter: `revision: 04`, `status: Draft`, `type: feature`, `date: 2026-09-17`.
  - 1085 lines. The file is untracked.
- **SHA-256:** `4bcfcceeeb52e33f1ee2453e25214c9ae8e37dd68d9ea8fd58a4aa8617ab7ae3`. Line numbers below refer to this file.
- **Base commit:** `f5e2a2695065d4106490745e9be8b2181fdbfc1c` on `feat/cursor-harness`. RFC-05 phases 1-2 are committed there (`ed8eb7b`, `f5e2a26`), including `src/knowledge/cursor.ts`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), effort high. One pass, no delegation. This is a cross-family review of an RFC written by a Meta Muse model.
- **Inputs used:**
  - the RFC
  - review draft-03
  - the owner answers file
  - `evidence.md`, including the draft-04 appendix
  - raw captures for probes 60-67: argv, exit, stderr, and file birth and mtime
  - per-record `type`, `subtype`, and `session_id`/`thread_id` fields from those stdout captures
  - result text checked only by `grep -c` for the marker words
  - probe argv files 03, 12, 16b, and 34
  - hcn source at every cited line
  - ADR 0007 and CONTEXT.md headings
  - RFC-05 frontmatter and its "not reachable" sentence
  - `test/fixtures/phase13-codex-sandbox-resume/README.md`
- **Store reads:** metadata only. I listed the `ws-fork-claude` project directory (it holds only `memory`), checked `~/.claude/session-env` for the six draft-04 ids (none present), and checked `~/.codex/sessions/2026/09/17/` for `01a0ad26` (not present).
- **Not read:** transcript content, hook record content, Cursor shipped code. No harness CLI or pnpm was run.

## Structural results

Command:

```
npx tsx ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md
```

Output, verbatim:

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Evidence grades

- **Rung 1:** the RFC's or the evidence author's claim, not checked.
- **Rung 2:** consistent with docs or comments, or reasoning from them.
- **Rung 3:** traced through hcn code.
- **Rung 4:** observed in a raw capture, a capture time, or store metadata.

## Draft-03 findings resolution table

| Finding | Status | Basis |
| --- | --- | --- |
| B1 killed-turn "silent create" misread | Resolved | Table rows restored (lines 584-590). Stranger table added (592-597). Warning clause rewritten (643-657). Signal meaning rewritten (611-614). OQ5 resolved as (a) (1012-1017). Terminology corrected (336). Evidence correction note added. One leftover citation is in L2. |
| H1 parent-session policy re-ask | Resolved by owner answer (b) | Fork rendering is in the grammar table (443), the descriptor (393-423), the safety policy (569-574), and Resolved Q3 (995-1008). The consequence text overclaims (M1). The gate evidence cannot be rechecked (M4). |
| M1 claude and pi roots | Resolved | Lines 661-666 and 875-886 match `transcript.ts:76-91`: `CLAUDE_CONFIG_DIR` plus `projects`, `PI_CODING_AGENT_DIR` plus `sessions` and the `--slug--` form. Codex is excluded for lack of a cwd slug. |
| M2 before-prompt override enforcement | Resolved, with a caveat | Probe 64 opens thread `01a0ad26-323a`, whose UUIDv7 time 02:15:56Z matches the argv at 09:15:56 local. Probe 65 resumes the same id. The result says "read-only sandbox", and stderr says `patch rejected: writing is blocked by read-only sandbox`. Both exit 0. The inference sentence overclaims (L3). |
| M3 hook rule | Resolved in the RFC | The fixture rule is now "hook records excluded" (lines 340, 817-825). Record counts: probe 60 has 4/4 hook records, 61 has 3/3, 62 has 4/4, 63 has 3/3, 67 has 6/6, and 66 has 0. `evidence.md` still carries the old claim (L4). |
| L1 identity before auth failure | Resolved | State machine lines 724-732 and Native failures line 759. Probe 66 repeats the shape under fork: init `8a287624`, then result `is_error: true` with "Not logged in", exit 1. |
| L2 store evidence retention | Resolved in text; the same problem recurs | The draft-04 appendix lists stores and records deletion at 09:18:27. That deletion came before this review, so the fork gate evidence cannot be rechecked either (M4). |
| L3 probe-05 pi file cause | Resolved | The appendix states that the safety record deleted only the capture. The cause stays unverified, stated plainly. |
| L4 RFC-05 anchor and line numbers | Resolved; new drift from `f5e2a26` | RFC-05 is cited as revision 09, Accepted (102-103). `descriptor.ts:538` is correct. New drift is in L1. |
| OQ assessment | Resolved | OQ5 (a) restated. OQ6 (a) with the stranger limit stated (670-671, 885-886). OQ7 (a) scoped to the true empty-cwd case (1024-1028). Q3 re-asked as (b). No open questions remain. |

## Findings

### M1 (medium). The fork consequences are overstated: "designed out", "fork chains never accumulate", and "resumed most-recent" do not describe what `--fork-session` does

- **Where:**
  - Abstract (37-40)
  - Terminology "Stranger" (335) and "Parent-session hazard" (341)
  - Safety policy item 1 (569-573)
  - signal item 3, render line (623-624)
  - Blast radius (800-806)
  - revision record item 2 (283-291)
- **What is wrong:**
  - **The parent-session hazard is only partly designed out.** Draft-03 H1 listed three consequences:
    - the delegate's turn lands in the parent's history;
    - two processes write one file;
    - the delegate model receives the parent's full context.
    Fork removes the first two. The third remains, because a fork continues history by design. The claude warning text (643-646) now has no parent clause, per the owner answer. The RFC body should still say the child inherits the live parent's saved history, not that the hazard is "designed out".
  - **"The next `--resume-last` then picks the fork, so fork chains never accumulate" is wrong on both halves.**
    - Every claude resume-last turn creates a new session file. Probes 61, 63, 66, and 67 each announced a new id (`b53231f6`, `0d70a736`, `8a287624`, `f1d1b62e`), and the appendix listing shows six transcript files in one cwd.
    - The next run picks the fork only when nothing else in the cwd wrote since. A live parent writes its transcript when the delegate returns, so a delegate's next `--resume-last` forks the parent again, not its own previous fork. That is the stranger race, not a fork property. The sentence states it as a guarantee.
  - **The render line `resumed most-recent <id>` names an id that was never resumed on claude.** It is the fork id. The source id is reported nowhere, so a consumer cannot tell which session was forked. Probe 67 forked the failed session `8a287624`, and nothing in its stream says so.
  - **"Delegate turn in the interactive history" (802-803) was not observed.** Parent probes 47 and 62 are headless `claude -p`. An interactive parent is unprobed.
  - **Probe 63 does not show that the child continued the running parent's history.**
    - The prompt was PONG, and the result contains no marker.
    - The parent was mid-generation of a second message: record 4227 starts a new `message_start` after `message_stop` at 4223, and the capture ends at 7021 with no result.
    - The claim rests on probe 61 alone, whose source was not running.
- **Required:**
  - Replace "designed out" with "the write into the parent file is designed out; the child still starts from the parent's saved history."
  - Drop "fork chains never accumulate". State that each claude resume-last turn adds one session file, and that the next run picks the fork only if no other run in the cwd wrote since.
  - Render a claude-accurate line, for example `forked most-recent session as <id>`, or state that the field never carries the source id.
  - Drop the word "interactive" from the blast radius, or mark it unobserved.
- **Rung:** 4 for ids, record order, and capture times. 1 for the file count, which rests on the deleted listing. 2 for the history-inheritance and write-timing reasoning.

### M2 (medium). The claude no-session and stranger rows are pinned from probes that never rendered `--fork-session`

- **Where:**
  - No-session table claude row (586)
  - Stranger table claude row (594)
  - Terminology "Silent create" (336)
  - claude warning text "claude starts a fresh session with exit 0 when no session is resumable" (645-646)
  - State machine (716-719, 733-735)
- **What is wrong:**
  - Only probes 61, 63, 66, and 67 carry `--fork-session` (checked with `grep -l` over every argv).
  - The claude no-session evidence (03 `claude -p --output-format json --continue "hello"`, 16b) and the stranger evidence (12, 33-34) all ran without it.
  - The rendered grammar with no prior session in the cwd is therefore unobserved. Yet the warning text is pinned verbatim on that shape.
  - The stranger row says "resumes that run's own session". Under the rendered grammar, the harness forks that run's session under a new id. Probe 67 is the one fork-stranger observation (source `8a287624`, a failed auth run, new id `f1d1b62e`, no recall), and the table does not cite it.
- **Required:**
  - Mark the claude no-session row "observed without `--fork-session`; the rendered pair is unverified".
  - Rewrite the claude stranger row to "forks that run's session under a new id", citing 67.
  - Add the claude no-session case with the fork pair to the Phase 4 matrix. Add a stop rule: if the shape differs, the pinned warning text and the table change before release.
- **Rung:** 4.

### M3 (medium). `inspect --context --resume-last` renders `--fork-session` twice, and the descriptor gains a second field holding the same native fact

- **Where:** Descriptor data (395-402), planTurn routing site list (500-506), Phase 1 and Phase 2.
- **What is wrong:**
  - `context-inspection.ts:23-27` returns the output of `buildSpawnArgv(...)`, then `contextInspection.flags`, then `contextInspection.forkFlag` when `options.resume !== undefined`.
  - The RFC puts the resume-last discriminant on line 26. It also has the resume-last builder always render `resumeLast.forkFlag` inside `buildSpawnArgv`.
  - The result is `claude -p --continue --fork-session ... --no-session-persistence --replay-user-messages --fork-session`. That argv spawns a real claude process, and no probe covers it. The RFC text says the path "renders `--continue --fork-session`", which reads as one occurrence.
  - `claude-code.ts:163` (`contextInspection.forkFlag: "--fork-session"`) and the new `resumeLast.forkFlag: "--fork-session"` would be two descriptor copies of one claude flag.
  - `claude-code.ts:46-48` (A-005) says forking is "only the explicit --fork-session flag (deliberate branching, never a default)". This RFC makes it the default on one path. The RFC does not list that comment for rewriting.
- **Required:**
  - Specify that context inspection does not append its fork flag when the resume-last render already carries one, and add a corpus row for the result.
  - Or hold the flag once, for example on `resume`, and have both consumers read it.
  - Name the A-005 comment in Phase 1 as rewritten.
- **Rung:** 3.

### M4 (medium). The Resolved Q3 release gate is declared satisfied by probes whose deciding evidence was deleted, whose argv is not the builder's, and which Phase 4 re-runs anyway

- **Where:** Resolved Q3 (1000-1003: "probes 60-63 satisfy it"), planTurn routing (504-506), Phase 4 (952-955), grammar table claude evidence (443).
- **What is wrong:**
  - **"Parent file untouched" (probe 63) rests only on the appendix listing.**
    - The listing: parent `f836654d` mtime 09:14:15, child `0d70a736` born 09:15:30.
    - The stores were deleted at 09:18:27, before this review. I confirmed the directory holds only `memory` and that no session-env entry remains.
    - What the captures do show:
      - the child's stream carries one id, `0d70a736`, on every record, different from the parent's `f836654d`;
      - the parent stdout mtime is 09:15:37, after the child's exit at 09:15:32, so the runs overlapped.
    - The method is sound. A child append would have moved the parent mtime to 09:15:30 or later, because the parent was mid-message and could not itself write. But the one fact that decides the gate cannot be rechecked.
    - Probe 62 also has no `.exit` file.
  - **The argv is not the builder's.** Probes 61 and 63 carry `--setting-sources project` and `--allowedTools=`, which the builder does not render.
  - **The text contradicts itself.** Resolved Q3 says the gate is satisfied. Phase 4 says the pair in builder order is still the gate, with a stop rule.
- **Required:**
  - Make Phase 4 the gate of record: argv taken from `hcn inspect --argv` on the built binary, overlap with a running parent, and a recall marker planted in the parent.
  - Retain store metadata (per-file mtime, size, and the set of ids) until the review of that run.
  - Reword Resolved Q3 to "probes 60-63 show the pair is accepted; the gate runs in Phase 4."
- **Rung:** 4 for the capture ids and times and for the deletion. 1 for the listing.

### L1 (low). Line drift after `f5e2a26`

- **Where:** lines 498, 517, 530, 536.
- **What is wrong:**
  - The profile gate is `plan-turn.ts:299` (cited as 298).
  - The native-approvals dispatch is `:343-344` (cited as 342-343).
  - The env phase is `:397` (cited as 396).
  - `RefusalOption` is `refusal.ts:35` (cited as 34).
  - The issue switch is `refusal.ts:74` (cited as 73).
  - Phase 5 (971) says `2026.09.10-fd3934a` is "in the working tree". `cursor.ts:144` is committed in `ed8eb7b`.
  - "RFC-05 MUST land first" (102) does not say whether landing means the feature branch or main. Phase 1 already depends on the committed `cursor.ts:705`.
- **Rung:** 4.

### L2 (low). Probe 40 is still cited as evidence for silent-create defaults

- **Where:** lines 463-467, 599-603, 790-792.
- **What is wrong:**
  - The text reads "a silently created session runs with native defaults ... probe 17b (fresh thread) and probe 40 (resumed thread)".
  - After B1, probe 40 is a resume of probe 39's thread. It shows harness-side state on a resumed thread. It is not evidence about fresh sessions.
  - No line still claims that a killed turn creates a fresh session. This citation is the only residue.
- **Required:** Cite 17b alone for the fresh case, or move 40 to a separate sentence about harness-side memory.
- **Rung:** 4.

### L3 (low). The 64-65 inference skips the resume default

- **Where:** grammar table codex row (444), evidence M2 appendix.
- **What is wrong:**
  - "The thread's own recorded sandbox was workspace-write, so the block comes from the resume-turn override" assumes resume restores the recorded sandbox.
  - If `exec resume` ignores it and falls back to codex's read-only exec default, 65 blocks without the override too.
  - The same-thread control exists: probe 11b (a workspace-write override on `--last` writes) and `test/fixtures/phase13-codex-sandbox-resume/` (0.147.0, three settings on one thread).
- **Required:** Cite those as the control, or add a no-override resume write to Phase 4.
- **Rung:** 4 for the captures. 2 for the fixture README.

### L4 (low). `evidence.md` still says probes 47-48 carry zero hook records

- **Where:** `evidence.md` lines 270-272.
- **What is wrong:** The line reads "probes 30-34, 47-48 carry zero `hook_response` records (count-checked)". Probe 47 has 4 `hook_response` records. The RFC is corrected. The evidence file, which is the normative anchor until Phase 4, is not.
- **Rung:** 4.

### L5 (low). The scope test does not label the fork render

- **Where:** Fit check item 3 (121-128), AGENTS.md scope test (136-146).
- **What is wrong:**
  - Both sections still describe the flag as "deciding nothing" and label only the warning as supervising.
  - Rendering `--fork-session` on claude alone is a choice hcn makes: it changes session semantics against the plain native `--continue`.
  - It passes ADR 0007:
    - it is a render choice within one spawned process;
    - it stores no cross-process state;
    - it forwards a native mechanism rather than building one, which fits the AGENTS.md habit.
  - Under CONTEXT.md's definitions ("a supervising part decides"), it is policy, not normalization. The RFC says the CONTEXT.md entry "is what makes the claim checkable", so the label matters.
- **Required:** Label the claude fork render as supervising policy beside the warning, and include it in the CONTEXT.md entry.
- **Rung:** 2.

## Cleared

- **Validator:** passed.
- **Identity under fork.** Every record in probes 61, 63, 66, and 67, hook records included, carries one `session_id`, and it is the new fork id. The first announce the decoder sees is the fork id, which matches line 614. The source ids differ (`2ae15289` for 60, `f836654d` for 62).
- **Probe 61.** Exit 0. Result contains JUNIPER-6 (count 1). New id `b53231f6`. Capture window 09:11:57-09:12:02, consistent with the listed birth at 09:12:00. The listed plant mtime of 09:11:48 equals probe 60's exit time.
- **Probe 63 overlap.** Child window 09:15:28-09:15:32. Parent stdout written until 09:15:37. The parent capture has 7021 lines and no result record. The child result contains PONG.
- **Probes 66 and 67.** 66: exit 1, 3 tools, 0 hook records, "Not logged in". 67: exit 0, 6/6 hook records plus 1 `hook_progress`, no JUNIPER-6, 62 tools.
- **Probes 64 and 65.** Both exit 0 on the same thread `01a0ad26`, and 65 ends in the read-only denial.
- **`forkFlag` as a data field** keeps the builder free of harness-name branches. Only claude is non-null. The shape is consistent across the grammar table, the descriptor section, and Phases 1-2 (apart from M3's duplication).
- **Stranger table for codex and pi, the cursor unprobed row, the M1 root resolution, the L1 state machine path, and the OQ5-OQ7 resolutions** all match the owner answers.
- **No line still claims a silent create after a killed turn** (checked with grep for killed, crash, poison, and silent). The draft-03 revision record keeps its historical text, and the draft-04 record withdraws it.
- **Cited lines that hold:**
  - `descriptor.ts:536-538`, `muse.ts:88`, `cursor.ts:705`, `claude-code.ts:194`
  - `argv.ts:132`, `:182`, `:242`, `:268`
  - `stream-turn.ts:97`, `:128`, `:231`, `:245-252`
  - `decode.ts:127-139`, `:150`
  - `native-approval-turn.ts:336`, `events.ts:47`
  - `args.ts:214-225`, `inspect-native-settings.ts:15`
  - `transcript.ts:76-91`, `resume-guard.ts:22-28`
  - `parse-resume.ts:24-25`, `:79-91`
  - `help.ts:21`, `:110`
  - `run.ts:40-57`, `session.ts:207-225`
  - `turn-options.ts:66-72`
- **Scope.** The option and the fork render pass ADR 0007 (one process, nothing across process boundaries), with the labeling fix in L5.

## Not reviewed

- Transcript and hook record content. Only ids, record types, counts, and marker-word counts were read.
- The store state behind the draft-03 and draft-04 appendix listings. Both stores were deleted before this review.
- An interactive (TUI) parent, and codex, pi, or cursor parent-session behavior.
- Claude's behavior on a duplicated `--fork-session` (M3), and `--continue --fork-session` with no prior session (M2). Neither was run.
- The hcn skill source and `check-claims`.
- RFC-05 beyond its frontmatter and the "not reachable" sentence.
- Live behavior. No harness was run.
