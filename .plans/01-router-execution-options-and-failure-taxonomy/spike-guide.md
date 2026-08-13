# Router execution options and failure taxonomy - Spike Guide

Three assumptions gate descriptor facts this plan writes down. Every one is
about **enforcement or emitted output**, not argv grammar - all grammar was
already verified from `--help` during the RFC stage
(see the RFC's section 6 verification table).

The plan is designed so that **no assumption blocks landing**. Each failure
mode has a specified fallback the RFC already commits to.

## Assumptions

### A-001: `codex exec resume -c sandbox_mode=<mode>` is enforced, not merely accepted

`codex exec resume --help` on 0.147.0 confirms `-c <key=value>` parses in the
resume grammar. What is unverified is whether the value actually constrains
the sandbox, or whether resume ignores it and falls back to codex's built-in
default.

- **Impact if false:** the codex `sandbox` spec's `resumeRender` becomes
  `null`. A resume carrying a sandbox value refuses with
  `unsupported-on-resume`; a resume with no sandbox intent is unaffected.
  <!-- D-020 -->
- **Experiment:** two directions, because a one-direction test cannot
  distinguish enforcement from a model that simply declined to write.
  1. Launch `codex exec --json --sandbox workspace-write --skip-git-repo-check
     "create a file spike-a001.txt containing OK"` in a scratch git repo.
     Capture the thread id from `thread.started`.
  2. Resume with `codex exec resume <id> --json --skip-git-repo-check
     -c sandbox_mode="read-only" "create a file spike-a001-b.txt containing OK"`.
     Assert the write is **refused** (a sandbox denial in the item stream, not
     a polite refusal in prose).
  3. Inverted: launch with `--sandbox read-only`, resume with
     `-c sandbox_mode="workspace-write"` and the same write prompt. Assert the
     write **succeeds**.
- **Pass criteria:** both directions behave as the config value dictates. A
  pass in only one direction is a FAIL - it means the config is ignored and
  the launch value or the built-in default is what governed.
- **Effort:** ~20 min once Codex is available.
- **Status:** **DEFERRED.** Codex is at its usage limit for approximately four
  days from 2026-08-13 and this needs live inference. <!-- D-008 --> Phase 4
  ships the refusal path, which is correct under either outcome; adding
  `resumeRender` is a follow-up commit.

### A-002: claude `--effort` is honored on a `-p` headless turn

`claude --help` on 2.1.229 documents `--effort <level>` as "Effort level for
the current session" with ladder `low, medium, high, xhigh, max`. Whether the
`-p` (print/headless) path honors it, or silently ignores it as an
interactive-only setting, is unverified.

- **Impact if false:** claude's `effort` spec is dropped, `effort` on claude
  refuses as it does in 0.1.3, and the RFC's claim that all four harnesses can
  express effort at launch is corrected to three.
- **Experiment:**
  1. `claude -p --effort high --output-format stream-json --verbose
     --include-partial-messages "reply with the single word ok"` - confirm no
     usage error and a normal turn.
  2. Repeat with `--effort low`.
  3. Inspect the `system`/`init` record and the `result` record for any field
     reflecting the effort setting; compare the two runs.
  4. Negative control: `--effort bogus` MUST produce a usage error, proving
     the flag is parsed rather than swallowed.
- **Pass criteria:** step 1 and 2 run clean, and step 4 errors. Observing the
  setting echoed in the stream is a bonus, not a requirement - acceptance
  without error plus rejection of a bogus value is sufficient evidence that
  the flag reaches the session.
- **Effort:** ~10 min.
- **Status:** **runnable now.** claude 2.1.229 is installed.

### A-003: muse signals step-cap exhaustion distinguishably

The RFC classifies muse `run_terminal` with `terminal: "failed"` as `budget`
when the reason names a step cap, and `task` otherwise. That split needs a
reason string that is actually distinguishable.

- **Impact if false:** the `budget` FailureClass cannot be detected from muse
  output. Open Question 1 resolves to option (b): all muse run failures
  classify as `task`, and the consuming agent infers budget exhaustion from
  the fact that it set a cap. `budget` stays in the vocabulary for future
  harnesses but has no producer.
- **Experiment:** `muse exec --json --max-model-steps 1 "list every file in
  this repository one at a time using the shell, then summarize"` - a prompt
  that certainly needs more than one step. Capture the `run_terminal` record
  and read `payload.reason` verbatim.
- **Pass criteria:** the reason string is stable and names the step cap
  (contains "step" or "max_model_steps" or similar) rather than being a
  generic failure message identical to what other failures emit. Run twice to
  confirm stability.
- **Effort:** ~10 min.
- **Status:** **runnable now.** muse 0.1.0 is installed. This costs one cheap
  inference call.

## Ordering

Run A-002 and A-003 first - both are cheap, both are runnable now, and both
feed phase-1/phase-4 descriptor content. A-001 runs whenever Codex returns and
lands as a follow-up.

## Recording results

```bash
plan-db validate-assumption --plan "01-router-execution-options-and-failure-taxonomy" \
  --code A-002 --status pass --evidence "..."
```

A `fail` result requires editing the corresponding descriptor spec and the
RFC/implementation claim in the same pass - not just recording the failure.
