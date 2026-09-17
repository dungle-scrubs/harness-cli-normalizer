# Review: RFC-05 Cursor CLI harness (draft-04, opus reviewer, confirmation pass)

Draft-04 has no blocking or high findings. All seven draft-03 findings are resolved. Draft-04 adds one medium item, a contradiction in the `-fast` effort rule, which the owner or author should settle before implementation starts. The low items are spelling-level fixes, or gaps that typecheck and existing tests will surface.

## What was reviewed

- **RFC:** `docs/rfc/05_cursor-cli-harness.rfc.md`, `revision: 04`, `status: Draft`, untracked.
- **SHA-256:** `277779fff3c9e867dc0435c051ed5849d7dbc103a8efe9f714379df459d7a8f8`.
- **Base commit:** `8a04767`; `src/` and `test/` unchanged.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, cross-family; the author is a Meta Muse model.
- **Scope:** narrow confirmation pass.
  - The revision record for draft-04 (lines 80-90).
  - Changed sections: Effort mechanism, Stream decoding, `store.rootEnv` and `store.defaultRoot`, Refusals, Implementation Plan.
  - `spike-addendum.md` §J and captures `out/51-*` through `out/55-*`.
  - Code: `resolve-options.ts`, its test file, `provenance.ts`, `plan-turn.ts`, and the call sites of `contentEventsOf`.
- Nothing under `~/.local/share/cursor-agent` was read.

## Structural results

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Draft-03 findings: resolution check

| # | Status | Check |
|---|---|---|
| H1 | Resolved | The resolve step now runs whenever an arg-tier `--effort` is present, taking the model from any tier or none (line 187). After `resolveEffectiveOptions`, the only effort left on cursor is the arg effort, so the trigger can be decided. Resume has no config tier (`plan-turn.ts:293-311`), so the arg `--model` is its only source, as line 187 states. Refusals for "no model" and "bare-only model" now have a caller, and the Phase 4 matrix pins every combination. |
| M2 | Resolved | The unknown-`call_id` row is split into `success` (tool event only) and `rejected` (tool event plus denial). Probes 51 and 52 confirm that `--force` emits `started` before `completed` (`51-force-search.stdout` 9-10, `52-force-fetch.stdout` 8-11), so the success row is a forward rule. Tombstones stop a second `tool` event after eviction. |
| M3 | Resolved, with a new contradiction (see M1) | First-match-wins is stated (line 191). `--model gpt-5.2 --effort high` resolves to `gpt-5.2-high` (line 195). Phase 1 adds a guard for a bare slug colliding with an explicit `-medium`. |
| M4 | Resolved in design | `unrenderable` carries the tier, `writeProvenance` prints the recorded tier, the drop sits in the profile loop's `sourceTier` branch (correct: `resolve-options.ts:337-341`), and the plan step rewrites provenance. Low residue in L1 and L2. |
| M5 | Resolved | Probe 53 (`CURSOR_CONFIG_DIR=""`, store lands under XDG) and probe 54 (`relcfg` resolved against the cwd) settle both rules. Resolving against the spawn cwd, with the process-cwd split marked unverified, is honest. Probe 55 (`--workspace ws-54/../ws-55`) files the session under md5 of `ws-55`. |
| L5 | Resolved | The reader returns `{ events, state }`, and execution threads the state without reading it. The ADR 0005 intent and the protocol-literal gate (`test/execution-layering.test.ts`) still hold: no cursor literal enters `src/execution`. |
| L6 | Resolved | Both "no new RefusalIssue" claims are gone (line 188 and the Failure classification intro). The State Machine line 264 follows the `requestedId` rule. "Stem rule below" is fixed (line 104). The transcript check is descriptor-driven (`transcript === null`). The hints record moves to `docs/cursor-hints-ratification.md`. Small residue in L4. |

## Findings (draft-04)

### M1. The `-fast` effort-switch rule contradicts the refusal table and Terminology

- **Severity:** medium.
- **Where:** Resolution rule on line 197; Refusals row on line 329; Terminology "Family" on line 105; revision record item 4 (line 71).
- **What is wrong:**
  - **Line 197** lets a `-fast` variant with a conflicting effort switch to a different slug. `--model gpt-5.2-high-fast --effort low` renders `gpt-5.2-low-fast` when that twin is listed. The Phase 4 matrix pins this: "arg `-fast` plus other effort renders the twin only when listed".
  - **Line 329** still says a conflicting effort on a "plain, thinking, or `-fast` twin" slug refuses `invalid-option-value`, and "nothing is ever composed".
  - **Line 105** still says `-fast` "is handled by the idempotence check ... never by composition".
  - The two rules also treat variants differently:
    - `--model gpt-5.2-high --effort low` refuses (line 196: "A variant slug already pins effort").
    - `--model gpt-5.2-high-fast --effort low` resolves.
- **Impact:**
  - An implementer who follows the refusal table writes tests the Phase 4 matrix contradicts.
  - Callers see a plain variant pin its effort while its fast twin does not.
  - The fix is one choice, recorded in all three places:
    - (a) fast twins pin effort exactly like plain variants: refuse, and drop the reattach step; or
    - (b) both plain and fast variants switch effort through the stem row.
- **Rung:** 2.

### L1. The provenance rewrite has no arg `model` entry to rewrite in the common case

- **Severity:** low.
- **Where:** Composition site (line 187); Phase 3 and Phase 4 ("provenance-entry rewrite").
- **What is wrong:**
  - `resolveEffectiveOptions` writes a `model` provenance entry only when a config tier also sets `model`. The arg-wins branch sits in the loop over config keys (`resolve-options.ts:426-437`), which `resolve-options.test.ts:100-108` pins.
  - Resume produces no provenance at all (`plan-turn.ts:293-311`).
  - For `hcn run cursor --model claude-opus-4-8 --effort high` with no config `model`, there is no entry to rewrite.
  - The RFC should say whether the plan step appends an arg-tier `model` entry holding the resolved slug, or leaves provenance untouched when none exists.
- **Rung:** 3.

### L2. The widened `unrenderable` shape has more consumers than the RFC names

- **Severity:** low.
- **Where:** Phase 2 and Phase 3 (M4 disposition).
- **What is wrong:**
  - Named: `ResolvedOptions` and `writeProvenance`.
  - Also affected:
    - `TurnPlan.unrenderable` and its local variable (`plan-turn.ts:87`, `:297`);
    - the `access` divergence push (`resolve-options.ts:445`), whose tier is the tier of the `access` setting, not `profile`;
    - tests that expect string arrays: `test/interpretation/resolve-options.test.ts`, `argv-corpus.test.ts` with its `argv-corpus.snapshot.json`, `memory.test.ts`, and `test/cli/context-window.test.ts`.
  - Typecheck and snapshot failures will surface every one of these, so no implementer has to guess. The "changes no existing harness behavior" claim holds only if the stderr line for existing profile-tier divergences keeps printing `profile`, which the design does.
- **Rung:** 3.

### L3. The `{ events, state }` change breaks 19 existing test call sites that the RFC does not count

- **Severity:** low.
- **Where:** Stream decoding (line 208: "Both existing call sites read `.events`").
- **What is wrong:**
  - Changing `contentEventsOf` for every harness updates the two production call sites (`decode.ts:190`, `context-inspection.ts:173`).
  - It also breaks 19 calls in `test/interpretation/content.test.ts` and `content-rate-limit.test.ts`, which compare the result to arrays.
  - The change is mechanical. The RFC should list those files, or keep a two-argument array-returning wrapper for readers that ignore state.
- **Rung:** 3.

### L4. Residual text inaccuracies

- **Severity:** low.
- **Where:** `store.defaultRoot` row (line 160); probe line citations in the decoding table and State Machine; tombstone rule (line 208).
- **What is wrong:**
  - **Line 160** says `cli/resume-guard.ts` is "the only production caller" of `storePath`. `execution/native-codex-record.ts:12` also calls `storePath(codexCli, runtime)`. `native-settings.ts` and `interactive-preflight.ts` reach it through `codexRecordsRoot`. Only codex paths are affected, so the conclusion holds, but the sentence is wrong.
  - **Probe line numbers** are off by one against the captures:
    - Probe 51's query pair is at lines 7-8, `started` and `completed` at 9-10 (the RFC says 6-8).
    - Probe 52's fetch pair is at 9-10 and the shell `started`/`completed` at 24-25 (the RFC says 8-9 and 23-24).
    - The addendum has the same offset.
  - **Tombstone rule.** The tombstone set is itself bounded at 128 with drop-oldest. An id evicted from both the pending map and the tombstones would emit a second `tool` event again. That needs more than 256 calls in flight in one turn, so it is not a practical risk, but the "never double-count" wording (line 208) is absolute.
- **Rung:** 2.

## Cleared

- **Validator.** The structural validator passed.
- **Reader contract.** `{ events, state }` keeps interpretation free of side effects. Threading is confined to one `DecodeState` slot, a factory call, and a third parameter. No harness protocol literal enters `src/execution`.
- **Tombstones.** The rule prevents duplicate `tool` events in every realistic turn. It emits a denial for a rejected result on a tombstoned id without a second `tool` event.
- **Store root.** The rules for precedence (probes 36, 44, 45), empty values (53), relative values (54), and workspace filing (55) are all observed. Resolving relative values against the spawn cwd is the anchor probe 55 supports.
- **H1 trigger.** The trigger and model-source rules have one owner and one call site, and cover launch and resume.
- **Carried forward.** Everything cleared in the draft-02 and draft-03 reviews still holds: passthrough refusal, Stem rule reachability (zero duplicate keys over 223 slugs), `trust-refused` semantics, native terminal resume out of v1.

## Not reviewed

- Sections that draft-04 did not change were not re-read line by line.
- The hcn skill source and consumers of `denial` outside this repository were not checked.
- No live Cursor runs were made. NFD path names and a real split between process cwd and spawn cwd are still unprobed; the RFC labels both.
