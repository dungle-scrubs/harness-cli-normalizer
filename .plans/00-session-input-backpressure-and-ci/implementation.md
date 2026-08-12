# Session Input, Pump Settlement, and Main-Branch CI - Implementation Plan

## Execution Protocol

A progress report exists at
`.plans/00-session-input-backpressure-and-ci/progress-report.md`. It lists every required behavior
for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run
   `npx tsx /Users/kevin/dev/skills/skills/engineering/planner/scripts/plan-db.ts check-progress --plan 00-session-input-backpressure-and-ci`
   and read that milestone's progress-report section. Its current-cutoff checkboxes are the spec.
2. Check each box as its behavior is completed, not at the end.
3. A milestone is not done until every current-cutoff checkbox under it is checked.
4. If a behavior is missing from the report, add it before implementing it.
5. Never declare a phase complete without updating the current-focus marker and Summary.
6. Deferred follow-up and superseded or obsolete checklist debt do not count as current blockers.
7. Move a fully deferred section under Deferred follow-up. Do not leave an empty active section.
8. Every `FP-<number>` reference must have a concrete progress-report section and checkboxes.

## 0. Hard Dependencies

None.

## 1. Architecture

The change preserves the repository's one-way dependency:

```text
knowledge                         interpretation                 execution
sessionMode.input.kind  ->  validate and encode input  ->  write and manage process
```

<!-- D-002 --><!-- D-003 --> The knowledge layer declares a closed session input contract. The interpretation layer validates
that contract and encodes one stdin record. The execution layer resolves the contract before spawn,
writes encoded records, and never names Claude Code message fields.

<!-- D-004 --><!-- D-008 --><!-- D-016 --> The execution layer uses one queue module. `streamTurn` deletes its private `EventQueue` and uses
`AsyncChannel<HarnessEvent>`, which already owns single-consumer iteration, bounded producer
backpressure, close, and post-close push behavior. `SpawnedProcess` adds one idempotent pipe-disposal
operation. The Node and Bun adapter hides `node:stream` destruction behind that interface.

<!-- D-005 --><!-- D-012 --><!-- D-013 --><!-- D-015 --> The CI workflow becomes the single orchestration point for checks and releases. Pull requests run
only `check`. Non-skipped pushes to `main` run `check`, then run Release Please through `needs`.
Push concurrency is SHA-specific. Pull-request concurrency remains ref-specific and cancellable.

### Scope

<!-- D-001 --> This plan uses the repository's existing descriptor, session mode, execution, and CI
vocabulary without a separate domain model. It changes persistent-session input declaration,
spawn-per-turn abandonment cleanup, and CI plus release ordering. It does not add persistent
sessions to Codex, pi, or Muse. It does not change output decoding, turn boundaries, queue water
marks, GitHub repository rules, npm publication, or the Claude Code version anchor and captured
fixtures.

### Session Input Contract

<!-- D-009 --><!-- D-010 --> The exported descriptor migration adds this required field to every
non-null `sessionMode`:

```typescript
export type SessionInputKind = "claude-sdk-user-message";

readonly input: {
  readonly kind: SessionInputKind;
};
```

The pure encoder returns one JSON record followed by one LF. For
`"claude-sdk-user-message"`, the record is exactly:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<user text>"}]}}
```

`JSON.stringify` remains the only text-to-JSON boundary. The placeholder above represents one JSON
string value, not raw interpolation. Quotes, backslashes, line breaks, and control characters must
remain inside that value and must not create another input record.

### Key Constraints

| Constraint | Impact |
|---|---|
| Knowledge and interpretation remain pure | Session validation and encoding cannot import runtime modules or read environment state |
| Descriptors remain pure data | `sessionMode.input.kind` is a closed literal, never a callback |
| Node and Bun use the same execution adapter | Pipe disposal must use the `node:child_process` readable streams supported by both runtimes |
| Prompt content never enters logs | Refusal and settlement events carry identifiers and issue state only |
| Normal completion loses no events | Cancellation close and pipe disposal run only through the terminal cleanup path |
| <!-- D-007 --> `verifiedAgainst` is a verified-version anchor | Moving an existing fact does not bump the Claude Code version or recapture fixtures |
| <!-- D-017 --> Release Please writes generated release files | Agents never edit `CHANGELOG.md` manually, and the workflow uses only `GITHUB_TOKEN` |

### Seams and Target Files

| Seam | Target | Responsibility |
|---|---|---|
| Session input data | `src/knowledge/descriptor.ts`, `src/knowledge/claude-code.ts` | Declare the supported input contract as frozen data |
| Session input interpretation | new `src/interpretation/session-input.ts` | Validate direct descriptors and encode exact newline-delimited input |
| Override validation | `src/knowledge/overrides.ts` | Refuse unknown `sessionMode.input.kind` values from JSON |
| Session execution | `src/execution/open-session.ts` | Resolve input before spawn and write only encoded records |
| Backpressure queue | `src/execution/channel.ts`, `src/execution/stream-turn.ts` | Own one bounded channel contract and close it on every terminal path |
| Process output disposal | `src/execution/deps.ts`, `src/execution/node-deps.ts`, test fakes | Cancel pending stdout and stderr reads through an injected adapter operation |
| CI and release ordering | `.github/workflows/ci.yml` | Check pull requests and main pushes, then release only checked main state |

The new `session-input.ts` file needs a module comment. It must state that the file owns pure
validation and encoding for descriptor-declared persistent-session input. Existing execution files
already have module comments and must update them when their responsibility changes.

### Observability

<!-- D-023 --><!-- D-024 --> A malformed direct session input contract emits
`session_input_refused` before spawn. The event carries harness name, session ID, and `issue` set to
`"missing-session-input-contract"` or `"unsupported-session-input-kind"`. It carries no prompt or
encoded record.

<!-- D-018 --> Abandonment keeps the existing `abandoned` start event. It emits
`abandonment_settled` only after the child exits and both pumps settle. The completion event carries
<!-- D-025 --> `event`, `turnId`, harness name, exit code, and `outputDisposed: true`. Existing
`spawn`, `stall`, `exit`, and `pipesOpenAtExit` evidence remains.

The GitHub Actions run is the inspection surface for Phase 3. `gh run view` must show the event,
checked SHA, `check` result, and release job disposition. The failed Release Please log remains the
before-state evidence for the repository-setting correction.

## 2. Validated Runtime Behavior

<!-- D-008 --> The A-001 spike passed under Node 24.15.0 and Bun 1.3.14. After the direct child
exited with code 7, descendant-held stdout and stderr reads stayed pending until both readable
streams were destroyed. Repeated destruction was safe and both reads settled within 1 second.
Node rejected the pending reads while Bun fulfilled them, so cleanup depends only on settlement and
must normalize the runtime-specific completion result before classifying a pump failure.

## 3. Phases

### Phase 1: Descriptor-owned session input

<!-- D-009 --><!-- D-010 --><!-- D-014 -->
**Goal:** Persistent-session input bytes come from descriptor-driven pure interpretation, and
malformed direct descriptors fail before process spawn.

**Gate from previous:** RFC-01 is accepted. The current `pnpm check` baseline passes 161 tests.

#### M1: Session input contract and pure encoder

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Testing:** test-first
- **Observability:** required (`session_input_refused` pre-spawn event without content)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `sessionMode.input.kind`, override parsing, session input validation, and
     session input encoding.
  2. RED: Add an interpretation test for the exact newline-terminated Claude SDK user-message
     record, including quotes, backslashes, embedded newlines, and control characters.
  3. GREEN: Add `SessionInputKind`, the required descriptor field, Claude Code data, and the minimal
     pure encoder.
  4. RED: Add override and direct-descriptor tests for missing and unsupported input kinds.
  5. GREEN: Add the closed override vocabulary and typed `SessionInputRefusalError` validation with
     the exact D-024 issue values.
  6. REFACTOR: Export the new interpretation module and keep the exhaustive contract arm local to
     `session-input.ts`.

#### M2: `openSession` adoption

<!-- D-011 -->
- **Dependencies:** M1
- **Effort:** S (1-3d)
- **Testing:** test-first
- **Observability:** required (pre-spawn refusal plus unchanged session lifecycle correlation)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `openSession`, injected spawner calls, stdin records, and boundary logs.
  2. RED: Strengthen the end-user session test to parse and compare the full stdin envelope.
  3. GREEN: Resolve the session input contract before spawn and delegate each write to the encoder.
  4. RED: Prove a malformed direct descriptor throws the typed refusal, logs
     `session_input_refused`, and makes zero spawn calls.
  5. GREEN: Add the pre-spawn execution boundary and preserve `SessionSendResult` and
     `SessionClosedError` behavior.
  6. REFACTOR: Remove every Claude-specific input field name from `open-session.ts`.

#### Gate 1 to 2

- [x] Phase 1 tests pass in Vitest and Bun.
- [x] Purity and no-chat-import gates pass.
- [x] Exact Claude stdin bytes match the Session Input Contract above.
- [x] `verifiedAgainst` and captured harness fixtures are unchanged.
- [x] `review-changes` reports no unresolved findings.
- [x] Phase 1 pull request is merged to `main`.

### Phase 2: Full abandonment settlement

**Goal:** Early consumer return releases blocked producers, cancels pending output reads, stops the
child, and returns only after both pumps settle.

**Gate from previous:** Phase 1 is merged. A-001 passed under Node 24.15.0 and Bun 1.3.14.

#### M3: One backpressure channel and deterministic reproduction

- **Dependencies:** Phase 1
- **Effort:** S (1-3d)
- **Testing:** test-first
- **Observability:** required (existing `abandoned` start event and deterministic lifecycle state)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `AsyncChannel.close`, producer waiters, post-close push, and `streamTurn`
     consumer abandonment.
  2. RED: Add focused `AsyncChannel` tests for producer release on close and post-close push as a
     no-op.
  3. GREEN: Change only what those channel contract tests require.
  4. RED: Extend the fake output source with a deterministic producer-blocked barrier and reproduce
     abandonment after more than 1,024 decoded events.
  5. GREEN: Replace private `EventQueue` with `AsyncChannel<HarnessEvent>` and close it in the
     `streamTurn` terminal cleanup path.
  6. REFACTOR: Delete the duplicate queue implementation and constants from `stream-turn.ts`.

#### M4: Injected pipe disposal and pump join

- **Dependencies:** M3, A-001
- **Effort:** M (3-7d)
- **Testing:** test-first
- **Observability:** required (`abandonment_settled` after child exit and both pumps settle)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `SpawnedProcess` pipe disposal, Node/Bun adapter streams, fake process output,
     child escalation, pump promises, and pipe-grace completion.
  2. RED: Add a fake-driven held-pipe test that proves queue close alone leaves a pending read.
  3. GREEN: Add the idempotent injected pipe-disposal operation to the interface and both adapters.
  4. RED: Require `streamTurn` abandonment to await stdout and stderr pump settlement and emit
     the exact D-025 `abandonment_settled` boundary record after settlement.
  5. GREEN: Join both pumps in terminal cleanup while preserving `SIGTERM` to `SIGKILL` escalation.
  6. RED: Add a real-adapter test where a descendant holds output open after direct-child exit.
  7. GREEN: Dispose both readable streams so the test completes in Node and Bun without a wall-clock
     timeout.
  8. REFACTOR: Share one terminal cleanup sequence across abandonment and pipe-grace completion,
     and classify runtime-specific disposal settlement without hiding unrelated pump failures.

#### Gate 2 to 3

- [x] High-water abandonment test proves the producer blocked before consumer return.
- [x] Held-pipe tests prove both pumps settle under fake, Node, and Bun adapters.
- [x] Normal completion still drains every event and emits one `done` event.
- [x] Crash tail, stall, signal escalation, and pipe-grace tests remain green.
- [x] Boundary logs contain `abandoned` then `abandonment_settled` with the same `turnId`.
- [x] `review-changes` reports no unresolved findings.
- [x] Phase 2 pull request is merged to `main`.

### Phase 3: Main push CI and checked releases

<!-- D-006 -->
**Goal:** Non-skipped `main` pushes run the full gate, each push keeps its own run, and Release
Please runs only after a successful check.

**Gate from previous:** Phases 1 and 2 are merged. Current GitHub Actions settings are captured.

#### M5: CI trigger, concurrency, and Release Please repair

- **Dependencies:** Phase 2
- **Effort:** S (1-3d)
- **Testing:** test-after (workflow configuration is orchestration glue; GitHub parses and executes
  the integration only after the branch is pushed)
- **Observability:** required (GitHub run event, SHA, job graph, conclusions, and Release Please log)
- **Prototyping:** none
- **Tasks:**
  1. Update CI triggers for `pull_request` and `push` limited to `main`.
  2. Keep pull-request cancellation by ref and give push runs SHA-specific concurrency.
  3. Move the Release Please job into CI with push-only `if`, `needs: check`, and job-scoped write
     permissions. Remove the standalone release workflow.
  4. Remove the unsupported `command: manifest` input. Keep the manifest and config files as the
     action's default inputs.
  5. Enable the repository Actions setting that permits pull-request creation with `GITHUB_TOKEN`.
  6. Verify locally: `pnpm check` passes and the workflow diff contains no secret or wildcard trigger.
  7. Verify on the Phase 3 pull request: GitHub parses the workflow, runs `check`, and skips release.
  8. Verify after merge: the merged SHA has a `push` CI run, `check` succeeds first, and Release
     Please creates or updates its pull request without the prior warning or permission failure.

#### Gate 3 to complete

- [ ] Phase 3 pull-request `check` succeeds and release is skipped.
- [ ] Phase 3 merge SHA gets a separate successful `push` run.
- [ ] No earlier `main` push run is cancelled by the Phase 3 push concurrency group.
- [ ] Release Please starts only after `check` and can create or update its pull request.
- [ ] The workflow has no `command: manifest`, PAT, new secret, or expanded branch trigger.
- [ ] `review-changes` reports no unresolved findings.
- [ ] Phase 3 pull request is merged to `main`.

## 4. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| Claude input bytes change during relocation | high | low | Exact byte tests and end-user session test | Phase 1 implementer |
| Exported descriptor migration breaks a source consumer | medium | low | Compile all descriptors and document the required field | Phase 1 implementer |
| Pipe disposal hides a real pump error | high | medium | Preserve pump rejection capture and test malformed output separately | Phase 2 implementer |
| Cleanup returns before one pump settles | high | medium | Explicit pump join plus completion event | Phase 2 implementer |
| Shared channel drops normal events | high | low | Normal drain and slow-consumer regression tests | Phase 2 implementer |
| GitHub skip instruction suppresses a main run | medium | low | Document platform exception and prohibit skip instructions in plan commits | Phase 3 implementer |
| Release Please tags unchecked state | high | low | Same-workflow `needs: check` | Phase 3 implementer |
| Release Please cannot create its pull request | medium | high | Correct repository setting and verify actual post-merge run | Phase 3 implementer |

## 5. Escape Hatches

1. **If pipe disposal corrupts normal completion:** restrict disposal to abandonment and pipe-grace
   terminal paths. Keep explicit pump joining.
2. **If Release Please cannot run safely in the CI workflow:** retain it as a separate workflow only
   after adding a success-gated `workflow_run` design. Do not restore parallel push execution.
3. **If repository policy cannot permit `GITHUB_TOKEN` pull-request creation:** stop Phase 3 before
   merge. Do not add a PAT without a separate user-approved credentials decision.

## 6. Landing Strategy

| Field | Value |
|---|---|
| Merge target | <!-- D-019 --> `main` |
| Branch model | <!-- D-020 --> One branch per phase |
| PR cadence | <!-- D-020 --> One pull request per phase |
| Independent reviewer | <!-- D-021 --> `review-changes` at every phase boundary |
| Ship mechanism | <!-- D-022 --> GitHub pull request, CI, merge, then push-run verification |

Suggested branches:

1. `feat/descriptor-owned-session-input`
2. `fix/settle-abandoned-pumps`
3. `ci/check-main-before-release`

`complete` means all 3 pull requests are merged, the Phase 3 `main` push check succeeds, and Release
Please runs after that check without its current configuration or permission failure.

## 7. Progress Report Accounting

The progress report at `.plans/00-session-input-backpressure-and-ci/progress-report.md` separates
current-cutoff blockers, accepted follow-up, and superseded items. Every current milestone behavior
remains a blocker until its checkbox is checked. No future-phase placeholder is allowed without a
concrete section.

## 8. Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:bun
pnpm check
bun run smoke:seven  # only if verifiedAgainst changes; this plan says it must not
gh run list --repo dungle-scrubs/harness-cli-normalizer --workflow CI
gh run view <run-id> --repo dungle-scrubs/harness-cli-normalizer
gh api repos/dungle-scrubs/harness-cli-normalizer/actions/permissions/workflow
```

## 9. Decisions

Canonical decisions are in `.plans/00-session-input-backpressure-and-ci/plan.db`.

```bash
npx tsx /Users/kevin/dev/skills/skills/engineering/planner/scripts/plan-db.ts \
  query-decisions --plan "00-session-input-backpressure-and-ci"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.

## 10. References

- [`src/knowledge/descriptor.ts`](../../src/knowledge/descriptor.ts) - current exported descriptor
  shape.
- [`src/execution/open-session.ts`](../../src/execution/open-session.ts) - current inline session
  input record.
- [`src/execution/stream-turn.ts`](../../src/execution/stream-turn.ts) - current private queue and
  abandonment cleanup.
- [`spike-report.md`](spike-report.md) - Node and Bun pipe-disposal evidence captured before
  consolidation.
- [Claude Code streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
  - official SDK user-message contract.
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
  - `push`, branch filters, job conditions, and dependencies.
- [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  - cancellation and concurrency-group behavior.
- [GitHub Actions skip instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)
  - the explicit commit-message exception to push CI.
- [Node streams](https://nodejs.org/api/stream.html) and
  [Bun Node compatibility](https://bun.sh/docs/runtime/nodejs-compat) - shared readable-stream
  disposal boundary.
