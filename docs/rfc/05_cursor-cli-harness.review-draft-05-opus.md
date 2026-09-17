# Review: RFC 05 Cursor CLI harness, revision 05

## What was reviewed

- Path: `/Users/kevin/dev/harness-cli-normalizer/docs/rfc/05_cursor-cli-harness.rfc.md`
- Version: `revision: 05`, `status: Accepted`, 486 lines
- SHA-256: `f669164c2254bfa954f6fb42630ad9ec83eae53c28fde769ebfc337a6c1e4419`
- Commit: `8a04767` (the RFC file is untracked)
- Scope: the parts new in revision 05. These are the Resume-last section (lines 285-306), the Sandbox gate (lines 259-266), the refusal rows at lines 388-390, the Phase 3 and Phase 5 additions (lines 431 and 435), and the revision-05 fixes for M1 and L1-L4.
- Code checked:
  - `src/cli/args.ts`, `src/cli/run.ts`, `src/cli/session.ts`
  - `src/knowledge/{codex,muse,claude-code,pi,profile,descriptor}.ts`
  - `src/interpretation/{parse-resume,resume-last,resolve-options,turn-options,refusal,support}.ts`
  - `src/execution/{stream-turn,decode}.ts`
- Harness help output: installed claude 2.1.274, codex-cli 0.154.0, Muse Code 1.3.0 and pi 0.85.1.
- Fixtures: `test/fixtures` and `docs/research` hold no capture of any `--last` or `--continue` resume.

## Structural results

```
{"passed": true, "errors": [], "warnings": []}
```

## Evidence grades

- Rung 1: the RFC's own claim, not checked.
- Rung 2: consistent with repo docs or code comments.
- Rung 3: checked against repo code or the installed harness's `--help` output.
- Rung 4: observed in a live run or a captured fixture.

The Cursor facts for resume-last and sandbox rest on probes 22 and 23 (rung 4). This pass ran no live resume-last run on any harness, so the other harnesses' behavior is at most rung 3.

## Findings

### B1 (blocking). Resume-last renders flags that are invalid or missing, and its per-harness facts are wrong

Where: lines 291, 298, 304 and 388, plus the Phase 3 item at line 431.

What is wrong:

- **codex.** `--last` is not a launch flag.
  - `codex exec resume --help` shows `Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` and `--last  Resume the most recent recorded session (newest)`.
  - `codex.ts:98-99` says so itself: "Valid only in the `exec resume` context".
  - The codex resume shape (`resume.style: "positional"`, `flag: "resume"`) puts `resume` in the argv. "Renders `resumeLast.flag` into launch argv" produces `codex exec --json --skip-git-repo-check --last <prompt>`, which is not the resume grammar.
  - Resume argv also takes different turn-option renders. For example, sandbox uses `resumeRender` `-c sandbox_mode` because the resume subcommand rejects `--sandbox`. So "resume-phase turn options render as today" does not follow from a launch-argv render.
- **muse.** `muse exec --help` has `--session-id <UUID>` and no `--last`. `muse resume --last` is the interactive subcommand (`muse.ts:87-88`: "exists (muse resume --help)"). The headless path hcn spawns has no most-recent flag, so `resumeLast: { flag: "--last" }` is parse data only, not a render target.
- **claude and pi.** The claim "claude and pi have none" (line 291) is false.
  - `claude --help`: `-c, --continue  Continue the most recent conversation in the current directory`.
  - `pi --help`: `--continue, -c  Continue previous session`.
  - Their `resumeLast: null` (`claude-code.ts:165`, `pi.ts:122`) is a descriptor gap, not a harness fact.
  - The `unsupported-option` refusal and its `supported` list (codex, muse, cursor) therefore name the wrong set.
- **Fit check.** The fit check rests on these facts, and "decides nothing" holds only if each rendered flag is the harness's real headless most-recent mechanism. Of the three harnesses the RFC says render, only cursor `-p --continue` is observed (probe 22).

Impact:
- As specified, codex resume-last fails in the harness or resumes nothing.
- Muse gets an unknown flag.
- Two harnesses that do support most-recent resume are refused.
- The test list at line 306 pins these renders in the argv corpus, so TDD would lock in invalid argv.

Rung: 3, from each harness's `--help` output and the descriptor comments. The codex behavior when `--last` is combined with a positional prompt is not probed. The usage line puts `[SESSION_ID]` before `[PROMPT]`, so a lone positional prompt may be read as a session id.

### H2 (high). Resume-last skips every resume safety net, and the RFC says one still applies

Where: line 300 and the "Identity" bullet at line 299.

What is wrong:

- **The warning does not fire.** "The `stream-turn.ts` pre-spawn warning path applies generically" is false. At `stream-turn.ts:249` the create-on-missing warning is gated on `effective.resume !== undefined && h.resume.onMissing === "create"`. With no id, `effective.resume` is undefined and the warning never fires.
- **No store check runs.** The run and session guards (`run.ts:40-57`, `session.ts:207-225`) run only when a resume id exists.
- **Cursor can silently start a new session.** Cursor resume creates on missing (`onMissing: "create"`, probes 21a/21b). `-p --continue` in a directory with no prior session has no observed behavior in the evidence. It may start a blank session, and the decoder then announces that session as `harness-minted`. The run succeeds with no signal that nothing was resumed.
- **Most-recent resolution can pick a stranger's session.** `resume-last.ts` documents this in its header: "'most recent' over a race window is a guess, and a guess resumes a stranger". Probe 23 already shows `--resume=-1` choosing a different session than expected. The RFC keeps `rankResumeLast` test-only and hands the choice to the harness, but it does not say how it handles that race. It also does not say why the stance in `resume-last.ts` no longer applies. That stance is the reason hcn never exposed resume-last before; see the draft-02 record at line 74.

Identity attribution itself is correct. `requestedId` is null, so `decode.ts:150` announces the picked id as `harness-minted`, and no caller id is mis-labeled. The consumer, however, cannot tell a resumed session from a fresh one.

Impact:
- A caller that asks to continue can get a new blank session, or another run's session, with exit 0.
- That silent create is the exact case the F-23 warning and the store guard exist to surface.

Required: pick a policy (warn, refuse, or accept and document) and a signal that tells resumed from fresh, then correct line 300.

Rung: 3 for the code paths. Rung 4 for probe 23's choice of a different session.

### M3 (medium). G-sandbox collides with the profile default, and its pass criteria cannot fail cleanly

Where: lines 261-266 and 435.

**The spec and the profile default collide.**
- `DEFAULT_TURN_PROFILE` sets `sandbox: "workspace-write"` (`profile.ts:21`).
- `EXPRESSIBLE.sandbox` is true for any harness with a `turnOptions.sandbox` spec (`resolve-options.ts:84-87`).
- The profile loop applies expressible defaults, so once the spec exists every bare cursor run carries `sandbox: workspace-write`. Two outcomes follow:
  - If the observed mapping lacks `workspace-write`, the enum check in `turn-options.ts` refuses `invalid-option-value` on every bare cursor run.
  - If the mapping has it, every bare run renders `--sandbox`, which changes today's default launch.
- "No profile default is invented" (line 265) addresses neither outcome.

**The mapping is underspecified.** Cursor has two spellings; the vocabulary has three members. The RFC does not say:
- which member gets no spelling;
- whether an unmapped member refuses `invalid-option-value`;
- whether both `enabled` and `disabled` can map to one member.

**The pass criteria cannot fail cleanly.**
- "Behave as recorded" makes the inside edit and the fetch pass whatever happens.
- "Stable" names no repetition count.
- The criteria do not define what counts as "confined": a tool denial, a `denial` field on `error`, a non-zero exit, or a file that is simply absent.

**The matrix is incomplete.**
- It has no cell for the autonomy flag hcn passes (`--force` or its equivalent) or for the `access` preset.
- It has no cell for the resume argv, although line 265 makes `resumeRender` depend on "the same matrix passes on resume argv".

Rung: 3.

### M4 (medium). The resume-last refusals need vocabulary changes the RFC does not list

Where: lines 304, 388 and 431.

What is missing:
- `unsupported-option` for `--resume-last` needs a new member in the closed `RefusalOption` union (`refusal.ts`).
- It also needs a `spellingOf` arm in `support.ts`.
- Phase 3 names the refusal but not these two edits.

None of the planned tests checks a rendered flag against real harness grammar. This is how B1 got through.

Rung: 3.

### L5 (low). Line 280 overstates what resume-last covers

Line 280 says `--resume=-N` and `--continue` are "both reachable through `hcn run --resume-last`". The flag renders `--continue` only, and line 280 itself says `--resume=-1` still fails the id shape check.

Rung: 3.

### L6 (low). The draft-02 record now conflicts with the body

Line 74 still says "`resumeLast` ... stays as descriptor data for `parse-resume.ts` only ... Adding a resume-last option is out of scope and needs its own fit check." Revision 05 adds the option.

- Mark that record entry as superseded by draft-05.
- The fit check at lines 289-295 should state its scope direction explicitly. The flag widens scope beyond the owner's "one-shot plus resume" v1 decision, and widening is an owner call.

Rung: 3.

## Cleared

- **M1 (`-fast` pins effort).** Consistent at line 219, refusal row 384, Terminology line 127 and Phase 4.
- **L1.** Consistent at lines 209, 431 and 456.
- **L2.** The Phase 2 list is complete.
- **L3.** Line 230 keeps `contentEventsOf(h, raw)` with its array shape. `contentEventsWithState(h, raw, state)` returns `{ events, state }` and is used only from `decode.ts`, and Phase 3 reads `.events`. The contract is consistent across the RFC.
- **L4.** Line 182 names both `storePath` callers. The probe citations (51 lines 7-9, 52 lines 9-10 and 24-25) and the tombstone bound (line 244) agree.
- **Mutual exclusion of `--resume-last` with `--resume`/`--session-id`.** Refusing `mutually-exclusive-options` matches the shape `resumeIdOf` already produces (`args.ts:212-222`).
- **`hcn session` refusal.** `invalid-option-value` with a stable-id rationale is sound.
- **Collision check.** No `--resume-last`, `--last` or `--continue` exists in `src/cli`.
- **Identity.** `requestedId` null leads to a `harness-minted` announce (`decode.ts:150`). There is no mis-attribution, and the `--resume` refusal logic stays intact for id-based resume.
- **Validator.** Passed.

## Status

`status: Accepted` is not justified. Revision 05 added two design sections after the last review, and one has a blocking error (B1) and a high safety gap (H2). Set the status back to a pre-acceptance value until B1 and H2 are fixed and re-reviewed. Another option is to cut `--resume-last` from this RFC, restore the line-74 position and give it its own RFC. The rest of the RFC (drafts 01-04 plus the M1 and L1-L4 fixes) stays ready for owner sign-off.

## Not reviewed

- No live headless run of `--continue`, `--last` or `exec resume --last` on any harness. That includes cursor `--continue` with no prior session and codex `--last` combined with a positional prompt.
- G-sandbox's Cursor behavior. It needs logged-in runs and, per the rules, comes from docs or observed runs only. Nothing under `~/.local/share/cursor-agent` was read.
- The `review-rfc` skill source.
- Sections unchanged since draft-04 were not re-checked beyond the M1 and L1-L4 consistency pass.
