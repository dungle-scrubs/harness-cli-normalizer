# Session Input, Pump Settlement, and Main-Branch CI - Progress Report

> Generated from the consolidated implementation plan. This is the canonical source of truth for
> what is done and what remains. Update each checkbox as its behavior is implemented. Do not mark a
> milestone complete until every current-cutoff checkbox under it is checked.

> Current focus: Phase 1 - Descriptor-owned session input, M1

## Phase 1: Descriptor-owned session input

### M1: Session input contract and pure encoder

Source: `src/knowledge/descriptor.ts`, `src/knowledge/claude-code.ts`,
`src/knowledge/overrides.ts`, `src/knowledge/index.ts`, `src/interpretation/index.ts`

- [x] `SessionInputKind` is the closed literal union `"claude-sdk-user-message"`.
- [x] Every non-null `sessionMode` requires `input.kind`, while descriptors without session mode
      remain `null`.
- [x] The Claude Code descriptor declares `input.kind` without changing `verifiedAgainst`, flags,
      or captured fixtures.
- [x] JSON overrides accept the supported `sessionMode.input.kind` value through recursive merge.
- [x] JSON overrides refuse every unsupported input kind with `OverrideRefusalError`.
- [x] Direct descriptors with a missing or unsupported contract fail with `SessionInputRefusalError`
      and the exact D-024 `issue` value.
- [x] The pure encoder emits the exact Claude SDK user-message record plus one LF for quotes,
      backslashes, embedded newlines, and control characters.
- [x] The new interpretation module is exported and passes the purity and no-chat-import gates.

### M2: `openSession` adoption

Source: `src/execution/open-session.ts`, `test/execution/open-session.test.ts`,
`test/execution/session-hardening.test.ts`

- [x] `openSession` validates the descriptor input contract before calling the injected spawner.
- [x] A refused contract logs the exact `session_input_refused` boundary record without prompt or
      encoded content.
- [x] A refused contract makes zero spawn calls and throws `SessionInputRefusalError`.
- [x] Idle and queued sends both write records through the pure session input encoder.
- [x] Session tests parse and compare the complete stdin envelope and newline framing.
- [x] `started` and `queued` dispositions plus all existing `SessionClosedError` cases remain
      unchanged.
- [x] `open-session.ts` contains no Claude-specific input field names.

## Phase 2: Full abandonment settlement

### M3: One backpressure channel and deterministic reproduction

Source: `src/execution/channel.ts`, `src/execution/stream-turn.ts`,
`test/execution/runner-hardening.test.ts`, `test/execution/fakes.ts`

- [ ] `AsyncChannel.close()` releases every producer blocked above the high-water mark.
- [ ] `AsyncChannel.push()` after close resolves without storing or delivering the event.
- [ ] Existing single-consumer, high-water, and low-water behavior remains unchanged.
- [ ] `streamTurn` uses `AsyncChannel<HarnessEvent>` and the private `EventQueue` is removed.
- [ ] A deterministic test proves a producer is blocked after more than 1,024 decoded events before
      the consumer returns early.
- [ ] Consumer abandonment closes the channel before waiting for child-process settlement.
- [ ] Normal and slow-consumer completion still drains every event and emits exactly one `done`.

### M4: Injected pipe disposal and pump join

Source: `src/execution/deps.ts`, `src/execution/node-deps.ts`,
`src/execution/stream-turn.ts`, `test/execution/fakes.ts`,
`test/execution/runner-hardening.test.ts`

- [ ] `SpawnedProcess.disposeOutput()` is an idempotent, injected output-disposal operation.
- [ ] The shared Node and Bun adapter destroys both child stdout and stderr readable streams.
- [ ] `FakeProcess.disposeOutput()` closes both fake output channels and exposes disposal state.
- [ ] A fake held-pipe test proves queue closure alone does not settle a later pending read.
- [ ] Terminal cleanup closes the channel, disposes output, preserves signal escalation, and awaits
      stdout plus stderr pumps before it returns.
- [ ] A descendant-held-pipe integration test settles under both Vitest on Node and `bun test`.
- [ ] Disposal-caused Node rejection and Bun fulfillment are both treated as settlement, while
      unrelated pump failures remain visible.
- [ ] `abandonment_settled` logs the exact D-025 fields only after child exit and both pumps settle.
- [ ] Normal completion, crash tail, stall, signal escalation, and pipe-grace behavior remain green.
- [ ] Early consumer return leaves no blocked producer, pending output iterator, or live direct
      child.

## Phase 3: Main push CI and checked releases

### M5: CI trigger, concurrency, and Release Please repair

Source: `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`release-please-config.json`, `.release-please-manifest.json`, `package.json`

- [ ] CI triggers on pull requests and pushes limited to `main`, with no wildcard push branch.
- [ ] Pull-request runs keep ref-based cancellation and push runs use SHA-specific concurrency.
- [ ] The same `check` job runs the full pnpm, TypeScript, Vitest, and Bun gate for both events.
- [ ] Release Please is a push-only job in CI with `needs: check`.
- [ ] Check permissions remain read-only and release write permissions are scoped to the release
      job.
- [ ] The standalone `.github/workflows/release.yml` is removed.
- [ ] Release Please uses its manifest defaults and has no unsupported `command: manifest` input.
- [ ] Repository Actions may create pull requests with `GITHUB_TOKEN`, with no PAT or new secret.
- [ ] The Phase 3 pull-request run succeeds and reports the release job as skipped.
- [ ] The merged SHA gets its own successful `push` run and no earlier main-push check is cancelled.
- [ ] Release Please runs only after that check and creates or updates its pull request without the
      prior unsupported-input warning or permission failure.

## Deferred follow-up

None.

## Superseded or obsolete checklist debt

None.

## Summary

- Total features: 43
- Completed: 15
- Remaining: 28
- Current cutoff blockers: 28
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
