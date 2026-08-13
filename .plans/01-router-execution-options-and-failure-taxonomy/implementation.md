# Router execution options and failure taxonomy - Implementation Plan

<!-- D-011 --> Ships as **0.2.0** of `@dungle-scrubs/harness-cli-normalizer`.

## ⚠️ Execution Protocol

A progress report exists at
`.plans/01-router-execution-options-and-failure-taxonomy/progress-report.md`.
It lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "01-router-execution-options-and-failure-taxonomy"` and read its section in
   the progress report - those current-cutoff checkboxes are your spec
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under it is
   checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus marker
   and Summary
6. Deferred follow-up and superseded/obsolete checklist debt must not be
   counted as current blockers
7. Fully deferred/tabled sections must be moved under Deferred follow-up;
   empty active sections must not remain between completed/current sections
8. `FP-<number>` references must be backed by real progress-report sections
   and checkboxes, not merely named

## 0. Hard Dependencies

None. This plan is upstream of the router CLI, not downstream of it. It blocks
[dungle-scrubs/skills#38](https://github.com/dungle-scrubs/skills/issues/38),
which in turn blocks #31 (registry schema v2), #32 (execute-time fallback
semantics), and #36 (privacy override in an executing router).

Codex being at its usage limit does not block this plan. It defers assumption
A-001 only, and the shipped behavior is correct under either A-001 outcome.

---

## Public API surface

What the router codes against at 0.2.0. This is the deliverable contract; the
[Architecture](#architecture) and [Phases](#phases) sections say how it gets
built.

### Turn options - `TurnOptions` (interpretation)

```ts
interface TurnOptions {
  prompt: string;
  tools?: readonly string[];      // claude only; refuses elsewhere (was silently dropped)
  model?: string;
  autonomy?: boolean;

  effort?: string;                // all four harnesses
  sandbox?: string;               // codex
  provider?: string;              // pi
  discovery?: DiscoveryOptions;   // pi (4 facets), claude (2 facets)
  write?: boolean;                // muse
  shell?: boolean;                // muse
  maxSteps?: number;              // muse
}

interface DiscoveryOptions {      // false disables; true and omitted are no-ops
  tools?: boolean;
  instructionFiles?: boolean;
  extensions?: boolean;
  skills?: boolean;
}

interface TurnRunOptions extends TurnOptions {
  resume?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;   // merged over parent; "" deletes
}
```

<!-- D-002 --> <!-- D-009 --> <!-- D-010 --> <!-- D-013 -->

Support matrix - anything not marked refuses with a typed rejection naming
what the harness does support:

| Option | claude | codex | pi | muse |
| --- | --- | --- | --- | --- |
| `effort` | `--effort` | `-c model_reasoning_effort=` | `--thinking` | `--reasoning-effort` |
| `sandbox` | - | `--sandbox` (launch only [^1]) | - | - |
| `provider` | - | - | `--provider` | - |
| `discovery.tools` | - | - | `-nt` | - |
| `discovery.instructionFiles` | - | - | `-nc` | - |
| `discovery.extensions` | `--setting-sources project` | - | `-ne` | - |
| `discovery.skills` | `--setting-sources project` | - | `-ns` | - |
| `write` | - | - | - | `--disable-write` |
| `shell` | - | - | - | `--disable-shell` |
| `maxSteps` | - | - | - | `--max-model-steps` |
| `tools` | `--allowedTools` | - | - | - |
| `autonomy` | `--dangerously-skip-permissions` | `--yolo` | - | `--yolo` |

[^1]: 0.2.0 ships codex `sandbox` with `resumeRender: null`, so passing
`sandbox` to a **resume** refuses with `unsupported-on-resume`; a resume
without it is unchanged from 0.1.3. Assumption A-001 (whether
`codex exec resume -c sandbox_mode=` is enforced) is deferred on Codex
availability; if it passes, the refusal becomes a working sandboxed resume as
an additive follow-up. <!-- D-020 --> Every other option renders on resume
with the same spelling it uses on launch.

### Events - `HarnessEvent` (execution)

Nine kinds become ten. `failure` is new; `done` gains a field; every other
kind is unchanged.

```ts
type FailureClass =
  | "rate-limit" | "usage-limit" | "quota" | "auth"    // provider unavailable
  | "budget" | "task"                                   // work verdict reached
  | "transport"                                         // no verdict, provider-side
  | "rejected";                                         // library refused to build

interface FailureSummary {
  class: FailureClass;
  retryable: boolean;             // false for task, budget, rejected
  message: string;                // one sentence: what happened + remedy dimension
  code?: LimitCode;               // limit classes
  authKind?: AuthFailureKind;     // class "auth"
  resetsAt?: number;              // unix epoch MS, structured records only
  issue?: RefusalIssue;           // class "rejected"
  option?: TurnOptionKey;
  facet?: DiscoveryFacet;
  supported?: readonly string[];  // what WOULD work
}

type HarnessEvent =
  | ...existing eight kinds, unchanged...
  | ({ kind: "failure" } & FailureSummary)
  | { kind: "done"; exitCode: number | null; cause: ExitCause; failure?: FailureSummary };

type ExitCause = "clean" | "limit" | "crash" | "stall" | "killed" | "failed";
```

<!-- D-004 --> <!-- D-021 --> <!-- D-024 --> <!-- D-027 --> <!-- D-039 -->

The canonical consumer check, identical for a deterministic router and an
agent:

```ts
if (done.failure) {
  if (done.failure.retryable) descendFallbackChain(done.failure);
  else pivot(done.failure);        // rejected -> change options; budget -> raise cap;
}                                  // task -> surface to caller
```

### Refusals - `ArgvRefusalError` (interpretation)

```ts
type RefusalIssue =
  | "unsupported-option" | "unsupported-option-facet" | "unsupported-on-resume"
  | "invalid-option-value" | "unknown-effort" | "unknown-model" | "invalid-env"
  | "invalid-tool-grant" | "prompt-flag-injection" | "no-autonomy-mode"
  | "no-session-mode";

class ArgvRefusalError extends Error {
  issue: RefusalIssue;            // was `string`
  harness: HarnessName;
  option?: TurnOptionKey;
  facet?: DiscoveryFacet;
  supported: readonly string[];
}
```

Thrown by `buildLaunchArgv` / `buildResumeArgv` / `buildSessionArgv`. Caught by
`streamTurn`, which emits it as `failure class=rejected` + `done cause=failed`
and never throws out of its first `next()`. <!-- D-038 --> <!-- D-040 -->

### Runner deps - `RunnerDeps` (execution)

```ts
interface RunnerDeps {
  // ...existing...
  stallMs?: number;               // inactivity; NOW arms at every granularity
  turnTimeoutMs?: number;         // wall-clock ceiling, armed once
}
```

Neither has a library default. A consumer that wants a turn deadline MUST set
at least one. <!-- D-033 -->

### Descriptor - `HarnessDescriptor` (knowledge)

Gains `turnOptions`. Loses `vocabulary.effortFlag`, `provider`, and
`discoveryDisableFlags`. `limitMatchers` / `authMatchers` change from `RegExp`
tuples to serializable objects. <!-- D-005 --> <!-- D-014 --> <!-- D-032 -->

Nine breaking changes total, enumerated in the RFC's Migration section.

---

## Architecture

The change adds one new concept per layer and moves no responsibility across a
seam. The one-way dependency and both gate tests hold unchanged.

```
knowledge                 interpretation              execution
---------                 --------------              ---------
turnOptions: spec table   renderTurnOptions()         streamTurn catches the
  per harness, per key      pure: spec + opts -> argv    refusal -> failure event
                                                       classifyFailure()
LimitMatcher {pattern}    compileMatchers()             -> failure + done.failure
AuthMatcher  {pattern}      pure: data -> RegExp       env -> SpawnOptions
                          ArgvRefusalError (typed)     watchdogs
```

### Key Constraints

| Constraint | Impact |
| --- | --- |
| Purity gate (`test/interpretation/purity.test.ts`) | No `node:`, `require`, `process.env`, `Date.now`, `Math.random`, `Bun.spawn` in `src/interpretation` or `src/knowledge`. Kills any ISO-8601 formatting of `resetsAt` in those layers - hence epoch-ms and pure arithmetic <!-- D-029 --> |
| Chat seam gate (`test/no-chat-imports.test.ts`) | Nothing under `src/` imports lucid, frames, chat-protocol, or reducer. Unaffected by this work |
| Dual-runtime (Node + Bun) | New execution code never imports `child_process`, never calls `process.kill` outside `node-deps.ts`. The env merge and both watchdogs go through injected `spawn` / `clock` / `signal` |
| Injected `Clock` | Execution never reads a wall clock directly. `resetsAt` is arithmetic, not `new Date()` <!-- D-029 --> |
| Descriptors are `deepFreeze`d | Compiled matchers cannot be memoized *onto* a descriptor; the cache is an external `WeakMap` keyed by the matcher array |
| Descriptor facts are pinned | Every new flag was verified from `--help` at the pinned version. claude bumps 2.1.227 -> 2.1.229 <!-- D-012 --> |
| release-please owns `CHANGELOG.md` | Never hand-edited. Breaking commits carry `feat!:` / `BREAKING CHANGE:` |

### Boundaries

Target seams for new code, by responsibility:

| File | Owns | New or changed |
| --- | --- | --- |
| `src/knowledge/descriptor.ts` | Option-key vocabulary, `OptionRender`, `TurnOptionSpec`, matcher shapes | changed |
| `src/knowledge/{claude-code,codex,pi,muse}.ts` | Per-harness `turnOptions` tables | changed |
| `src/knowledge/matchers.ts` | Shared matcher data, now including rate-limit | changed |
| `src/knowledge/overrides.ts` | Matcher compilation at load; `mergeValue` no longer refuses matcher paths | changed |
| `src/interpretation/turn-options.ts` | **New.** `renderTurnOptions` and its validation - the only place a spec becomes argv | new |
| `src/interpretation/argv.ts` | `RefusalIssue`, structured `ArgvRefusalError`, builder integration | changed |
| `src/interpretation/limits.ts` | Matcher compilation cache and the 4096-char scan window | changed |
| `src/interpretation/dimensions.ts` | `providerFlagOf` / `discoveryDisableFlagsOf` removed | changed |
| `src/execution/failure.ts` | **New.** `FailureClass`, `FailureSummary`, `classifyFailure`, the precedence reduction | new |
| `src/execution/events.ts` | `failure` kind, `done.failure`, `ExitCause` gaining `failed` | changed |
| `src/execution/stream-turn.ts` | Refusal catch, failure accumulation, both watchdogs, `env` | changed |
| `src/execution/deps.ts` | `SpawnOptions.env` with the delete-on-empty contract, `turnTimeoutMs` | changed |
| `src/execution/node-deps.ts` | Env merge and delete | changed |

Both new files carry a module-level comment stating what they own and why they
exist, matching the existing convention in every file under `src/`.

`turn-options.ts` is a separate file rather than more of `argv.ts` because
`argv.ts` already owns argv *assembly and ordering*; option *rendering and
validation* is a distinct responsibility with its own vocabulary, and folding
it in would make the largest interpretation file the place two unrelated
questions are answered. `failure.ts` is separate from `stream-turn.ts` for the
same reason: classification is a pure reduction over observations and is
testable without a process.

### Observability

This work changes provider selection, transport, and recovery behavior, so
observability is part of the feature, not a follow-up.

- **Boundary events.** `spawn` gains `envKeys` (names only, never values) and
  `matcherOverrides: {limit, auth}` when a loaded override changed them. A new
  `rejected` event replaces `spawn` when the call never builds, carrying the
  issue and the redacted argv intent. `stall` gains
  `reason: "inactivity" | "turn-deadline"` and `budgetMs`.
- **Correlated failure payloads.** Every `failure` event and the `done.failure`
  summary carry the same `turnId` correlation the boundary log uses, so a
  classification in the stream and its log line join without guesswork.
- **The inspection surface** is the event stream itself: a consumer that logs
  `failure` events has the full classification history, and `done.failure` is
  the reduction. No separate debug channel is added.
- **What must never appear:** env values, prompt content, and harness output
  content in any failure message. The existing rule - records carry
  identifiers and outcomes, never content - is unchanged and now covers
  failure messages explicitly.

---

## Assumptions

| Code | Assumption | Status | Outcome |
| --- | --- | --- | --- |
| A-001 | `codex exec resume -c sandbox_mode=<mode>` is enforced, not merely accepted | **deferred** - Codex over limit ~4 days from 2026-08-13; needs live inference | Plan ships the refusal path, correct under either outcome. `resumeRender` is an additive follow-up <!-- D-020 --> |
| A-002 | claude `--effort` is honored on a `-p` headless turn | **PASS**, with caveat | Flag reaches the `-p` path (exit 0, clean stderr). But claude does **not** enforce its ladder: `--effort bogus` warns on stderr and runs at DEFAULT effort, exit 0, and effort is echoed nowhere in the stream. Library-side `validateEffort` refusal is therefore load-bearing, not cosmetic <!-- D-043 --> |
| A-003 | muse signals step-cap exhaustion distinguishably in `run_terminal.reason` | **PASS** | `payload.reason` is `model did not reach a terminal state within N step(s)`, stable across two caps. Matcher: `/did not reach a terminal state within \d+ step/i`. muse exits **1** on step exhaustion, not 0. Open Question 1 resolved to option (a) <!-- D-042 --> |

See [spike-report.md](spike-report.md) for experiments, pass criteria, and
verbatim evidence. (The spike guide was archived once the report superseded
it.)

---

## Phases

### Phase 1: Option specs as data

**Goal:** Every per-call option a harness can express is declared in its
descriptor, and no descriptor field describes the same fact twice.

**Gate from previous:** none - this is the first phase.

#### M1: Option spec vocabulary in the descriptor

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: the exported types and `deepFreeze` behavior in
     `src/knowledge/descriptor.ts`.
  2. RED: a test asserting `TURN_OPTION_KEYS` and `DISCOVERY_FACETS` are
     closed, frozen, and in the documented render order.
  3. GREEN: add `TURN_OPTION_KEYS`, `DISCOVERY_FACETS`, `OptionRender`,
     `TurnOptionSpec`, `turnOptions` on `HarnessDescriptor`.
  4. RED: a test asserting a spec with `resumeRender` omitted reads as
     "same as render" and `resumeRender: null` reads as "unexpressible".
  5. GREEN: encode that in the type and a small accessor.
  6. REFACTOR: module comment stating why the vocabulary is closed.

#### M2: Per-harness tables, field removals, pin bump

- **Dependencies:** M1
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: each descriptor's `turnOptions`, via
     `test/knowledge/harnesses.test.ts` and `dimensions-coverage.test.ts`.
  2. RED: per-harness tests asserting the exact verified flag spellings -
     claude `--effort` + the two `--setting-sources project` facets, codex
     `--sandbox` values + `-c model_reasoning_effort`, pi's four `-n*` flags +
     `--thinking` + `--provider`, muse's four flags.
  3. GREEN: write the four tables.
  4. RED: a test asserting codex `launch.baseFlags` no longer contains
     `--sandbox` and that the spec default is `workspace-write`. <!-- D-015 -->
  5. GREEN: move it.
  6. RED: tests asserting `effortFlag`, `provider`, and `discoveryDisableFlags`
     are gone from the descriptor type. <!-- D-014 --> <!-- D-032 -->
  7. GREEN: remove them, plus `providerFlagOf` / `discoveryDisableFlagsOf` and
     their tests in `dimensions.ts`.
  8. GREEN: bump claude `verifiedAgainst` to `2.1.229`.
  9. REFACTOR: delete the stale "effort is an in-session command" comment; add
     the claude `--bare` rationale (why `instructionFiles` refuses) and the
     A-002 caveat (claude warns and silently degrades an unknown effort, so
     our refusal is load-bearing) as descriptor comments, so the next reader
     re-derives neither. <!-- D-043 --> Correct the muse header note about
     exiting 0 - true for task failure, false for step exhaustion, which
     exits 1. <!-- D-044 -->

### Gate 1→2

- [ ] `pnpm check` green (lint, typecheck, vitest, bun test, build, package)
- [ ] Every `turnOptions` flag spelling matches the RFC verification table
- [ ] No descriptor field duplicates a `turnOptions` fact

---

### Phase 2: Rendering and typed refusals

**Goal:** A caller can set any declared option per call, and any option a
harness cannot express produces a structured refusal naming the alternative.

**Gate from previous:** Gate 1→2.

#### M3: `RefusalIssue` and the structured `ArgvRefusalError`

- **Dependencies:** M1
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `ArgvRefusalError` construction in
     `src/interpretation/argv.ts`.
  2. RED: a test asserting `issue` is the closed `RefusalIssue` union and that
     every existing refusal site still produces its original issue string.
  3. GREEN: add the union, widen the constructor to carry `harness`,
     `option`, `facet`, `supported`.
  4. RED: a test asserting `supported` is non-empty for every refusal that
     names a dimension, and that the message names an alternative rather than
     only a negation. <!-- D-040 -->
  5. GREEN: fill in `supported` at each site.
  6. REFACTOR: one helper that builds the message from the structured fields,
     so message and fields cannot drift.

#### M4: `renderTurnOptions`

- **Dependencies:** M1, M3
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `renderTurnOptions(h, opts, phase)` in the new
     `src/interpretation/turn-options.ts`.
  2. RED: render order follows `TURN_OPTION_KEYS`, facets follow
     `DISCOVERY_FACETS`, regardless of caller field order.
  3. GREEN: implement the ordered walk.
  4. RED: claude with `{extensions: false, skills: false}` emits
     `--setting-sources project` exactly once; with only one of them, also
     once; with neither, not at all. <!-- D-023 -->
  5. GREEN: implement exact-token-sequence de-duplication, first wins.
  6. RED: `true` and omitted are both no-ops on a `disables` polarity;
     `discovery: {}` equals omitted.
  7. GREEN: implement polarity handling.
  8. RED: validation - `effort` through `validateEffort` with the model's
     ladder; `provider` through `CLEAN_SELECTOR`; `maxSteps` rejecting `0`,
     `1.5`, `NaN`, `Infinity`, `10_001`, and a non-number. <!-- D-030 -->
  9. GREEN: implement validation, each failure carrying its issue.
  10. RED: `enum` default renders on `launch` and NOT on `resume`;
      `resumeRender: null` refuses on `resume`. <!-- D-028 -->
  11. GREEN: implement phase handling.
  12. RED: `config-kv` renders two tokens with a TOML-quoted value, and is
      rejected at construction for any non-closed-vocabulary spec.
  13. GREEN: implement.
  14. REFACTOR: module comment stating why this is not part of `argv.ts`.

#### M5: Builder integration and the `tools` refusal

- **Dependencies:** M4
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `buildLaunchArgv`, `buildResumeArgv`.
  2. RED: a call passing no new options produces argv byte-identical to
     0.1.3, for all four harnesses, launch and resume.
  3. GREEN: insert `renderTurnOptions` between base/resume flags and the
     positional prompt.
  4. RED: full-argv assertions per harness per option, on both grammars.
  5. GREEN: adjust placement until green.
  6. RED: `opts.tools` on codex/pi/muse throws `unsupported-option` with
     `supported: ["--allowedTools is claude-only"]`-style guidance;
     on claude it still builds. <!-- D-003 -->
  7. GREEN: replace the silent-drop guard.
  8. REFACTOR: confirm the variadic tools flag is still last in `turnTail`.

### Gate 2→3

- [ ] `pnpm check` green
- [ ] Byte-identical argv for every 0.1.3-shaped call, all four harnesses
- [ ] Purity gate green - `turn-options.ts` imports nothing forbidden
- [ ] Every refusal carries a non-empty `supported`

---

### Phase 3: Serializable matchers

**Goal:** Wall patterns are data an override file can extend, rate limits are
detected, and a bad pattern fails at load rather than mid-turn.

**Gate from previous:** Gate 2→3.

#### M6: Matcher data types and bounded compilation

- **Dependencies:** none (parallel-safe with Phase 2, sequenced for review size)
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `compileMatchers` in `src/interpretation/limits.ts`;
     `LimitMatcher` / `AuthMatcher` in `src/knowledge/descriptor.ts`.
  2. RED: a matcher object compiles to the same detection result the old
     `RegExp` tuple produced, for every existing pattern.
  3. GREEN: change the types, convert the four descriptors, implement
     `compileMatchers`.
  4. RED: bounds - pattern over 200 chars refuses; more than 64 matchers per
     kind refuses; flags outside `imsu` refuse; `g` and `y` refuse.
     <!-- D-030 -->
  5. GREEN: implement the guards.
  6. RED: detection scans at most the first 4096 characters of a line.
  7. GREEN: implement the window.
  8. RED: compiling twice returns the identical `RegExp` instances (cache
     hit), and two descriptors sharing `SHARED_LIMIT_MATCHERS` classify
     independently after one is overridden.
  9. GREEN: implement the `WeakMap` cache.
  10. REFACTOR: comment stating why the input window, not pattern analysis, is
      the backtracking bound.

#### M7: Rate-limit patterns, override reach, and the override log

- **Dependencies:** M6
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (matcher-override count on the spawn boundary event, so a silent reclassification leaves a trace)
- **Tasks:**
  1. Seams under test: `SHARED_LIMIT_MATCHERS`; `parseOverrides`.
  2. RED: `429`, `Too Many Requests`, `rate limited`, `Retry-After` each
     classify as `rate-limit`; a line with both a usage wall and a 429
     classifies `usage-limit` (first-match-wins, documented cost).
  3. GREEN: add the shared pattern last in the list.
  4. RED: `LimitCode` includes `"rate-limit"`.
  5. GREEN: widen the union.
  6. RED: an override document adding a matcher round-trips and classifies; an
     uncompilable pattern throws `OverrideRefusalError` naming file and
     harness **at load**, not at first line. <!-- D-030 -->
  7. GREEN: remove the RegExp refusal on matcher paths in `mergeValue`;
     compile during `parseOverrides`.
  8. RED: the `spawn` boundary event carries `matcherOverrides: {limit, auth}`
     when an override changed them and omits it otherwise.
  9. GREEN: thread the count through.
  10. REFACTOR: none expected.

### Gate 3→4

- [ ] `pnpm check` green
- [ ] Every 0.1.3 wall phrasing still classifies to its original code
- [ ] `test/knowledge/overrides.test.ts` covers a matcher override end to end
- [ ] A bad pattern refuses at load with file and harness named

---

### Phase 4: The failure taxonomy

**Goal:** Every failure - provider, work, transport, or refusal - arrives as a
typed event and reduces to one self-sufficient summary on `done`.

**Gate from previous:** Gate 3→4.

#### M8: Vocabulary, event, and `ExitCause`

- **Dependencies:** M6
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: `src/execution/failure.ts` (new) and `events.ts`.
  2. RED: `FAILURE_CLASSES` is closed and frozen; `retryable` is false for
     exactly `task`, `budget`, `rejected`.
  3. GREEN: add `FailureClass`, `FailureSummary`, `retryableOf`.
  4. RED: `failure` is not in `DROPPABLE_KINDS`.
  5. GREEN: add the event kind.
  6. RED: `ExitCause` includes `"failed"`, and `failed` is produced exactly
     when a failure is present and the cause would otherwise be `clean`.
     <!-- D-021 -->
  7. GREEN: widen the union and the cause computation.
  8. REFACTOR: module comment on `failure.ts` stating the provider-unavailable
     vs work-verdict split and why `rejected` is chain-wide non-retryable.

#### M9: Classification sources and the precedence reduction

- **Dependencies:** M8
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (correlated failure payloads carrying turnId; every classification emitted in stream order and reduced once on done)
- **Tasks:**
  1. Seams under test: `classifyFailure` and the reduction in `failure.ts`;
     the stderr and stdout pumps in `stream-turn.ts`.
  2. RED: each row of the RFC's classification table maps to its class, with
     `code` / `authKind` populated - including muse `run_terminal` `failed`
     splitting on `/did not reach a terminal state within \d+ step/i` into
     `budget` vs `task`, using the two verbatim A-003 strings. <!-- D-042 -->
  3. GREEN: implement per-source classification; replace the
     `` `auth wall: ${auth}` `` string with a typed `failure`.
  4. RED: the `limit` event is still emitted alongside `failure` for limit
     classes, with the same code (0.1.3 compatibility).
  5. GREEN: emit both.
  6. RED: precedence - a turn classifying `auth` then `transport` reduces to
     `auth`; `task` then `transport` reduces to `task` with `retryable: false`;
     ties break to the earliest. <!-- D-022 -->
  7. GREEN: implement `reduce(set)`.
  8. RED: pi `stopReason: "error"` at exit 0 yields `cause: "failed"` with
     `class: "auth"` and a self-sufficient `done.failure`. <!-- D-018 -->
  9. GREEN: wire the pi arm.
  10. RED: every failure `message` names a remedy dimension and contains no
      harness output content. <!-- D-025 -->
  11. GREEN: write the messages.
  12. REFACTOR: table-drive the classification so a new source is data.

#### M10: claude's `rate_limit_event`

- **Dependencies:** M9
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: the `claude` reader in
     `src/interpretation/content.ts`.
  2. RED: the real fixture record (`status: "allowed"`) emits **no** failure.
     <!-- D-016 -->
  3. GREEN: add the arm, gated on status.
  4. RED: a constructed non-allowed record emits `rate-limit` with `resetsAt`
     in epoch **milliseconds**, computed by arithmetic - asserted with a fake
     `Clock` in place to prove no wall clock is read. <!-- D-029 -->
  5. GREEN: implement.
  6. RED: absent, zero, negative, non-finite, and non-numeric `resetsAt` all
     omit the field rather than producing 1970.
  7. GREEN: guard on finiteness and positivity.
  8. REFACTOR: comment recording that `overageStatus` is deliberately not
     classified.

#### M11: `streamTurn` catches the refusal

- **Dependencies:** M5, M8
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (a `rejected` boundary event replacing `spawn` when no process starts, carrying the issue and redacted argv intent)
- **Tasks:**
  1. Seams under test: `streamTurn`'s build step.
  2. RED: `streamTurn` with an unexpressible option yields
     `failure class=rejected` carrying `issue`, `option`, `supported`, then
     `done {exitCode: null, cause: "failed", failure}` - and does **not**
     throw. <!-- D-038 -->
  3. GREEN: wrap the build in try/catch and emit.
  4. RED: no process is spawned and no `spawn` boundary event is logged; a
     `rejected` boundary event is logged instead.
  5. GREEN: implement the log branch.
  6. RED: the direct builders still throw, unchanged.
  7. GREEN: confirm - no change needed.
  8. REFACTOR: none expected.

### Gate 4→5

- [ ] `pnpm check` green
- [ ] A healthy claude turn emits zero `failure` events
- [ ] pi exit-0 auth reports `cause: "failed"`, not `clean`
- [ ] `done.failure` is self-sufficient - a test reads only the `done` event
      and can name class, retryability, and remedy

---

### Phase 5: Execution plumbing

**Goal:** A caller can inject environment per call and arm a turn deadline
that actually fires.

**Gate from previous:** Gate 4→5.

#### M12: Per-call environment

- **Dependencies:** none within the phase
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (envKeys on the spawn boundary event - names only, values never)
- **Tasks:**
  1. Seams under test: `SpawnOptions` contract, `nodeRunnerDeps`, the test
     fake in `test/execution/fakes.ts`.
  2. RED: the fake spawn receives `env`; a key mapped to `""` arrives as a
     **deletion**, not an empty string. <!-- D-026 -->
  3. GREEN: document the contract on `SpawnOptions`, implement in
     `node-deps.ts`, mirror in the fake.
  4. RED: key grammar and NUL rejection produce `invalid-env`.
  5. GREEN: validate before spawn.
  6. RED: the `spawn` boundary event lists `envKeys` and no captured log line
     anywhere contains an env **value**.
  7. GREEN: implement.
  8. REFACTOR: none expected.

#### M13: Both timeout budgets

- **Dependencies:** M8 (needs `transport` classification)
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (stall boundary event gains reason and budgetMs so inactivity and deadline are distinguishable in the log)
- **Tasks:**
  1. Seams under test: `rearm` / watchdog wiring in `stream-turn.ts`, driven
     by the fake `Clock`.
  2. RED: with `stallMs` set, a token-granular turn that goes silent past the
     budget is killed and reports `cause: "stall"` with
     `failure.class: "transport"` - it does not today. <!-- D-006 -->
  3. GREEN: remove the `granularity !== "none"` guard.
  4. RED: any output chunk rearms, so a chatty turn never fires.
  5. GREEN: confirm rearm placement covers both pumps.
  6. RED: `turnTimeoutMs` fires regardless of activity on a turn that streams
     continuously.
  7. GREEN: arm once at spawn, never rearm.
  8. RED: the first budget to fire disarms the other; only one escalation
     runs. <!-- D-033 -->
  9. GREEN: implement mutual disarm.
  10. RED: with neither budget set, behavior is identical to 0.1.3.
  11. GREEN: confirm.
  12. REFACTOR: the boundary log `reason` field.

### Gate 5→6

- [ ] `pnpm check` green
- [ ] No env value in any captured log line
- [ ] `cause: "stall"` is reachable on a token-granular turn
- [ ] Zero behavior change when neither budget is set

---

### Phase 6: Verification and docs

**Goal:** Every descriptor fact is re-verified against its pin and the public
surface is documented. The runnable assumptions (A-002, A-003) were already
resolved during planning; only the Codex-blocked one remains, and it is
follow-up rather than release work.

**Gate from previous:** Gate 5→6.

#### M14: A-001 follow-up (deferred)

- **Dependencies:** M2, M5, and Codex availability
- **Effort:** S
- **Testing:** test-after (spike work - the experiment is the verification; the result is recorded as an assumption validation)
- **Tasks:**
  1. Run A-001 both directions per [spike-report.md](spike-report.md), which
     carries the full experiment, once Codex is off its usage limit.
  2. `plan-db validate-assumption --code A-001` with verbatim evidence.
  3. If PASS: add `resumeRender: {kind: "config-kv", flag: "-c", key:
     "sandbox_mode"}` to codex's `sandbox` spec, plus a resume-argv test.
     Additive commit; no other milestone changes.
  4. If FAIL: leave `resumeRender: null` as shipped and record the evidence
     so nobody re-litigates it.

A-002 and A-003 were run during the plan's SPIKE stage and both **passed** -
their outcomes are already folded into M2, M9, and the Assumptions table. This
milestone carries only the deferred one, and it does **not** gate 0.2.0.

#### M15: Pin re-verification and documentation

- **Dependencies:** all of Phases 1-5. **Not** M14 - that milestone is
  deferred on Codex availability, and 0.2.0 must not block on it
- **Effort:** S
- **Testing:** test-after (documentation and capability tripwires - verified by running `smoke:seven` and reading its output, not by unit tests)
- **Tasks:**
  1. Run `bun run smoke:seven` against the real CLIs; re-capture fixtures for
     the claude 2.1.229 pin.
  2. Verify `bun scripts/check-versions.ts` still reports the intended status
     per harness.
  3. Update `README.md` with the option types, the failure taxonomy, and the
     canonical consumer check.
  4. Correct the `AGENTS.md` sentence claiming the package is private and
     unpublished. <!-- D-019 -->
  5. Confirm `CHANGELOG.md` was not hand-edited and the breaking commits carry
     `feat!:` / `BREAKING CHANGE:` footers so release-please cuts 0.2.0.
  6. Verify: `pnpm check` green and `smoke:seven` output reviewed.

### Gate 6→done

- [ ] `pnpm check` green
- [ ] `bun run smoke:seven` run and its output reviewed
- [ ] README documents the full public surface from the section above
- [ ] All six PRs merged to `main`

A-002, A-003, and Open Question 1 were resolved during planning and are not
gate items. A-001 is accepted/deferred follow-up and does not gate 0.2.0.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| `stallMs` semantic change fires during long silent tool calls, reporting healthy turns as `transport` failures | high | medium | No library default; migration item 8 tells consumers to re-evaluate their value; `turnTimeoutMs` is the recommended primary control <!-- D-033 --> | implementer |
| pi `stopReason: "error"` classified `auth` is wrong for a genuine task failure, causing one wasted re-route | medium | medium | Accepted: the inverse error strands the router on a dead provider. Revisit if a counter-example appears <!-- D-018 --> | implementer |
| A-001 stays deferred indefinitely; codex resume sandbox gap stays open | medium | medium | The refusal path ships and is safe under either outcome; `resumeRender` is an additive follow-up, not a blocker <!-- D-020 --> | Kevin |
| Nine breaking changes land at once and something downstream breaks silently | medium | low | Enumerated migration table; the router is the only consumer and does not exist yet; `tsc` catches the three union widenings | implementer |
| A matcher override silently reclassifies healthy output and the router abandons good providers | medium | low | Compile bounds, load-time refusal, and `matcherOverrides` on the spawn boundary event so the change leaves a trace | implementer |
| claude 2.1.229 differs from 2.1.227 in ways beyond `--effort` | low | medium | `smoke:seven` re-run and fixture re-capture are gate items on M15, not optional | implementer |
| muse's step-cap reason string changes in a later muse version, silently demoting `budget` to `task` | low | medium | A test asserts both verbatim A-003 strings; a muse version bump raises the weekly drift issue and obliges re-verification like every other pinned fact | implementer |
| A caller sets a claude effort the ladder rejects and expects it to run | low | low | The library refuses rather than letting claude warn-and-degrade; the refusal names the ladder. A-002 evidence sits in the descriptor comment <!-- D-043 --> | implementer |

---

## Escape Hatches

1. **If A-001 fails or stays deferred:** codex `sandbox` gets
   `resumeRender: null`. Resume with a sandbox value refuses; resume without
   one is unchanged. No other phase is affected. This is the shipped default.
2. ~~If A-002 fails~~ - **not needed.** A-002 passed; claude keeps its
   `effort` spec.
3. ~~If A-003 fails~~ - **not needed.** A-003 passed; `budget` has a verified
   producer.
4. **If the `stallMs` semantic change proves too disruptive during Phase 5:**
   gate the every-granularity arming behind an explicit
   `stallMs` + `stallAllGranularities: true` pair rather than changing the
   meaning of an existing field, and make `turnTimeoutMs` the only new
   unconditional budget. Costs one extra dep field; preserves 0.1.3 semantics
   exactly.
5. **If Phase 3's matcher type change turns out to break override consumers
   badly:** keep the `RegExp` tuples as an accepted input shape alongside the
   object form for one minor version, normalizing at load. Deferred by
   default - there are no override consumers today.

---

## Landing Strategy

<!-- D-036 -->

| Field | Value |
| --- | --- |
| Merge target | `main` |
| Branch model | One feature branch per phase, cut from `main` |
| PR cadence | PR per phase - six PRs |
| Independent reviewer | Cross-family, per the model rubric: `gpt-5.6-sol` via the `codex-review` skill when Codex is available; `muse-spark-1.2-contributor` via `pi --thinking high` while Codex is over limit <!-- D-037 --> |
| Ship mechanism | release-please. Breaking commits carry `feat!:` / `BREAKING CHANGE:`; release-please cuts 0.2.0 and owns `CHANGELOG.md` |

`complete` means merged, not merely checked. Each PR must pass `pnpm check`
locally and in CI before review.

---

## Progress Report Accounting

See [progress-report.md](progress-report.md). It must distinguish current
cutoff blockers, accepted/deferred follow-up (A-001 and its `resumeRender`
commit), superseded checklist debt, and completed work. Before resuming
implementation or declaring convergence:

```bash
npx tsx ~/.claude/skills/planner/scripts/plan-db.ts \
  check-progress --plan "01-router-execution-options-and-failure-taxonomy"
```

---

## Validation Commands

```bash
pnpm check              # the full gate: lint, typecheck, vitest, bun test, build, package
pnpm lint               # biome check .
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run
pnpm test:bun           # bun test - both lanes must pass
bun run smoke:seven     # capability tripwires against real CLIs (M15, local only)
bun scripts/check-versions.ts   # descriptor pins vs published/installed
bun run demo <harness> "<prompt>"   # drive a harness, watch the event stream
```

---

## Decisions

Canonical decisions are in `.plans/01-router-execution-options-and-failure-taxonomy/plan.db`.

```bash
npx tsx ~/.claude/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "01-router-execution-options-and-failure-taxonomy"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.
