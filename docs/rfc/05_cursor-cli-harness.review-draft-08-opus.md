# Review: RFC 05 Cursor CLI harness, revision 08

Revision 08 has no blocking or high findings. The Cursor sandbox spec is gone cleanly, and the section L captures support outcome B. One medium finding remains: the RFC claims more than the probes tested.

## What was reviewed

- **RFC:** `/Users/kevin/dev/harness-cli-normalizer/docs/rfc/05_cursor-cli-harness.rfc.md`, `revision: 08`, `status: Draft`, 511 lines.
- **SHA-256:** `ca97e3ae39626c2746c8cdda1ca4b1a1334fc3aa54077eef436f4eec77762191`. Commit `8a04767`; the RFC file is untracked.
- **Scope:**
  - revision records draft-07 and draft-08 (lines 125-143)
  - the Sandbox section (lines 290-306)
  - the autonomy/modes bullet (line 287)
  - refusal rows 415-416
  - Phases 1-5 (lines 452-460)
  - Open questions (line 466) and Resolved question 4 (line 475)
- **Evidence:**
  - `spike-addendum.md` sections K and L, in the session scratchpad at `cursor-spike/`.
  - The raw captures `out/70-*`: 37 capture sets, the 36 matrix runs plus the seed. I checked the argv, the exit codes, the stderr sizes, the `interaction_query` counts, the `rejected` completions and the curl results directly.
- **Code:** `src/interpretation/turn-options.ts` (no-spec refusal path) and `resolve-options.ts:84-87` (`EXPRESSIBLE.sandbox`).
- Nothing under `~/.local/share/cursor-agent` was read.

## Structural results

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Evidence grades

- Rung 2: consistent with docs or help text.
- Rung 3: checked against repo code.
- Rung 4: observed in probe captures.

## Draft-06 findings

| Finding | Status under outcome B | Where |
|---|---|---|
| H1 (mapping contradicts pass criteria) | Resolved. The fixed derivation rule is stated. No spelling maps to any member, and no mapping remains. | lines 298-300 |
| H2 (approval layer confounds the cells) | Resolved. Section L grants each call through a scratch allowlist without `--force`. All 36 captures have zero `interaction_query` lines, which I confirmed by grep. | lines 294-296 |
| M3 (spelling table has no shape) | Moot. `spellings` is removed, with no `tokensFor` lookup and no shape validation. | lines 141, 300, Phase 2 |
| M4 (divergence arm not keyed on data) | Moot. There is no sandbox arm. Non-arg-tier values diverge through the existing no-spec path, where `EXPRESSIBLE.sandbox` is false without a spec. | line 300; `resolve-options.ts:84-87` |
| L5 (network fail condition) | Moot. Network is recorded as an observation, not a criterion. | line 296 |
| L6 (`--access read` as a live cell) | Resolved. It is a Phase 4 unit test only. | line 416 |

## Findings

### M1 (medium). "Confines nothing headless" claims more than K and L tested

**Where:** line 298 ("the sandbox confines nothing headless on agent `2026.09.15-d2fe57e`, with or without `--force`"), line 475, and the re-probe rule at line 304.

**What is wrong.**
- Section K granted each call with `--force`. Section L granted each call through an allowlist entry.
- Neither ran the one cell where sandbox mode would be expected to act: a non-allowlisted command, without `--force`, under `--sandbox enabled`.
- The help text shows why that cell matters. Addendum section L quotes `agent sandbox --help`: `disable` means "Disable sandbox mode and use allowlist mode (default)". That text presents sandbox mode as an alternative to allowlist approval, not a layer on top of it.
- If granted or allowlisted commands run outside the sandbox, both matrices tested only commands the sandbox never wraps.

**Signs in the captures.**
- **Network.** `agent sandbox run --help` sets `--network` to false by default. Yet curl returned 200 under `--sandbox enabled` in all three L runs (`70-c-enabled-{1,2,3}`). That fits "the sandbox never applied to this command" as well as "the sandbox does not work".
- **Write target.** Every outside write went to `.../scratchpad/cursor-spike/outside-70-*.txt`, the parent directory of `ws-main`, under `/private/tmp`. Common sandbox write profiles leave the temp directories writable; codex `workspace-write` does. So cell (a) cannot separate "no confinement" from "temp writes allowed". The network result makes this confound the smaller of the two.

**Impact.**
- Outcome B is still the right v1 decision. Refusing `--sandbox` fails safe, and no probed configuration confines anything hcn could render.
- The problem is the record. The normative sentence and Resolved question 4 state a general negative result that the evidence does not establish.
- The re-probe rule repeats the section-L method, so a later version bump would repeat the same blind spot.

**Fix.**
- Narrow line 298 and line 475 to "no confinement observed for granted (`--force` or allowlisted) commands".
- Add to the re-probe rule:
  - a non-allowlisted, no-`--force` cell under `enabled`, which records whether the call is denied by approval or runs;
  - an outside-write target outside the temp directories, for example under `$HOME`.

**Rung:** 4 for the captures. Rung 2 for the help-text reading of sandbox mode versus allowlist mode.

### L2 (low). Dangling pointer in the draft-07 record

**Where:** line 131.

"Consumers are named in member 7 below (removed in draft-08 ...)". No member 7 exists; the numbered list ends at 6 (line 234). The parenthetical explains the gap, but "below" still points at nothing. Make it "were named in member 7 (removed in draft-08)".

**Rung:** 3.

## Removal check

The removal is complete.

**`spellings`.** It appears only in:
- the draft-07 record (line 131);
- the draft-08 record (line 141);
- two negative statements: "no `spellings` record exists" (line 300) and "no `spellings` shape test" (line 306);
- the Phase 2 negative "No sandbox arms exist anywhere: no `tokensFor` spelling lookup, no `spellings` shape valid[ation]".

No requirement uses it.

**`danger-full-access`.** It appears only in:
- the draft-07 record (line 129);
- the derivation rule (line 298);
- the negative rationale (line 300).

No spec or refusal uses it.

**Divergence arm.** The only mention is the draft-07 record (line 132). The body uses the existing no-spec split (lines 287, 300, 415).

**Phases.**
- Phase 1 says "Cursor carries no `turnOptions.sandbox` spec".
- Phase 2 says there are no sandbox arms.
- Phase 4 keeps only:
  - the unit test for explicit `--sandbox` as `unsupported-option` on launch and resume;
  - the profile-tier divergence test;
  - probes 60-61 and 70-71 as fixture candidates.
- There are no argv-corpus sandbox rows.

**Code fit.** Both tests pass against today's code without new logic:
- With no spec, a defined value refuses `unsupported-option` on either phase (`turn-options.ts`, the "Raw is defined but spec is absent" branch).
- The profile default diverges because `EXPRESSIBLE.sandbox` is false (`resolve-options.ts:86`).

**Resolved question 4 and open questions.** Resolved question 4 (line 475) records outcome B, dated 2026-09-17, with both probe sets. Line 466 points to it.

## Section L evidence

The addendum matches the captures for all four cells.

- **Runs.** 36 matrix runs, all exit 0. All stderr files are empty (0 bytes total), and no stdout has an `interaction_query` line.
- **Cell (a), outside write.**
  - The shell `exitCode` is 0 in all three `enabled` runs. The outside files exist for every spelling and run.
  - The argv carries `--sandbox enabled` with no `--force` (`70-a-enabled-1.argv`).
- **Anomaly 1: variant rejected, then the exact command runs.** Confirmed in `70-a-disabled-1` and `70-a-base-2`, the only two stdouts with `rejected`.
  - The rejected call is `printf x > .../outside-70-disabled-1.txt; echo $?`, with `reason: ""`, followed by the bare `printf x > ...` call.
  - The compound `; echo $?` does not match `Shell(printf)` under the documented first-token grammar. The rejection comes with no `interaction_query` pair.
  - The file then lands in the same turn, so the rejection is not confinement.
  - The two rejected runs are `disabled` and baseline, not `enabled`, so they cannot be read as a sandbox effect.
  - The existing decoder rows for rejected completions cover this shape; the rejection yields `tool` plus `denial`.
- **Anomaly 2: curl exit 6 on a trailing `.` host.** Confirmed.
  - Six stdouts carry `Could not resolve host: .`: base-1, base-2, base-3, disabled-3, enabled-2 and enabled-3.
  - All nine `70-c-*` stdouts contain `200`.
  - The argv shows the cause: the prompt text ends in a `.`, and the model passed it to curl as a second URL. This is a prompt-construction artifact.
  - It does not affect the example.com verdict, and it does not move outcome B.
- **Derivation.** Under the fixed rule, inside edits ran 9/9 and outside writes landed 9/9, so no spelling maps to any member. Outcome B follows, subject to the scope limit in M1.

## Cleared

- **Validator.** Passed with no warnings. The draft-07 lowercase "optional" warning is gone (line 143).
- **Conflict note (line 302).** Consistent with the help text and docs quoted in addendum section L.
- **Style.** The RFC has no em dashes.
- **Other sections.** Nothing else in revision 08 introduces a blocking or high problem. The refusal rows 415-416 and Phases 1-5 agree with the Sandbox section.

## Not reviewed

- No new live Cursor run. In particular, the non-allowlisted, no-`--force` `--sandbox enabled` cell from M1 was not run.
- The Cursor docs pages themselves; only the addendum's quotations were used.
- Sections unchanged since revision 06, beyond the removal check.
