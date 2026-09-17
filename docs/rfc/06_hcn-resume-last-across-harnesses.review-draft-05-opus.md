ready: 0 blocking/high

# Review: RFC-06 hcn --resume-last across harnesses (revision 05, opus confirmation reviewer)

## What was reviewed

- **RFC:** `/Users/kevin/dev/harness-cli-normalizer/docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`. Frontmatter: `revision: 05`, `status: Draft`. 1225 lines. The file is untracked.
- **SHA-256:** `a5163087a15c6dd2c86bc6f4023ad5bc34ca8914d54bdc629372c05fa0f07fed`. Line numbers below refer to this file.
- **Base:** HEAD `f5e2a2695065d4106490745e9be8b2181fdbfc1c` on `feat/cursor-harness`, plus uncommitted RFC-05 Phase 3 edits in the working tree.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), effort high. One pass, no delegation. This is a cross-family confirmation of a revision written by a Meta Muse model.
- **Inputs:**
  - review draft-04
  - the owner answers file
  - `evidence.md`, lines 270-273 and 400-412 only
  - `src/interpretation/context-inspection.ts`, `src/interpretation/argv.ts:129-289`, and `src/cli/inspect-context.ts:1-70`
  - `src/cli/plan-turn.ts:290-380`
  - the cited descriptor lines
  - a grep of every `resume === undefined` or `resume !== undefined` site under `src/`
- **Not read or run:** transcripts, hook content, Cursor shipped code, any harness CLI, pnpm.

## Structural results

Command: `npx tsx ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Draft-04 resolution table

| Finding | Status | Basis |
| --- | --- | --- |
| M1: fork consequences overstated | Resolved | All four Required edits are in. (1) "The write into the parent file is designed out; the child still starts from the parent's saved history": Abstract 41-44, Terminology 415, Safety 670-672, Blast radius 914-916. (2) "Fork chains never accumulate" is gone. The one-file-per-turn sentence is at 672-676 and 920-922. (3) The render line is `forked most-recent session as <id>`, and the text says no field carries the source id (728-732). (4) "Interactive" is gone from Blast radius 917. One small leftover is in L4. |
| M2: claude rows pinned from probes without the fork flag | Resolved | The no-session row is marked unverified (689). The stranger row reads "forks that run's session under a new id" and cites 67 (697). The Silent create term is qualified (410). The warning text has a stop rule (754-757). The Phase 4 gate has a stop rule (1088-1090). The state machine is updated (828-832). |
| M3: duplicate `--fork-session` and a second descriptor copy | Resolved | The flag is held once on `contextInspection.forkFlag` (474-485). `resumeLast` is `{flag, headless}` (469). Context inspection does not append when the resume-last render already carries the flag (594-597). A corpus row pins exactly one flag (1046-1048). A-005 is named for rewrite in Phase 1 (1022-1024). The trace below confirms one flag. Two follow-ups are in L1 and L2. |
| M4: Q3 gate declared met on deleted evidence | Resolved | Phase 4 is the gate of record. It takes argv from `hcn inspect --argv`, runs against a live parent holding a planted marker, and retains store metadata (1080-1087). Resolved Q3 reads "show the pair is accepted; the gate runs in Phase 4" (1138-1143). The grammar table flags the extra flags the builder does not render and marks the deleted-listing fact rung 1 (528). |
| L1: line drift | Resolved | See the spot-check. Two citations have drifted again because of concurrent edits. Judged by symbol, both hold. |
| L2: probe 40 cited for fresh-session defaults | Resolved | Lines 549-552, 702-707, and 904-906 cite 17b for the fresh case and treat 40 separately. |
| L3: 64-65 inference skips the resume default | Resolved | The controls, probe 11b and the phase13 fixture, are cited (529). A no-override write joins Phase 4 with a restate rule (1077-1079). |
| L4: `evidence.md` hook-count claim | Resolved | `evidence.md:272-273` says probes 30-34 carry zero `hook_response` records and probe 47 carries 4. |
| L5: fork render not labeled | Resolved | The fork render is labeled supervising policy in the Fit check (130-136), the scope test (146-151), the CONTEXT.md entry (794-797), and Phase 3 (1067-1068). |

### M3 trace (render yields exactly one `--fork-session`)

**`hcn run claude --resume-last`**
- `planTurn` calls `buildSpawnArgv` (`plan-turn.ts:375`). With `resumeLast: true`, that routes to the new resume-last builder.
- Per 478-480 and 1035-1036, the builder renders `bin, extraFlags (-p), --continue, h.contextInspection?.forkFlag`, then `turnTail`.
- That is one `--fork-session`, and it matches the grammar table row at 528.
- Nothing else on the run path appends a fork flag. `grep forkFlag` over `src` and `test` finds only `claude-code.ts:163`, `descriptor.ts:526`, and `context-inspection.ts:26`.

**`hcn inspect claude --context --resume-last`**
- `inspect-context.ts` takes `options` from `planTurn` and calls `buildContextInspectionArgv(harness, options)`.
- That function builds `buildSpawnArgv({...options, prompt: ""})`, which is the resume-last render with one `--fork-session`.
- It then appends `contextInspection.flags`: `--input-format stream-json --no-session-persistence --replay-user-messages`.
- It then appends line 26. Under the RFC's skip rule, line 26 appends nothing when the resume-last render already carries the flag.
- Result: one `--fork-session`, placed after `--continue` and before the prompt.

**Existing `--resume <id>` context inspection is unchanged**
- `resumeArgv` (`argv.ts:224-247`) does not change and renders no fork flag.
- `contextInspection` in `claude-code.ts:160-164` does not change.
- On the id path, `options.resume` is defined and `resumeLast` is absent, so line 26 still appends `--fork-session` at the end, as today.
- `assertContextInspectionOptions` refuses passthrough, so an argv-scan version of the skip rule cannot see a `--fork-session` supplied by the caller either.
- The argv is byte-identical to today. This holds only if the skip rule keys on `resumeLast` or on the rendered argv, which L2 asks the RFC to state.

### Spot-check of cited lines (judged by symbol)

| Citation | Result |
| --- | --- |
| `plan-turn.ts:300` (`if (extra.resume === undefined)` before `resolveEffectiveOptions`) | Holds (working tree) |
| `plan-turn.ts:372-373` (`if (options.nativeApprovals)` into `nativeApprovalPlan`) | Holds |
| `plan-turn.ts:426` (env phase in `writePlanDiagnostics`) | Holds |
| `refusal.ts:35` (`export type RefusalOption`), `:74` (`switch (issue)`) | Holds |
| `stream-turn.ts:236` (`turnEnv`), `:254` (`resumeOnMissingCreate`) | Holds |
| `claude-code.ts:46-48` (A-005), `:163` (`forkFlag`), `:165` (`resumeLast: null`); `descriptor.ts:526`, `:538` | Holds |
| `codex.ts:99`, `pi.ts:122`, `muse.ts:88`, `cursor.ts:705` | Holds |
| `stream-turn.ts:97` (`TurnRunOptions`), `:128` (native-approvals dispatch) | Now 102 and 133. These are HEAD values mixed with working-tree values. The symbols hold. |
| `transcript.ts:76-91` (claude and pi roots) | Holds at HEAD. The working tree shifted it to about 108-122, because RFC-05 Phase 3 edits `transcript.ts`. The symbols hold. |

## New findings

### L1 (low). The resume-last fork depends on a nullable field that belongs to another capability

- **Where:** Descriptor data (474-485), grammar table claude row (528: "always on this path"), Phase 1 tests (1026-1030).
- **What is wrong:**
  - `descriptor.ts:522-528` documents `contextInspection` as "Disposable native context accounting ... Null is unknown support".
  - Its only `kind` is `"claude-control-v1"`, and its `forkFlag` is not optional.
  - Resume-last now reads `h.contextInspection?.forkFlag`. This ties two separate facts together.
  - **Case 1:** a future claude re-verification sets `contextInspection: null` because the control adapter is unverified. That is a normal outcome under its own comment. Resume-last would then quietly stop forking and bring back the two-writer hazard seen in probes 47-48.
  - **Case 2:** a harness that gains context inspection would start forking on resume-last with no probe. The warning texts at 758-768 would then be wrong.
  - The byte-for-byte corpus row catches Case 1 for claude, so this is low. But the Phase 1 test as written ("reads the single `contextInspection.forkFlag`") passes when the field is null.
- **Required:**
  - Add the second consumer to the `contextInspection` doc comment in Phase 1.
  - Pin in `descriptor-consumers.test.ts` that claude's resume-last render contains `--fork-session`, with a failure message that names Resolved Question 3.
  - Pin that the other harnesses render no fork flag.
- **Rung:** 3.

### L2 (low). The context-inspection site is listed as gaining the discriminant, and the skip rule then cancels it

- **Where:** planTurn routing (577-597), Phase 2 (1036-1039: "the five `resume === undefined` sites gaining the discriminant").
- **What is wrong:**
  - `context-inspection.ts:26` is listed as a site that gains "resume semantics when `resume !== undefined OR resumeLast === true`". That rule would append a second `--fork-session`.
  - The same bullet then skips the append "when the resume-last render already carries the fork flag".
  - The final condition is today's condition, `options.resume !== undefined`. The RFC never says so.
  - The trigger is also unstated: a key on `resumeLast`, or a scan of the rendered argv.
  - An implementer who applies the five-site rule literally gets the duplicate until the corpus row fails.
- **Required:**
  - State the final line-26 condition explicitly: append only when `options.resume !== undefined`, unchanged, because the resume-last builder already renders the flag.
  - Change Phase 2 to four discriminant sites plus this one unchanged site.
- **Rung:** 3.

### L3 (low). A sixth `resume === undefined` site now exists

- **Where:** planTurn routing (576-579: "Every place that tests `resume === undefined` today"), Phase 5.
- **What is wrong:**
  - Uncommitted RFC-05 Phase 3 work adds `plan-turn.ts:341`: `if (extra.resume === undefined)` inside the effort-in-model slug block. It appends a `model` provenance entry "never on resume".
  - Without the discriminant, a cursor `--resume-last --effort` turn would carry launch-only provenance on a resume-semantics turn.
  - This contradicts the phase rule at 546-560. It surfaces only in Phase 5, on cursor.
- **Required:** Add `plan-turn.ts` (the effort-slug provenance guard) to the site list, or to Phase 5 if it lands after RFC-05 merges.
- **Rung:** 3.

### L4 (low). Leftover overclaims and a nit

- **Where:** Abstract 42-44, claude warning text 751-752, Phase 4 1097.
- **What is wrong:**
  - The Abstract says probes 60-63 show the child "never writes the parent file". The body grades that fact rung 1 (deleted listing), rechecked in Phase 4.
  - The claude warning says "resumes the most-recent claude session ... under a new fork id". The render line correctly says "forked".
  - Phase 4 requires "validator passes with status Draft and `revision: 05`". That goes stale on the next revision or on Accepted.
- **Required:**
  - Add "per the deleted listing; re-probed in Phase 4" to the Abstract.
  - Change "resumes" to "forks" in the claude warning, since it is pinned verbatim.
  - Drop the revision number from the Phase 4 validator step.
- **Rung:** 1 (text).

### L5 (low). `inspect --context --resume-last` has no live gate

- **Where:** planTurn routing (591-600), Phase 4 (1071-1099).
- **What is wrong:**
  - The draft-03 record (259-262) promised "probe it or refuse it before release".
  - The body now pins only an argv corpus row. It also says "No probe covers a duplicated `--fork-session`".
  - The real spawned shape is `--continue --fork-session` plus `--input-format stream-json --no-session-persistence --replay-user-messages`. No probe covers it.
  - The Phase 4 option matrix covers turn options. `--context` is a command, so the matrix does not cover it.
- **Required:** Add one live `inspect claude --context --resume-last` run to Phase 4, or refuse the combination with a typed refusal.
- **Rung:** 3 for the argv trace. 1 for the absent probe.

## Cleared

- **Validator:** passed with no warnings.
- **M3 render:**
  - One `--fork-session` on both `hcn run claude --resume-last` and `inspect --context --resume-last`, as traced above.
  - No second descriptor copy.
  - No harness-name branch in the builder.
  - The existing `--resume <id>` context-inspection argv is unchanged.
- **Descriptor shape:** `{flag, headless}` is used the same way in Descriptor data, Refusals (`spellingOf` arm, 627-628), Phase 1, and Phase 2.
- **Owner answers:**
  - Q3 option (b), with the release gate now in Phase 4.
  - Q5, Q6, and Q7 as option (a).
  - Q1 option (c), with the gate.
  - All match the owner answers file.
- **`evidence.md` L4 correction:** present.
- **No new contradiction on the fork policy:** the Safety policy, Blast radius, Resolved Q3, state machine, and warning texts agree that the parent write is designed out, history is inherited, and the source id is reported nowhere.
- **Scope:** the fork render is labeled supervising policy and passes ADR 0007. It acts within one process and stores nothing across process boundaries.

## Recommendation

The RFC can move to Accepted. All nine draft-04 findings are resolved. The validator passes. The M3 decision renders `--fork-session` exactly once on both paths and leaves the id-path context argv unchanged.

- **Before acceptance:** L2 and L4 are single-sentence text fixes and are best applied first.
- **During implementation:** L1, L3, and L5 can go in as Phase 1, Phase 5, and Phase 4 notes without blocking acceptance.
