# Review: RFC 05 Cursor CLI harness, revision 06

Removing resume-last left no requirement behind, and the profile-default collision rule is sound. The rewritten G-sandbox still has two high findings. Its mapping contradicts its own pass criteria, and its matrix cannot pass on current Cursor behavior.

## What was reviewed

- **RFC:** `/Users/kevin/dev/harness-cli-normalizer/docs/rfc/05_cursor-cli-harness.rfc.md`, `revision: 06`, `status: Draft`, 489 lines.
- **SHA-256:** `11d021eaa11d08abab558f2a1fd7bdefd3672be0daea1f02a221dbbc9197c500`. Commit `8a04767`; the RFC file is untracked.
- **Scope:** the resume-last removal, the Sandbox gate (lines 270-285), the draft-06 revision record (lines 114-122), Phase 5 (line 438) and Resolved question 4 (line 453).
- **Code checked:**
  - `src/knowledge/{profile,codex,descriptor}.ts`
  - `src/interpretation/{resolve-options,turn-options,refusal}.ts`
- **Cursor evidence:** only `docs/research/2026-09-16-cursor-and-grok-build-harnesses.md` and the probe citations in the RFC. Nothing under `~/.local/share/cursor-agent` was read.

## Structural results

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Evidence grades

- Rung 1: the RFC's own claim, not checked.
- Rung 2: consistent with repo docs.
- Rung 3: checked against repo code.
- Rung 4: observed in a probe run recorded in the research doc or the RFC.

## Findings

### H1 (high). The sandbox mapping contradicts the gate's own pass criteria and mislabels confinement

Where: line 276 (mapping), line 280 (pass criteria) and line 453.

**What is wrong.** Line 280 fixes what each spelling must do for the gate to pass:
- Under `enabled`, the inside edit MUST run ("FAILS if the inside edit is denied ... under either spelling") and the outside write MUST be confined. That is `workspace-write`: edits inside the workspace, nothing outside.
- Under `disabled`, the outside write MUST land ("reproduce today's unconfined bare-run behavior"). That is `danger-full-access`. Codex's `workspace-write` confines writes outside the workspace by definition.
- The research doc records that a first run writes `sandbox.mode: disabled` (research doc line 370). A bare run is unsandboxed, which confirms that `disabled` means "no sandbox".

Line 276 maps the other way: `read-only` to `enabled` and `workspace-write` to `disabled`. A gate that passes therefore proves the mapping is wrong:
- `hcn run cursor --sandbox read-only` would allow edits inside the workspace.
- `--sandbox workspace-write` would allow writes anywhere.
- Provenance would report a confinement that did not run. Line 276 itself names that outcome as the reason members must not share a spelling.
- The ban on a `danger-full-access` spelling ("MUST NOT gain one") excludes the member that `disabled` actually matches.

**Decision on the coordinator's question.** The coordinator's reading is correct. The mapping must be an output of the gate, from a decision rule fixed in advance:
- Fix the rule a priori. For each spelling, derive the member from the observed cells:
  - inside edit denied and outside write confined: `read-only`;
  - inside edit runs and outside write confined: `workspace-write`;
  - both run: `danger-full-access`;
  - any other combination: the gate fails.
- The spec records only the members observed.
- Two supporting changes are needed:
  - Delete the fail condition "inside edit denied under either spelling". It rules out observing `read-only`.
  - Delete the "`disabled` is the mapping of `workspace-write`" sentence.
- The likely result is `enabled` to `workspace-write`, `disabled` to `danger-full-access`, and `read-only` with no spelling.

**Knock-on effect.** The profile default `workspace-write` would then map to `enabled`. The divergence rule at line 274 is still right, but its rationale is not. The stated reason is "every bare run would gain a `--sandbox` flag for zero semantic gain". Under the corrected mapping, rendering the default would switch every bare run from unconfined to sandboxed. The reason to diverge is to keep today's behavior, not that the flag changes nothing.

Rung: 3 for the code vocabulary (`codex.ts:152-166`). Rung 4 for the `sandbox.mode: disabled` default.

### H2 (high). The approval layer denies the base cells, so the gate always fails

Where: line 278 (matrix cells a-c) and line 280.

**What is wrong.**
- Cells (a)-(c) run without `--force`; `--force` is only the separate cross (d).
- The spike shows that in a trusted workspace without `--force`, non-allowlisted shell and web fetch are auto-denied (research doc lines 336-342, probes 13-17). The result is an `interaction_query` pair with a `rejected` result and a `rejected` `tool_call/completed`. The RFC decoder turns this into an `error` event that carries `denial`.
- So under `disabled`, cell (a) yields an absent file plus a denial signal, which line 280 defines as "confined". That trips the fail condition "outside write is confined under `disabled`" on every run.
- The network cell is denied under both spellings for the same reason, so it shows nothing about the sandbox.

**Root cause.** The matrix cannot tell an approval rejection from a sandbox denial. Signal (i), the `denial` field, is the approval signal.

**Impact.** G-sandbox cannot pass, so owner answer 4 (add the spec if headless-stable) cannot be met. If a pass is forced, it would record approval behavior as sandbox behavior.

**Required fix.**
- Run the confinement cells under `--force`, or with a shell command on the allowlist, so the approval layer grants the call. The (d) cells become the baseline.
- Define a signal that attributes a denial to the sandbox and not to approval. One candidate is a non-zero shell exit with an OS permission error on a call the approval layer approved.

Rung: 4 for the approval behavior. Rung 3 for the decoder mapping.

### M3 (medium). The per-value spelling table has no descriptor shape

Where: lines 276 and 285.

**What is wrong.**
- `render: { kind: "flag-value", flag: "--sandbox" }` emits the enum value verbatim. `tokensFor` returns `[flag, value]` (`descriptor.ts:284-288`). This spec would render `--sandbox read-only`, not `--sandbox enabled`.
- `OptionRender` and the `enum` spec (`descriptor.ts:188-230`) have no field that maps a value to a spelling.
- The table needs one of two things:
  - a new field, such as a `spellings` record on the enum spec or on `flag-value`;
  - or a new render member.
- Either way the consumers must be named, as the RFC does for its other schema changes (lines 209-214): `tokensFor`, `overrides.ts` shape validation, the argv corpus, and `support.ts` `spellingOf`. None of these appears in the numbered descriptor changes or in Phases 1-3.

Rung: 3.

### M4 (medium). The "cursor-scoped arm" in the profile loop has no data key

Where: line 274.

**What is wrong.**
- The effort divergence arm is keyed on descriptor data: spec kind `effort-in-model` (line 220).
- The sandbox arm is described only as "cursor-scoped". The loop gets its sandbox value from `EXPRESSIBLE.sandbox` (`resolve-options.ts:84-87`), which is true for codex and cursor alike.
- "The spec carries no `default`" is not a usable discriminator. The profile loop does not read spec defaults; `turn-options.ts:240-253` does.
- As written, the arm is a harness-name branch. The RFC forbids that elsewhere (line 213, "never a harness-name branch").

**Required fix.** Name the descriptor field that marks non-arg-tier sandbox as divergent, and list it among the schema changes.

Rung: 3.

### L5 (low). The network fail condition has no basis

Where: line 280.

"The network fetch verdict differs between the two spellings" is a fail condition. The research doc says Cursor's sandbox has a network toggle (line 331). Codex `workspace-write` also blocks network by default. A difference in network access between a sandboxed and an unsandboxed spelling is expected, not a failure. Record the network verdict as an observed property of each mapped member instead.

Rung: 2.

### L6 (low). Cell (e) is a unit test, not a live probe

Where: line 278, cell (e).

`--access read` refusing `unsupported-option` is a pure refusal that needs no logged-in run. It already appears in the test list at line 285. As a row in the live matrix it adds a cell that cannot fail on Cursor behavior.

Rung: 3.

## Cleared

**The resume-last removal is clean.** The remaining mentions are all records or v1 statements:
- History entries: lines 55-56, 74 (now annotated as superseded and restored), 106, 114-122, 444 and 460.
- v1 statements: line 196 (`resumeLast` is parse data only), line 209 (`rankResumeLast` needs no arm) and line 298 (most-recent resume is not reachable).
- The summary record: lines 303-312.

No resume-last requirement, refusal row, test, or Phase 3 item remains. The refusal table and Phases 1-5 carry no `--resume-last`.

**Revision-06 record.** B1, H2 and M4 are answered by removal, and the record says so accurately. L5 is applied at line 298, and L6 at line 74.

**Collision analysis.** The analysis at line 274 is correct against the code:
- `profile.ts:21` sets the default `sandbox: "workspace-write"`.
- `EXPRESSIBLE.sandbox` is true for any harness with a sandbox spec (`resolve-options.ts:84-87`).
- The enum launch default emits at `turn-options.ts:240-253`.
- Omitting `default` together with a divergence arm does keep today's bare argv (subject to M4).

**Refusals.**
- An explicit value outside `spec.values` refuses `invalid-option-value` with the value list (`turn-options.ts:353-371`). No new arm is needed.
- `unsupported-on-resume` exists in the refusal vocabulary (`refusal.ts:14`), so the conditional `resumeRender: null` refusal is expressible.

**Pass-criteria form.** The absent-file-plus-signal conjunction and the 3-run stability rule make the criteria falsifiable in form. H2 is about what the cells actually observe, not about the form.

**Status and style.** `status: Draft` fits the open state, and the RFC has no em dashes.

## Not reviewed

- No live Cursor run of `--sandbox enabled|disabled`. The approval-layer finding rests on the recorded probes 13-17, not on a new run.
- Cursor's sandbox documentation page. Only the research doc's summary of it was used.
- Sections unchanged since revision 05, beyond the removal check.
