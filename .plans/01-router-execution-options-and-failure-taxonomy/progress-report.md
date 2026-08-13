# Router execution options and failure taxonomy - Progress Report

> Generated from the implementation plan at CONSOLIDATE. This is the canonical
> source of truth for what is done and what remains. Update this file as
> features are implemented - never mark a milestone complete until every
> current-cutoff checkbox under it is checked.

> Current focus: Phase 6 - Verification and docs / M15

## Phase 1: Option specs as data

### M1: Option spec vocabulary in the descriptor
Source: `implementation.md` Phase 1 M1; RFC section 1.2

- [x] `TURN_OPTION_KEYS` exported as a closed, frozen 7-member tuple in `TURN_OPTION_KEYS` order
- [x] `DISCOVERY_FACETS` exported as a closed, frozen 4-member tuple
- [x] `OptionRender` union covers `flag-value`, `config-kv`, `flag-list` and nothing else
- [x] `TurnOptionSpec` union covers `enum`, `effort`, `selector`, `toggle`, `integer`, `discovery`
- [x] `turnOptions` field added to `HarnessDescriptor` as `Partial<Record<TurnOptionKey, TurnOptionSpec>>`
- [x] A spec with `resumeRender` omitted resolves to the same render as `render`
- [x] A spec with `resumeRender: null` resolves as unexpressible on resume
- [x] Module comment states why the option-key vocabulary is closed

### M2: Per-harness tables, field removals, pin bump
Source: `implementation.md` Phase 1 M2; RFC section 1.3 and section 6 verification table

- [x] claude declares `effort` rendering `--effort`
- [x] claude declares `discovery.extensions` and `discovery.skills` on `--setting-sources project`
- [x] claude declares NO `discovery.tools` and NO `discovery.instructionFiles`
- [x] codex declares `effort` as `-c model_reasoning_effort=`
- [x] codex declares `sandbox` with values `read-only`, `workspace-write`, `danger-full-access`
- [x] codex `sandbox` carries `default: "workspace-write"`
- [x] codex `sandbox` carries `resumeRender: null` (A-001 deferred)
- [x] codex `launch.baseFlags` no longer contains `--sandbox workspace-write`
- [x] pi declares `effort` as `--thinking`
- [x] pi declares `provider` as `--provider`
- [x] pi declares all four discovery facets on `-nt` / `-nc` / `-ne` / `-ns`
- [x] muse declares `effort` as `--reasoning-effort`
- [x] muse declares `write` as `--disable-write` with `polarity: "disables"`
- [x] muse declares `shell` as `--disable-shell` with `polarity: "disables"`
- [x] muse declares `maxSteps` as `--max-model-steps` with range `[1, 10000]`
- [x] `vocabulary.effortFlag` removed from the descriptor type and all four descriptors
- [x] `provider` removed from the descriptor type and all four descriptors
- [x] `discoveryDisableFlags` removed from the descriptor type and all four descriptors
- [x] `providerFlagOf` and `discoveryDisableFlagsOf` removed from `dimensions.ts` with their tests
- [x] claude `verifiedAgainst` bumped `2.1.227` -> `2.1.229`
- [x] Stale "effort is an in-session command" comment deleted
- [x] claude descriptor comment records why `instructionFiles` refuses (the `--bare` auth trade-off)
- [x] claude descriptor comment records the A-002 caveat (claude warns and silently degrades an unknown effort)
- [x] muse descriptor header corrected: exits 0 on task failure, 1 on step exhaustion
- [x] `dimensions-coverage.test.ts` updated for the removed fields

## Phase 2: Rendering and typed refusals

### M3: `RefusalIssue` and the structured `ArgvRefusalError`
Source: `implementation.md` Phase 2 M3; RFC section 1.5

- [x] `REFUSAL_ISSUES` exported as a closed 11-member tuple
- [x] `ArgvRefusalError.issue` narrowed from `string` to `RefusalIssue`
- [x] `ArgvRefusalError` carries `harness`
- [x] `ArgvRefusalError` carries optional `option` and `facet`
- [x] `ArgvRefusalError` carries `supported`
- [x] Every pre-existing refusal site still produces its original issue value
- [x] Every refusal that names a dimension has a non-empty `supported`
- [x] Every refusal message names an alternative, not only a negation
- [x] One shared helper builds the message from the structured fields so the two cannot drift

### M4: `renderTurnOptions`
Source: `implementation.md` Phase 2 M4; RFC section 1.4

- [x] New file `src/interpretation/turn-options.ts` with a module comment stating why it is not part of `argv.ts`
- [x] Options render in `TURN_OPTION_KEYS` order regardless of caller field order
- [x] Discovery facets render in `DISCOVERY_FACETS` order
- [x] claude `{extensions: false, skills: false}` emits `--setting-sources project` exactly once
- [x] claude `{extensions: false}` alone emits it once
- [x] claude with neither facet emits it not at all
- [x] De-duplication is by exact rendered token sequence, first occurrence winning
- [x] Two options sharing a flag with different values are both kept
- [x] A `disables` facet set `true` emits nothing
- [x] A `disables` facet omitted emits nothing
- [x] `discovery: {}` behaves identically to omitted `discovery`
- [x] `effort` validated via the existing `validateEffort(h, effort, opts.model)`
- [x] codex per-model effort ladders apply through that path
- [x] `provider` validated against `CLEAN_SELECTOR`
- [x] `maxSteps` rejects `0`, `1.5`, `NaN`, `Infinity`, `10001`, and non-numbers with `invalid-option-value`
- [x] `enum` default renders on the `launch` phase
- [x] `enum` default does NOT render on the `resume` phase
- [x] `resumeRender: null` refuses on the `resume` phase with `unsupported-on-resume`
- [x] `config-kv` renders exactly two tokens, `flag` then `key=value`
- [x] `config-kv` values are TOML-quoted
- [x] `config-kv` is rejected at construction for any non-closed-vocabulary spec
- [x] Purity gate still green for the new file

### M5: Builder integration and the `tools` refusal
Source: `implementation.md` Phase 2 M5; RFC section 1.4 placement rules

- [x] `buildLaunchArgv` with no new options produces byte-identical argv to 0.1.3 for all four harnesses
- [x] `buildResumeArgv` with no new options produces byte-identical argv to 0.1.3 for all four harnesses
- [x] Rendered options are inserted after base/resume flags and BEFORE the positional prompt
- [x] Full-argv assertions pass per harness per option on the launch grammar
- [x] Full-argv assertions pass per harness per option on the resume grammar
- [x] `opts.tools` on codex throws `unsupported-option`
- [x] `opts.tools` on pi throws `unsupported-option`
- [x] `opts.tools` on muse throws `unsupported-option`
- [x] `opts.tools` on claude still builds unchanged
- [x] The variadic tools flag is still last in `turnTail` and receives one joined token

## Phase 3: Serializable matchers

### M6: Matcher data types and bounded compilation
Source: `implementation.md` Phase 3 M6; RFC section 4

- [x] `LimitMatcher` and `AuthMatcher` object types replace the `RegExp` tuples
- [x] All four descriptors converted to the object form
- [x] Every pre-existing wall phrasing still classifies to its original code
- [x] Every pre-existing auth phrasing still classifies to its original kind
- [x] `compileMatchers` refuses a pattern over 200 characters
- [x] `compileMatchers` refuses more than 64 matchers per harness per kind
- [x] `compileMatchers` refuses flags outside `imsu`
- [x] `compileMatchers` refuses the `g` flag
- [x] `compileMatchers` refuses the `y` flag
- [x] Wall scanning applies matchers to at most the first 4096 characters of a line
- [x] Compiling the same matcher array twice returns identical `RegExp` instances
- [x] Two descriptors sharing `SHARED_LIMIT_MATCHERS` classify independently after one is overridden
- [x] Comment states that the input window, not pattern analysis, is the backtracking bound

### M7: Rate-limit patterns, override reach, and the override log
Source: `implementation.md` Phase 3 M7; RFC section 4
Observability: required

- [x] `429` classifies as `rate-limit`
- [x] `Too Many Requests` classifies as `rate-limit`
- [x] `rate limited` / `rate-limiting` classify as `rate-limit`
- [x] `Retry-After` classifies as `rate-limit`
- [x] A line containing both a usage wall and a 429 classifies as `usage-limit` (first-match-wins)
- [x] `LimitCode` includes `"rate-limit"`
- [x] An override document adding a matcher round-trips and classifies
- [x] `mergeValue` no longer refuses matcher paths for carrying a RegExp
- [x] An uncompilable override pattern throws `OverrideRefusalError` at LOAD, naming file and harness
- [x] The `spawn` boundary event carries `matcherOverrides: {limit, auth}` when an override changed them
- [x] The `spawn` boundary event omits `matcherOverrides` when nothing was overridden

## Phase 4: The failure taxonomy

### M8: Vocabulary, event, and `ExitCause`
Source: `implementation.md` Phase 4 M8; RFC sections 3.1-3.2

- [x] New file `src/execution/failure.ts` with a module comment on the provider-unavailable vs work-verdict split
- [x] `FAILURE_CLASSES` exported as a closed, frozen 8-member tuple
- [x] `retryable` is false for exactly `task`, `budget`, `rejected`
- [x] `retryable` is true for `rate-limit`, `usage-limit`, `quota`, `auth`, `transport`
- [x] `FailureSummary` carries `class`, `retryable`, `message`
- [x] `FailureSummary` carries optional `code`, `authKind`, `resetsAt`, `issue`, `option`, `facet`, `supported`
- [x] `failure` event kind added to `HarnessEvent`
- [x] `failure` is NOT in `DROPPABLE_KINDS`
- [x] `done` gains an optional `failure` field
- [x] `ExitCause` includes `"failed"`
- [x] `failed` is produced exactly when a failure is present and the cause would otherwise be `clean`
- [x] Module comment states why `rejected` is non-retryable across the whole model chain

### M9: Classification sources and the precedence reduction
Source: `implementation.md` Phase 4 M9; RFC section 3.3 and State Machine
Observability: required

- [x] `limitMatchers` code `rate-limit` classifies `rate-limit` with `code`
- [x] `limitMatchers` codes `usage-limit` / `session-limit` / `weekly-limit` classify `usage-limit` with `code`
- [x] `limitMatchers` codes `credits` / `quota` classify `quota` with `code`
- [x] `authMatchers` hit classifies `auth` with `authKind`
- [x] The `` `auth wall: ${auth}` `` string is gone, replaced by a typed `failure`
- [x] claude `result` with `is_error: true` classifies `task`
- [x] codex `item.completed` of type `error` classifies `task`
- [x] pi `message_end` with `stopReason: "error"` classifies `auth`
- [x] muse `run_terminal` `failed` matching `/did not reach a terminal state within \d+ step/i` classifies `budget`
- [x] Both verbatim A-003 strings are asserted in the test
- [x] muse `run_terminal` `failed` with any other reason classifies `task`
- [x] Spawn failure classifies `transport`
- [x] Pump failure classifies `transport`
- [x] Nonzero exit with nothing else classified classifies `transport`
- [x] The `limit` event is still emitted alongside `failure` for limit classes with the same code
- [x] `auth` then `transport` reduces to `auth`
- [x] `task` then `transport` reduces to `task` with `retryable: false`
- [x] Ties in precedence break to the earliest classification
- [x] pi `stopReason: "error"` at exit 0 yields `cause: "failed"` with a self-sufficient `done.failure`
- [x] Every failure `message` names a remedy dimension
- [x] No failure `message` contains harness output content
- [x] Every `failure` event and `done.failure` correlate by the same `turnId` used in the boundary log
- [x] Classification is table-driven so a new source is data

### M10: claude's `rate_limit_event`
Source: `implementation.md` Phase 4 M10; RFC section 3.4; `test/fixtures/a001-raw.ndjson:20`

- [x] The real fixture record (`status: "allowed"`) emits NO failure
- [x] A non-allowed status record emits `rate-limit`
- [x] `resetsAt` is emitted in unix epoch MILLISECONDS
- [x] The conversion is arithmetic - a fake `Clock` is in place and no wall clock is read
- [x] Absent `resetsAt` omits the field
- [x] Zero `resetsAt` omits the field
- [x] Negative `resetsAt` omits the field
- [x] Non-finite or non-numeric `resetsAt` omits the field
- [x] Comment records that `overageStatus` is deliberately not classified

### M11: `streamTurn` catches the refusal
Source: `implementation.md` Phase 4 M11; RFC section 1.5 "Both channels carry it"
Observability: required

- [x] `streamTurn` with an unexpressible option yields `failure` with `class: "rejected"`
- [x] That event carries `issue`, `option` (or `facet`), and `supported`
- [x] It is followed by `done {exitCode: null, cause: "failed", failure}`
- [x] `streamTurn` does NOT throw out of its first `next()` for a build refusal
- [x] No process is spawned on a refusal
- [x] No `spawn` boundary event is logged on a refusal
- [x] A `rejected` boundary event is logged instead, carrying the issue and redacted argv intent
- [x] The direct builders still throw, unchanged

## Phase 5: Execution plumbing

### M12: Per-call environment
Source: `implementation.md` Phase 5 M12; RFC section 2
Observability: required

- [x] `SpawnOptions` gains `env?: Readonly<Record<string, string>>`
- [x] The `spawn` contract documents merge-over-parent and delete-on-empty
- [x] `nodeRunnerDeps` merges `env` over the parent environment
- [x] A key mapped to `""` is DELETED, not passed as an empty string
- [x] The test fake mirrors the delete-on-empty behavior
- [x] `streamTurn` passes `opts.env` through
- [x] `openSession` passes `opts.env` through
- [x] Keys not matching `^[A-Za-z_][A-Za-z0-9_]*$` refuse with `invalid-env`
- [x] A NUL in a key or value refuses with `invalid-env`
- [x] The `spawn` boundary event lists `envKeys`
- [x] No captured log line anywhere contains an env VALUE

### M13: Both timeout budgets
Source: `implementation.md` Phase 5 M13; RFC section 5
Observability: required

- [x] The `granularity !== "none"` guard is removed from `rearm`
- [x] With `stallMs` set, a silent token-granular turn is killed and reports `cause: "stall"`
- [x] That turn's `failure.class` is `transport` with `retryable: true`
- [x] Any output chunk on stdout rearms the inactivity budget
- [x] Any output chunk on stderr rearms the inactivity budget
- [x] `turnTimeoutMs` is armed once at spawn and never rearmed
- [x] `turnTimeoutMs` fires on a turn that streams continuously
- [x] The first budget to fire disarms the other
- [x] Only one escalation runs when both are set
- [x] With neither budget set, behavior is identical to 0.1.3
- [x] The `stall` boundary event carries `reason: "inactivity"` and `budgetMs`
- [x] The `stall` boundary event carries `reason: "turn-deadline"` and `budgetMs` for the wall-clock case

## Phase 6: Verification and docs

### M15: Pin re-verification and documentation
Source: `implementation.md` Phase 6 M15

- [x] `bun run smoke:seven` run against the real CLIs and its output reviewed
- [x] Fixtures re-captured for the claude 2.1.229 pin
- [x] `bun scripts/check-versions.ts` reports the intended status per harness
- [x] README documents the `TurnOptions` surface and the support matrix
- [x] README documents the failure taxonomy and the canonical consumer check
- [x] README documents the refusal shape and both delivery channels
- [x] `AGENTS.md` sentence claiming the package is private and unpublished is corrected
- [x] `CHANGELOG.md` was not hand-edited
- [x] Breaking commits carry `feat!:` / `BREAKING CHANGE:` footers
- [x] release-please cuts 0.2.0

## Deferred follow-up

Accepted later work. **Not** current-cutoff blockers and excluded from the
Summary counts below.

### M14: A-001 codex resume sandbox follow-up
Source: `spike-report.md` A-001. Blocked on Codex usage-limit reset (~4 days from 2026-08-13).

- [ ] A-001 run in both directions once Codex is available
- [ ] `plan-db validate-assumption --code A-001` recorded with verbatim evidence
- [ ] If PASS: codex `sandbox` gains `resumeRender: {kind: "config-kv", flag: "-c", key: "sandbox_mode"}` plus a resume-argv test
- [ ] If FAIL: `resumeRender: null` stays and the evidence is recorded so it is not re-litigated

### Runtime version-drift signalling
Source: RFC Open Question 3; spike report A-002 incidental finding.

- [ ] Separate follow-up plan: claude `system`/`init` carries `claude_code_version`, so an in-band staleness signal is possible. Out of scope for 0.2.0 - needs its own decision on what a consumer DOES with "this descriptor is stale"

## Superseded/obsolete checklist debt

None.

## Summary

- Total features: 183 (current cutoff only)
- Completed: 183
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 5
- Superseded/obsolete checklist debt: 0