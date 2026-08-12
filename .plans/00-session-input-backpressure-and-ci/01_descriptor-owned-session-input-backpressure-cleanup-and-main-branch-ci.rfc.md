---
number: 01
title: "Descriptor-Owned Session Input, Backpressure Cleanup, and Main-Branch CI"
type: refactor
status: Accepted
author: Kevin Frilot
date: 2026-08-12
---

# RFC-01: Descriptor-Owned Session Input, Backpressure Cleanup, and Main-Branch CI

## Abstract

This RFC moves the persistent-session input format out of the execution layer and into
descriptor-driven interpretation. It also settles both spawn-per-turn output pumps when a consumer
abandons a backpressured stream. Finally, it configures the existing CI gate for pull requests and
non-skipped pushes to `main`, then gates release work on that check. The public runner API and the
Claude Code wire bytes remain unchanged.

## Introduction

The library has a one-way architecture: knowledge supplies harness facts, interpretation converts
those facts into values, and execution owns process lifecycle. `openSession` currently violates
that boundary by constructing Claude Code's SDK user-message JSON directly in the execution layer.
The violation stays hidden while Claude Code is the only descriptor with `sessionMode`, but a
second persistent-session harness would require another harness-specific branch in execution.

The spawn-per-turn runner has a separate abandonment defect. Its `EventQueue` applies producer
backpressure after 1,024 queued events. When the consumer breaks while a pump waits in
`EventQueue.push`, the runner cancels and signals the child but does not release that producer.
The pump cannot leave the stdout iterator.

The CI workflow runs only for `pull_request`. Repository rules require pull requests for `main`,
but the repository owner role can bypass those rules. A direct push by a bypass actor can therefore
reach `main` without running `pnpm check` in CI.

### Scope

This RFC covers:

1. A descriptor field that identifies the persistent-session input contract.
2. A pure interpretation function that encodes one session input line.
3. Execution-layer adoption of that function.
4. Deterministic abandonment coverage above the event queue high-water mark.
5. Injected stdout and stderr pipe disposal with full pump settlement.
6. CI runs for pull requests and pushes to `main`.
7. Release Please ordering after successful push CI.

This RFC does not cover:

- Persistent-session support for Codex, pi, or Muse.
- A generic JSON-template language in harness descriptors.
- Output decoding or turn-boundary changes.
- Queue size changes.
- GitHub branch protection or bypass policy changes.
- npm publication. The package remains source-public and private.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED,
MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Harness descriptor:** Immutable data under `src/knowledge/` that records verified CLI facts.
- **Session input contract:** The supported wire shape used to send one user turn to a persistent
  harness process.
- **Session input encoder:** A pure interpretation function that converts text and a declared
  session input contract into one stdin record.
- **EventQueue:** The current private bounded queue in `stream-turn.ts` that connects stdout and
  stderr pumps to the `streamTurn` consumer.
- **AsyncChannel:** The existing execution module that owns bounded producer backpressure,
  single-consumer iteration, close, and post-close push behavior.
- **Abandonment:** Early return from the `streamTurn` async iterator before its terminal `done`
  event.
- <!-- D-001 --> **Existing vocabulary:** This RFC uses the repository's current harness
  descriptor, session mode, event queue, execution layer, and CI terms without adding a separate
  domain model.

## Current State

### Persistent-session input

`HarnessDescriptor.sessionMode` contains `flags` and `idFlag`. The Claude Code descriptor declares
`--input-format stream-json`, but it does not declare which stream-json input record the runner
sends. `openSession.writeUser` constructs this Claude-specific record directly:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "<turn text>" }]
  }
}
```

The execution layer serializes the object with `JSON.stringify` and appends a newline. The current
tests confirm that prompt text reaches stdin, but they do not prove that the wire shape comes from
descriptor data or that another declared input contract can select different interpretation.

### Backpressured abandonment

`EventQueue.push` waits when the queue contains more than 1,024 events. `EventQueue.close` releases
all producer waiters. The `streamTurn` `finally` block sets `cancelled`, disarms timers, and escalates
the child process, but it does not call `EventQueue.close`. A pump already suspended in `push`
cannot observe `cancelled`, so `Promise.allSettled` never reaches its queue-closing continuation and
the stdout iterator remains undisposed.

After a released pump finishes its current chunk, it can also block on the next stdout read. This
happens when the direct child exits but a descendant keeps the pipe open. Queue closure alone cannot
settle that pending read.

The current abandonment test consumes one identity event and breaks before queue backpressure. It
proves that the child receives `SIGTERM`. It does not prove that a blocked producer is released,
that pending reads are cancelled, or that both pumps settle.

### CI coverage

`.github/workflows/ci.yml` declares only `pull_request`. Its `check` job mirrors `pnpm check` across
Biome, TypeScript, Vitest, and Bun. The release workflow does run on pushes to `main`, but it does
not run the project checks. Its current run warns because `command: manifest` is not a supported
Release Please v4 input, then fails because repository Actions are not permitted to create pull
requests.

## Proposed Changes

### Descriptor-owned input contract

<!-- D-002 --> `HarnessDescriptor.sessionMode` MUST add an `input` object with a closed `kind`
union. The initial supported value MUST identify the Claude Agent SDK user-message contract. The
Claude Code descriptor MUST declare that value. Descriptors without `sessionMode` remain `null`.

<!-- D-010 --> The type MUST use this closed-vocabulary contract:

```typescript
export type SessionInputKind = "claude-sdk-user-message";

readonly sessionMode: {
  readonly flags: readonly string[];
  readonly idFlag: string;
  readonly input: {
    readonly kind: SessionInputKind;
  };
} | null;
```

The override validator MUST treat `sessionMode.input.kind` as a closed vocabulary. An override that
uses an unknown input kind MUST fail with `OverrideRefusalError` before execution.

<!-- D-014 --> A pure validation function MUST also reject a missing or unsupported input kind from
a direct JavaScript or stale serialized descriptor. `openSession` MUST run that validation before it
spawns a process. The refusal MUST be a typed `SessionInputRefusalError` with a stable issue code.
<!-- D-024 --> Its `issue` property MUST be `"missing-session-input-contract"` or
`"unsupported-session-input-kind"`. <!-- D-023 --> The execution boundary MUST log
`session_input_refused` with harness name, session ID, and the same value as `issue`. It MUST NOT log
user text or the encoded record.

### Pure session input interpretation

A new pure function under `src/interpretation/` MUST encode session input. It MUST accept the
declared input contract and the user text. It MUST return exactly one newline-terminated record.
For `claude-sdk-user-message`, it MUST produce the current JSON shape without changing field names,
content-array structure, or framing.

The encoder MUST use `JSON.stringify`. It MUST NOT interpolate user text into raw JSON. Quotes,
backslashes, newlines, and control characters in user text MUST remain valid JSON string content.
The encoder MUST have an exhaustive arm for every `SessionInputKind`.

`openSession.writeUser` MUST delegate encoding to this interpretation function. The execution layer
MUST NOT contain Claude-specific input field names.

<!-- D-011 --> `SessionSendResult` MUST retain only the `started` and `queued` dispositions.
`send` MUST continue to throw `SessionClosedError` after close, after process death, and when an idle
stdin write fails. This RFC does not add a new send-error event or change queued-send behavior.

<!-- D-003 --> The descriptor MUST NOT carry an executable encoder callback. It also MUST NOT
introduce a generic JSON-template language. A closed contract identifier keeps descriptors as pure
data and keeps construction logic in interpretation.

### Backpressure-safe abandonment

<!-- D-004 --><!-- D-016 --> The private `EventQueue` MUST be deleted. `streamTurn` MUST use
`AsyncChannel<HarnessEvent>` as its queue and MUST close the channel in its `finally` block
immediately after it marks the turn cancelled. Closing the channel MUST release all producer
waiters before the runner waits for child exit. `AsyncChannel.push` already returns a resolved
promise without storing an event after close; the implementation MUST retain that contract.

<!-- D-008 --> `SpawnedProcess` MUST expose an injected, idempotent operation that disposes its
stdout and stderr pipes. The Node and Bun adapter MUST implement it by destroying both
`node:child_process` readable streams. The fake process MUST close both fake output channels. After
queue closure, `streamTurn` MUST dispose the pipes, preserve child signal escalation, and await both
pumps before abandonment returns. Pipe-grace completion MUST use the same settlement path.

<!-- D-018 --> The existing `abandoned` boundary event MUST remain the start signal. A new
`abandonment_settled` event MUST be emitted only after child exit and both pumps settle. It MUST
carry `turnId`, harness name, exit code, and pipe-disposal status. <!-- D-025 --> Its exact fields
MUST be `event: "abandonment_settled"`, `turnId`, `harness`, `exitCode`, and
`outputDisposed: true`. It MUST NOT carry prompt or output content.

The existing `abandoned` lifecycle event and `SIGTERM` to `SIGKILL` escalation MUST remain. Normal
completion MUST still drain all queued events and emit one terminal `done` event.

### CI on `main`

<!-- D-005 --> `.github/workflows/ci.yml` MUST retain `pull_request` and add a `push` trigger limited
to `main`. The same `check` job MUST run for both events. The comment that says CI never runs on
push MUST be updated.

A merge can therefore run CI once for the pull request head and again for the resulting `main`
commit. The second run is intentional. It covers merge-result changes and direct pushes by actors
that can bypass repository rules.

<!-- D-012 --> Pull-request runs MUST retain ref-based cancellation of obsolete runs. Push runs
MUST use a SHA-specific concurrency group so one `main` push cannot cancel another push's check.
GitHub commit-message skip instructions remain an explicit platform exception: a commit containing
`[skip ci]`, an equivalent instruction, or a `skip-checks` trailer does not start a push workflow.

<!-- D-013 --><!-- D-015 --> The standalone release workflow MUST be removed. Its Release Please
job MUST move into the CI workflow. The job MUST run only for pushes to `main`, MUST declare
`needs: check`, and MUST receive its current write permissions at job scope. A failed or skipped
check MUST prevent tagging and GitHub release creation.

<!-- D-017 --> The Release Please step MUST remove the unsupported `command: manifest` input and
continue to use the built-in `GITHUB_TOKEN`. The repository Actions workflow setting MUST permit
pull-request creation before Phase 3 lands. The plan MUST NOT add a personal access token or another
long-lived secret.

<!-- D-006 --> This change MUST NOT alter repository rules, required checks, or bypass actors. A
push-triggered workflow detects failure after the commit reaches `main`; it does not replace a
pre-merge required check.

## Error Handling

- **Unknown session input kind:** TypeScript exhaustiveness MUST reject typed source descriptors.
  JSON overrides MUST fail during override parsing. Direct malformed descriptors MUST fail with
  `SessionInputRefusalError` before spawn.
- **Session input serialization:** The supported record contains JSON-compatible literals and user
  text. Serialization MUST remain total for all JavaScript strings. Idle stdin write failures MUST
  continue to throw `SessionClosedError`.
- **Abandoned queue:** Queue close and pipe disposal MUST be idempotent. Pumps released after close
  MUST settle without delivering more events to the abandoned consumer.
- **CI failure on `main`:** GitHub Actions MUST mark the `main` run failed. Recovery remains a new
  corrective pull request or an explicit revert. The release job MUST remain skipped.

## Migration Strategy

1. Add the descriptor type and Claude Code descriptor value.
2. Add direct-descriptor validation and the pure encoder with test-first coverage.
3. Route `openSession` through the validated encoder and retain its end-user session test.
4. Add deterministic high-water and held-pipe abandonment reproductions.
5. Close the queue, dispose the injected output pipes, and await both pumps.
6. Add the `main` push trigger and event-specific concurrency.
7. Move Release Please behind the successful push check.
8. Enable Actions pull-request creation and remove the unsupported Release Please input.
9. Run the complete Node and Bun gate before landing.
10. After merge, verify that CI records a successful `push` run for the merged `main` SHA before any
   release job runs.

<!-- D-009 --> No staged runtime compatibility period is required. The runner API and emitted
Claude Code stdin bytes remain the same. `HarnessDescriptor` is an exported source API, so custom
session-capable descriptors MUST add `input: { kind: "claude-sdk-user-message" }` during the same
source update. The package is private and is not published to npm.

<!-- D-007 --> `verifiedAgainst` MUST remain at the currently verified CLI version unless the
implementation separately re-runs the capability tripwires against a newer Claude Code release.
Moving an already verified fact into descriptor data does not by itself authorize a version bump or
fixture recapture.

## Security Considerations

The session input encoder processes untrusted prompt text. It MUST preserve `JSON.stringify` as the
encoding boundary so prompt content cannot create extra NDJSON records or change envelope fields.
The refactor MUST NOT log the encoded record or prompt content. Existing position-based prompt
redaction and session lifecycle logging remain unchanged.

Closing the queue and disposing output pipes reduces process and memory retention after a consumer
abandons work. Cleanup MUST NOT skip the existing child-process escalation, because pipe disposal
does not stop a harness that continues to run.

The check job MUST retain read-only `contents` permission. The release job keeps the write
permissions that the standalone release workflow already has, but only at job scope and only after
the check succeeds. The workflow MUST NOT add secrets. A `push` run executes repository code after
it has reached `main`, so repository rule protection remains the primary control against unreviewed
code.

## Risk Assessment

| Risk | Severity | Mitigation | Rollback |
|---|---|---|---|
| Encoder output differs by one field or newline | High | Exact byte-level tests against the current record | Restore inline encoding while keeping the failing fixture |
| Descriptor override accepts an unsupported kind | Medium | Closed-union source type plus override-refusal test | Remove the override surface for the new field |
| Channel close drops events during normal completion | High | Separate normal drain and abandonment tests | Revert the cancellation close while retaining the reproduction |
| Pipe disposal hides a real pump error | High | Preserve pump rejection capture and test disposal separately from malformed output | Revert pipe disposal while retaining the reproductions |
| Released pump stores events after close | Medium | Reuse AsyncChannel's post-close no-op and assert pump settlement | Add a per-line cancellation guard if the reproduction exposes remaining work |
| Duplicate pull request and `main` CI runs use more minutes | Low | Limit `push` to `main`; keep one shared job | Remove only the push trigger |
| A failing direct push leaves `main` red | Medium | Preserve pull-request rule; use corrective PR or revert | No automated rollback in this change |
| Release job runs before or without checks | High | Same-workflow `needs: check` plus push-only condition | Restore the standalone workflow only with an equivalent success gate |
| Release Please cannot create its pull request | Medium | Remove the unsupported input and verify the repository Actions setting before merge | Keep release job gated and correct the setting before rerun |

## Alternatives Considered

### Keep the wire shape in `openSession`

Rejected because execution would need a harness-specific branch for every future persistent-session
input protocol.

### Put an encoder function in each descriptor

Rejected because descriptors are immutable pure data. Executable callbacks would merge knowledge
and interpretation and would not be representable in JSON overrides.

### Add a generic JSON-template descriptor

Rejected because one supported input contract does not justify a template AST, placeholder rules,
or recursive substitution logic. A closed contract identifier can expand only when a second real
wire shape exists.

### Set `cancelled` without closing the queue

Rejected because a pump suspended inside `push` cannot observe the flag.

### Close only the queue

Rejected because a released pump can block again on its next output read while a descendant holds
the pipe open. The runner needs injected pipe disposal and explicit pump settlement.

### Run CI only on pull requests

Rejected for this plan because repository-role bypasses and merge-result differences leave an
uncovered `main` state.

## Testing Strategy

Behavior-bearing changes follow test-first development.

1. `test/interpretation/session-input.test.ts` MUST assert the exact newline-terminated Claude SDK
   user-message record. It MUST include quotes, backslashes, and embedded newlines in the text.
2. `test/knowledge/overrides.test.ts` MUST assert that an unknown
   `sessionMode.input.kind` override is refused.
3. `test/execution/open-session.test.ts` MUST assert the parsed complete stdin envelope, not only
   substring presence. It MUST also prove malformed direct descriptors fail before spawn.
4. `test/execution/runner-hardening.test.ts` MUST reproduce abandonment after more than 1,024
   decoded events. The fake MUST expose a deterministic producer-blocked barrier and pipe-disposal
   state. The test MUST assert child signalling, generator return, and both-pump settlement without
   wall-clock sleeps.
5. `AsyncChannel` tests MUST pin producer release on close and post-close push as a no-op.
6. A real-adapter integration test MUST hold a descendant pipe open and prove pipe disposal settles
   the turn. The test MUST run under both Vitest on Node and `bun test`.
7. Existing clean completion, crash-tail, and pipe-grace behavior MUST remain green.
8. `pnpm check` MUST pass. This runs Biome, TypeScript, Vitest, and Bun.
9. The landed non-skipped `main` SHA MUST have a successful GitHub Actions run whose event is `push`
   and whose workflow is `CI`.
10. The release job MUST be skipped on pull requests and when `check` fails, and ordered after a
    successful `check` on a `main` push. A successful run MUST create or update the Release Please
    pull request without the unsupported-input warning.

The test fake MAY gain read-only producer and iterator lifecycle state. Production process
interfaces change only for the pipe-disposal operation required by the runtime guarantee.

## Implementation Plan

Phase 1 moves the persistent-session input contract into knowledge and interpretation, then routes
execution through it. Phase 2 reproduces and fixes backpressured abandonment. Phase 3 adds and
verifies `main` push CI coverage. Detailed milestones and landing gates will be generated during the
planner DECOMPOSE stage.

## Open Questions

None. The user authorized the planner's recommended answers for the remaining decisions. The scope
includes all 3 raised findings plus release ordering required by push CI. Branch protection changes
remain explicitly out of scope.

## References

### Normative

- [`AGENTS.md`](../../AGENTS.md) - Repository architecture, invariants, and full gate.
- [`src/knowledge/descriptor.ts`](../../src/knowledge/descriptor.ts) - Descriptor contract.
- [`src/knowledge/claude-code.ts`](../../src/knowledge/claude-code.ts) - Verified Claude Code
  session facts.
- [`src/execution/open-session.ts`](../../src/execution/open-session.ts) - Current session input
  construction.
- [`src/execution/stream-turn.ts`](../../src/execution/stream-turn.ts) - Current event queue and
  abandonment behavior.
- [Claude Code Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -
  Official SDK user-message contract.

### Informative

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage) - `--input-format`
  and persistent print-mode flags.
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) -
  `push` and branch-filter syntax.
- [Node.js streams](https://nodejs.org/api/stream.html) - readable destruction and async iterator
  disposal.
- [Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat) - `node:stream` and
  `node:child_process` compatibility boundary.
- [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) -
  cancellation and event-specific concurrency groups.
- [GitHub Actions skip instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs) -
  commit messages that suppress `push` and `pull_request` workflows.
- [Release Please](https://github.com/googleapis/release-please) - release PR, tag, and GitHub release
  lifecycle.
