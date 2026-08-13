---
number: 01
title: "Per-call turn options and a typed failure taxonomy for router-driven execution"
type: feature
status: Review
author: Kevin Frilot
date: 2026-08-13
---

# RFC-01: Per-call turn options and a typed failure taxonomy for router-driven execution

## Abstract

An external model-routing CLI needs to drive all four harnesses through this
library's `streamTurn`, but the execution layer today exposes only four turn
knobs (prompt, tools, model, autonomy) plus `resume` and `cwd`, and its only
machine-readable failure signal is a `limit` event with a five-code
vocabulary. Everything else a router must set - reasoning effort, codex
sandbox mode, pi provider and discovery isolation, muse write and step caps,
per-call environment - is present in the descriptors as data but reaches no
builder, and every failure that is not a curated usage-wall phrasing arrives
as an untyped `error` string. This RFC adds a per-call **turn option** surface
declared as descriptor data and rendered by the argv builders, and a typed
**failure taxonomy** that serves both kinds of consumer this library has: a
deterministic caller branching on closed unions, and an agent that must learn
*why* an attempt was rejected in order to pivot - re-authenticate, raise a
budget, drop an option the harness cannot express, or route the same work to a
different model. It ships as 0.2.0 and carries nine deliberate breaking
changes, all enumerated in [Migration](#migration).

## Introduction

### Problem statement

A capability survey of v0.1.3 ([References](#references), N1) established, with
`file:line` citations, that:

1. **Per-call options do not exist.** `TurnOptions` is `{prompt, tools?,
   model?, autonomy?}` (`src/interpretation/argv.ts:34-45`). `effortFlag` and
   `validateEffort` exist and are exported, but no builder reads them.
   `--sandbox workspace-write` is hardcoded in codex's `launch.baseFlags`
   (`src/knowledge/codex.ts:23`). `providerFlagOf` and
   `discoveryDisableFlagsOf` have no callers outside tests
   (`src/interpretation/dimensions.ts:11-17`). muse's `--disable-write` and
   `--max-model-steps` are unmodeled. `SpawnOptions` is `{cwd?, stdin}` with
   no `env` (`src/execution/deps.ts:27-32`).
2. **The only escape hatch is process-wide.** `parseOverrides` rewrites whole
   descriptors, so "high effort for this turn, medium for the next" needs two
   descriptor variants rather than two calls - and any RegExp-bearing path
   (`limitMatchers`, `authMatchers`) refuses JSON overrides outright
   (`src/knowledge/overrides.ts:93-95`, array form at `:116-118`).
3. **Failure classification is too weak to drive a pivot.** There is no
   `429`, `rate limit`, `too many requests`, or `retry-after` matcher anywhere
   in the repo. claude's own structured `rate_limit_event` - which carries
   `resetsAt` - is silently discarded by the content decoder
   (`src/interpretation/content.ts:43-76`). A typed `AuthFailureKind` is
   computed in interpretation and then flattened into
   `` `auth wall: ${auth}` `` at the execution seam
   (`src/execution/stream-turn.ts:218-221`), so a consumer must parse a prefix
   out of a message string. `done.cause` is effectively three states in
   practice - `clean`, `limit`, `crash` - because `stall` never arms on a
   default launch (`src/execution/stream-turn.ts:156-164`) and auth failures
   land in `crash`, or in `clean` for pi, which exits 0.

### Who consumes this

The consumer is one of two things, and the design serves both:

- A **deterministic caller** - the router's fallback loop, branching on closed
  unions and a boolean. It needs types it can `switch` on exhaustively, and it
  needs the library to refuse rather than guess.
- An **agent** - a model driving the library directly. It needs to learn *why*
  an attempt was rejected or failed, in enough detail to pivot without reading
  the descriptors: re-authenticate this provider, raise the step cap and rerun,
  drop an option this harness cannot express, or route the same work down a
  fallback chain to the next model.

Three consequences shape the whole design:

- The classification must be **actionable, not merely typed**. The distinction
  that matters is whether the turn reached a verdict on the work (never
  re-route it) or did not (routing elsewhere is safe), plus enough detail to
  name the remedy.
- The terminal `done` event must be **self-sufficient**. A consumer that
  pivots off `done` MUST NOT have to retain earlier stream events to know
  which remedy applies, so the summary carries the full classification rather
  than a pointer back into the stream. <!-- D-024 -->
- **A rejected attempt is a first-class outcome, not an exception to the
  contract.** The library refuses calls it cannot honor
  ([section 1.5](#15-refusals)), and a refusal is exactly the kind of "why"
  an agent needs. It therefore travels the same channel as every other
  failure, carries the same self-sufficient shape, and names the alternative
  rather than only the negation. <!-- D-038 --> <!-- D-040 -->

### Scope

**In scope:**

- A per-call turn-option surface: `effort`, `sandbox`, `provider`,
  `discovery`, `write`, `shell`, `maxSteps`, declared per harness as
  descriptor data and rendered by `buildLaunchArgv` / `buildResumeArgv`.
- Per-call environment injection through `SpawnOptions` and `TurnRunOptions`.
- A typed `failure` HarnessEvent with a closed `FailureClass` vocabulary, and
  a self-sufficient `failure` summary on the terminal `done` event.
- Structured, typed refusals that name the alternative, delivered both as a
  thrown `ArgvRefusalError` and as a `rejected` failure in the event stream.
- Rate-limit detection: `429` / `retry-after` / `too many requests` matchers,
  and a claude `rate_limit_event` decoder arm carrying `resetsAt`.
- Converting descriptor matchers from `RegExp` literals to serializable
  `{pattern, flags, code}` data so `parseOverrides` can extend them.
- A per-turn timeout the consumer can arm: the stall watchdog at every
  granularity, plus a wall-clock `turnTimeoutMs`.
- Closing the codex resume sandbox asymmetry, or refusing loudly when it
  cannot be closed.
- Re-verifying every new and touched descriptor fact against the pinned CLI
  version, and bringing the pins current.

**Explicitly out of scope:**

- The router CLI itself. This RFC specifies only what the consumer codes
  against.
- Session mode for codex, pi, or muse. `openSession` stays claude-only, and
  turn options are not wired into it ([Open Question 2](#open-questions)).
- Interactive/TTY driving. Unchanged.
- Runtime version-drift signalling on `HarnessEvent`. The weekly
  `harness-versions` job remains the only drift channel.
- pi's `--mode rpc` session semantics, `--no-session`, and `--models`
  cycling.
- Reworking `resume.idShape` into serializable data. It stays a `RegExp` and
  stays non-overridable; no consumer need was identified.
- Parsing a backoff duration out of prose. `resetsAt` comes only from
  structured harness records. <!-- D-034 -->
- Retry, backoff, and fallback policy. This library classifies; it never
  retries, never sleeps, and never spawns a second process for a failed turn.

## Motivation

The decision to extend this library rather than have the router compose argv
itself is recorded upstream (`dungle-scrubs/skills#38`). The reasoning is that
argv composition is exactly the knowledge this library exists to own: a router
that spells `--sandbox read-only` itself has re-created the coupling to CLI
grammar that the descriptors were built to absorb, and it acquires a second
place where a harness update must be verified.

Two of the gaps are correctness problems rather than ergonomic ones, which is
what makes this urgent rather than merely useful:

- A pi turn launched through `streamTurn` today runs **with** `AGENTS.md` /
  `CLAUDE.md`, extensions, skills, and its read/bash/edit/write tools live.
  An independent cross-family reviewer driven this way is not independent -
  it has read the same instruction files the primary agent read.
- A resumed codex turn silently regains write access, because
  `buildResumeArgv` deliberately does not inherit `--sandbox` (codex rejects
  it in that grammar). A multi-turn review run believes it is read-only and
  is not.

Both are quiet privilege escalations relative to caller intent, and both are
invisible to the consumer. That shapes the refusal policy in
[section 1.5](#15-refusals): the failure mode of an unexpressible restriction
is a loud stop, never a permissive run.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

- **Turn option** - a per-call execution-shaping choice a caller passes to one
  `streamTurn` invocation (effort, sandbox mode, provider, ...). Distinct from
  a *descriptor override*, which is a process-wide edit to a harness's facts.
- **Option spec** - the descriptor data declaring how one harness renders one
  turn option into argv, and what values are legal for it.
- **Render** - the argv shape an option spec produces: a flag with a value, a
  `-c key=value` config pair, or a fixed multi-token flag list.
- **Discovery facet** - one independently controllable dimension of
  instruction-file / extension / skill / tool auto-discovery.
- **Failure class** - the closed vocabulary a consuming agent branches on to
  decide how to pivot.
- **Retryable** - of a failure: the turn reached no verdict on the work, so
  routing the same work to a different model is safe. <!-- D-017 -->
- **Provider unavailable** - a retryable failure. The agent descends its
  fallback chain.
- **Task failed** - a non-retryable failure. The model did the work and the
  work is wrong or incomplete; the agent MUST NOT auto-route it elsewhere.
- **Budget exhausted** - a non-retryable failure whose remedy is a larger
  caller-set cap on the *same* model, not a different one. <!-- D-027 -->
- **Rejected** - the library refused to build the call. Non-retryable, and
  non-retryable across the whole model chain: the remedy is different options
  or a different harness. <!-- D-039 -->

## Design

### 1. Turn options

#### 1.1 Caller surface

`TurnOptions` gains named optional fields. <!-- D-002 --> Existing callers that
pass none of them produce byte-identical argv to 0.1.3.

```ts
export interface TurnOptions {
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly autonomy?: boolean;

  /** Reasoning/thinking effort. Validated against the model's ladder where
   *  the harness constrains one (codex), else the harness-wide ladder. */
  readonly effort?: string;
  /** Sandbox policy (codex). */
  readonly sandbox?: string;
  /** Provider route (pi). */
  readonly provider?: string;
  /** Auto-discovery isolation. `false` disables that facet; `true` and
   *  omitted both mean "keep the harness default". */
  readonly discovery?: DiscoveryOptions;
  /** `false` disables non-shell workspace filesystem writes (muse). */
  readonly write?: boolean;
  /** `false` disables workspace shell execution (muse). */
  readonly shell?: boolean;
  /** Cap on model steps (muse). */
  readonly maxSteps?: number;
}

export interface DiscoveryOptions {
  readonly tools?: boolean;
  readonly instructionFiles?: boolean;
  readonly extensions?: boolean;
  readonly skills?: boolean;
}
```

`TurnRunOptions` additionally gains `env`:

```ts
export interface TurnRunOptions extends LaunchOptions {
  readonly resume?: string;
  readonly cwd?: string;
  /** Merged over the parent environment by the spawn adapter. A key mapped
   *  to "" means DELETE the variable. Values MUST NOT reach any log line. */
  readonly env?: Readonly<Record<string, string>>;
}
```

<!-- D-009 -->

#### 1.2 Descriptor data

The knowledge layer gains a closed option-key vocabulary and a per-harness
spec table. The vocabulary is closed for the same reason `LimitCode` is: a
descriptor MUST NOT invent an option a consumer has no field for.

```ts
export const TURN_OPTION_KEYS = [
  "effort", "sandbox", "provider", "discovery", "write", "shell", "maxSteps",
] as const;
export type TurnOptionKey = (typeof TURN_OPTION_KEYS)[number];

export const DISCOVERY_FACETS = [
  "tools", "instructionFiles", "extensions", "skills",
] as const;
export type DiscoveryFacet = (typeof DISCOVERY_FACETS)[number];

export type OptionRender =
  /** `--flag <value>` */
  | { readonly kind: "flag-value"; readonly flag: string }
  /** `-c key=value` - codex's config-override grammar. Permitted only for
   *  closed-vocabulary specs, so no value can need escaping. */
  | { readonly kind: "config-kv"; readonly flag: string; readonly key: string }
  /** A fixed multi-token flag set emitted verbatim, value-less. */
  | { readonly kind: "flag-list"; readonly flags: readonly string[] };

interface SpecBase {
  readonly render: OptionRender;
  /** The spelling the RESUME grammar accepts. Omitted means "same as
   *  `render`"; an explicit `null` declares the option unexpressible on
   *  resume, and building a resume argv with it MUST refuse. */
  readonly resumeRender?: OptionRender | null;
}

export type TurnOptionSpec =
  /** Closed value vocabulary. `default` renders on LAUNCH ONLY. */
  | (SpecBase & { kind: "enum"; values: readonly string[]; default?: string })
  /** Ladder comes from vocabulary.efforts / effortsByModel, not from here. */
  | (SpecBase & { kind: "effort" })
  /** Open selector, CLEAN_SELECTOR-validated. */
  | (SpecBase & { kind: "selector" })
  /** `polarity: "disables"` emits the render when the caller asks for FALSE. */
  | (SpecBase & { kind: "toggle"; polarity: "enables" | "disables" })
  | (SpecBase & { kind: "integer"; min: number; max: number })
  /** Per-facet toggles; a facet absent from the table cannot be expressed. */
  | { kind: "discovery";
      facets: Readonly<Partial<Record<DiscoveryFacet,
        SpecBase & { polarity: "enables" | "disables" }>>> };

export interface HarnessDescriptor {
  // ... existing fields ...
  readonly turnOptions: Readonly<Partial<Record<TurnOptionKey, TurnOptionSpec>>>;
}
```

Three existing descriptor fields are **removed**, because `turnOptions` now
carries the same facts and two descriptor fields describing one fact is
exactly the drift this library exists to prevent: <!-- D-014 --> <!-- D-032 -->

| Removed | Superseded by | Existing readers |
| --- | --- | --- |
| `vocabulary.effortFlag` | `turnOptions.effort` | none |
| `provider` | `turnOptions.provider` | `providerFlagOf`, tests only |
| `discoveryDisableFlags` | `turnOptions.discovery` | `discoveryDisableFlagsOf`, tests only |

`providerFlagOf` and `discoveryDisableFlagsOf` are removed from
`src/interpretation/dimensions.ts` with their tests. `stdinPolicyOf` stays -
it has a real caller.

**Two `resumeRender` rules carry real weight and are easy to get wrong:**

1. **Omitted means "same as `render`."** <!-- D-028 --> Written the other way
   round - omitted meaning "unexpressible" - pi's four discovery facets would
   silently become unresumable, so an isolated pi reviewer could be launched
   and never resumed.
2. **An `enum` `default` renders on launch only.** <!-- D-028 --> Rendering
   codex's `workspace-write` default on resume would newly grant write access
   to resumed turns that run read-only today. That is the precise bug this RFC
   exists to close, arriving through the fix.

#### 1.3 Per-harness declarations

Every spelling below was verified against the installed CLI. Evidence and
version pins are in [section 6](#6-descriptor-verification). `resumeRender` is
shown only where it differs from `render` or is `null`.

**claude** (`--effort` verified on 2.1.229; the descriptor's
`effortFlag: null` and its "effort is an in-session command" comment are
stale): <!-- D-012 -->

```ts
turnOptions: {
  effort: { kind: "effort", render: { kind: "flag-value", flag: "--effort" } },
  discovery: { kind: "discovery", facets: {
    extensions: { polarity: "disables",
                  render: { kind: "flag-list", flags: ["--setting-sources", "project"] } },
    skills:     { polarity: "disables",
                  render: { kind: "flag-list", flags: ["--setting-sources", "project"] } },
  } },
}
```

claude declares only the two facets `--setting-sources project` genuinely
covers. `discovery.tools` and `discovery.instructionFiles` on claude MUST
refuse. <!-- D-010 --> This is not an oversight: claude 2.1.229 does have a
flag that stops `CLAUDE.md` auto-discovery - `--bare` - but it bundles that
with skipping hooks, LSP, plugin sync, auto-memory and keychain reads, and it
forces authentication to `ANTHROPIC_API_KEY` or `apiKeyHelper` with OAuth and
keychain never read. Rendering `instructionFiles: false` as `--bare` would
break authentication for any OAuth-authenticated caller, so claude has no
*isolated* instruction-file toggle and the descriptor says so rather than
selling an isolation that costs the caller their credentials.

**codex**:

```ts
turnOptions: {
  effort:  { kind: "effort",
             render: { kind: "config-kv", flag: "-c", key: "model_reasoning_effort" } },
  sandbox: { kind: "enum",
             values: ["read-only", "workspace-write", "danger-full-access"],
             default: "workspace-write",
             render:       { kind: "flag-value", flag: "--sandbox" },
             // A-001 is deferred, so 0.2.0 SHIPS the refusing form:
             resumeRender: null },
}
```

`--sandbox workspace-write` is **removed from `launch.baseFlags`** and becomes
the `sandbox` spec's `default`. <!-- D-015 --> The builder therefore emits
exactly one `--sandbox <value>` on launch: argv stays byte-identical for
callers that pass nothing, and a caller that does pass a value does not get a
duplicate flag whose precedence depends on codex's clap configuration.

**What 0.2.0 ships is `resumeRender: null`**: a resume carrying a sandbox
value refuses with `unsupported-on-resume`. <!-- D-020 --> <!-- D-046 --> Assumption A-001 -
whether `codex exec resume -c sandbox_mode=<mode>` is actually *enforced*
rather than merely parsed - is deferred because Codex is at its usage limit
([section 7](#7-assumptions-and-spikes)), and the refusal is the correct
behavior while that is unknown. If A-001 later passes, swapping in
`resumeRender: {kind: "config-kv", flag: "-c", key: "sandbox_mode"}` is a
purely additive follow-up that turns a refusal into a working sandboxed
resume.

The refusal does **not** warn and proceed. A warning would reintroduce exactly
the stringly-typed signal this RFC removes for auth walls, and would leave a
permissive run behind an `error` message a consuming agent has to
pattern-match. It costs little, because it fires only when a sandbox value is
explicitly passed: an ordinary resume with no sandbox intent still works
exactly as it does in 0.1.3, and a caller that needs a sandboxed multi-turn
run re-launches rather than resuming.

**pi**:

```ts
turnOptions: {
  effort:   { kind: "effort",   render: { kind: "flag-value", flag: "--thinking" } },
  provider: { kind: "selector", render: { kind: "flag-value", flag: "--provider" } },
  discovery: { kind: "discovery", facets: {
    tools:            { polarity: "disables", render: { kind: "flag-list", flags: ["-nt"] } },
    instructionFiles: { polarity: "disables", render: { kind: "flag-list", flags: ["-nc"] } },
    extensions:       { polarity: "disables", render: { kind: "flag-list", flags: ["-ne"] } },
    skills:           { polarity: "disables", render: { kind: "flag-list", flags: ["-ns"] } },
  } },
}
```

Verified on pi 0.84.1: `--no-tools, -nt` ("Disable all tools by default"),
`--no-context-files, -nc` ("Disable AGENTS.md and CLAUDE.md discovery and
loading"), `--no-extensions, -ne`, `--no-skills, -ns`. The semantic facet
names map onto pi's four flags exactly, which is what makes the facet
vocabulary honest rather than pi-shaped.

**muse**:

```ts
turnOptions: {
  effort:   { kind: "effort",  render: { kind: "flag-value", flag: "--reasoning-effort" } },
  write:    { kind: "toggle",  polarity: "disables",
              render: { kind: "flag-list", flags: ["--disable-write"] } },
  shell:    { kind: "toggle",  polarity: "disables",
              render: { kind: "flag-list", flags: ["--disable-shell"] } },
  maxSteps: { kind: "integer", min: 1, max: 10_000,
              render: { kind: "flag-value", flag: "--max-model-steps" } },
}
```

`shell` is not in the original requirement list and is added deliberately.
<!-- D-013 --> Verified on muse 0.1.0, `--disable-write` disables *non-shell*
workspace filesystem writes only; `--disable-shell` is a separate flag. A
caller that asks for a read-only muse run and receives `--disable-write` alone
still gets a process that can write through the shell - the same
silent-write-access failure class as the codex resume drop, and not one this
RFC should close in one place and leave open in another.

#### 1.4 Rendering

A new pure function in the interpretation layer:

```ts
export const renderTurnOptions = (
  h: HarnessDescriptor,
  opts: TurnOptions,
  phase: "launch" | "resume",
): string[]
```

**Placement.** Rendered tokens are inserted **before the positional prompt**,
between the harness's base flags (or the resume token and its extra flags) and
the prompt:

```
launch: [bin, ...baseFlags,   ...renderTurnOptions(h, opts, "launch"), ...turnTail(h, opts)]
resume: [bin, ...subcommands, resume.flag, id, ...resume.extraFlags,
                              ...renderTurnOptions(h, opts, "resume"), ...turnTail(h, opts)]
```

`turnTail` is unchanged and still begins with the prompt and ends with the
variadic tools flag fed exactly one joined token. Placing options before the
prompt rather than after it means no option token can be mistaken for a
positional argument by any harness's grammar, and it removes the need to
assume codex accepts a global `-c` after its `PROMPT` positional.

**Ordering and de-duplication.** <!-- D-023 -->

- Options MUST render in `TURN_OPTION_KEYS` order, and discovery facets in
  `DISCOVERY_FACETS` order, so argv is deterministic and diffable regardless
  of caller field order.
- After rendering, identical token sequences MUST be de-duplicated, first
  occurrence winning. This is what makes claude's two facets both mapping to
  `["--setting-sources", "project"]` emit that flag once. De-duplication is by
  exact rendered sequence, not by flag name, so two options that share a flag
  with different values are both kept and the harness's own last-wins rule
  applies.

**Value semantics.**

- A `toggle` or discovery facet with `polarity: "disables"` emits its render
  when the caller passes `false`. `true` and omitted both emit nothing. There
  is no way to spell "force-enable" and no harness needs one; if one ever
  does, that is a `polarity: "enables"` spec, not a re-reading of `true`.
- A `discovery` value of `{}` and an omitted `discovery` are identical.
- A spec with a `default` renders that default when the caller passes nothing,
  **on the launch phase only**.

**Validation.**

- `effort` MUST be validated with the existing `validateEffort(h, effort,
  opts.model)`, so codex's per-model ladders apply without a second
  implementation.
- `provider` MUST be validated against `CLEAN_SELECTOR` - the same grammar
  `validateModel` uses for pi's extensible registry, which excludes
  whitespace, control characters, and shell metacharacters.
- `maxSteps` MUST satisfy `Number.isInteger` and fall within `[min, max]`.
  `NaN`, `Infinity`, `0`, `1.5`, and a non-number MUST all refuse with
  `invalid-option-value` rather than reaching argv. <!-- D-030 -->
- `config-kv` renders as two tokens, `flag` then `key=value` (`-c`,
  `model_reasoning_effort="high"`). The value is TOML-quoted because codex
  parses the value portion as TOML and falls back to a literal string. Only
  `enum` and `effort` specs - both closed vocabularies - MAY use `config-kv`,
  so no value can contain a quote that would need escaping.
- On the `resume` phase, a spec with `resumeRender: null` MUST refuse.

#### 1.5 Refusals

Every unexpressible option MUST be refused, matching the existing `autonomy`
precedent rather than the existing `tools` precedent. <!-- D-003 -->

**This converts the existing silent drop of `opts.tools` on codex, pi, and
muse into a refusal.** A router asking for a restricted tool set and receiving
an unrestricted run with no signal is the same class of defect as the two
correctness problems in [Motivation](#motivation).

##### The refusal is structured, not a string

`ArgvRefusalError` today carries `issue: string` and a message. Both get
typed, for the same reason the auth taxonomy stops being a string prefix: a
consumer branching on a refusal MUST NOT have to pattern-match English.

```ts
export const REFUSAL_ISSUES = [
  "unsupported-option", "unsupported-option-facet", "unsupported-on-resume",
  "invalid-option-value", "unknown-effort", "unknown-model", "invalid-env",
  "invalid-tool-grant", "prompt-flag-injection", "no-autonomy-mode",
  "no-session-mode",
] as const;
export type RefusalIssue = (typeof REFUSAL_ISSUES)[number];

export class ArgvRefusalError extends Error {
  readonly issue: RefusalIssue;
  readonly harness: HarnessName;
  /** The option key or facet at fault, where the issue names one. */
  readonly option?: TurnOptionKey;
  readonly facet?: DiscoveryFacet;
  /** What this harness CAN express for the rejected dimension - the option
   *  keys it declares, the facets it declares, or the legal values. */
  readonly supported: readonly string[];
}
```

| Issue | Raised when | `supported` carries |
| --- | --- | --- |
| `unsupported-option` | The harness's `turnOptions` has no spec for the key | the option keys it does declare |
| `unsupported-option-facet` | A `discovery` facet the harness cannot express | the facets it does declare |
| `unsupported-on-resume` | The spec declares `resumeRender: null`, on a resume build | the options expressible on resume |
| `invalid-option-value` | Outside an `enum`'s `values`, an `integer`'s range or integrality, or failing `CLEAN_SELECTOR` | the legal values or the range |
| `unknown-effort` | `validateEffort` refuses | the applicable effort ladder |
| `invalid-env` | env key grammar, or a NUL in a key or value | the key grammar |

**The message MUST name the alternative, not only the negation.**
<!-- D-040 --> "pi has no `sandbox` option" leaves an agent guessing; "pi
cannot express a sandbox policy - it has no sandboxing; drop the option or
route this work to codex" tells it what to do next. One sentence, no harness
output content.

##### Both channels carry it

<!-- D-038 --> The pure builders keep **throwing**: a pure function in the
interpretation layer returning an event instead of a value would invert the
layering. A deterministic caller invoking `buildLaunchArgv` directly gets a
typed exception with a stack, and fails fast at the call site.

`streamTurn` **catches** a build refusal and emits it as events, matching the
contract the spawn-failure path already honors - "a spawn that cannot start
still honors the contract: error, done, and a closed exit log - never a throw
out of the first `next()`" (`src/execution/stream-turn.ts:111-126`). Without
this, an agent would have to wrap `streamTurn` in `try`/`catch` **and**
consume the stream to learn why one call did not run, handling two channels
for one concept:

```ts
for await (const e of streamTurn(piCli, { prompt, sandbox: "read-only" }, deps)) { ... }
// { kind: "failure", class: "rejected", retryable: false,
//   issue: "unsupported-option", option: "sandbox",
//   supported: ["effort", "provider", "discovery"],
//   message: "pi cannot express a sandbox policy - it has no sandboxing; drop the option or route this work to codex" }
// { kind: "done", exitCode: null, cause: "failed",
//   failure: { class: "rejected", retryable: false, ... } }
```

No process is spawned, so `exitCode` is `null` and no `spawn` boundary event
is logged; a `rejected` boundary event is logged in its place carrying the
issue and the redacted argv intent.

### 2. Per-call environment

`SpawnOptions` gains `env?: Readonly<Record<string, string>>`, and
`streamTurn` / `openSession` pass `opts.env` through. <!-- D-009 -->

**Merge and unset are part of the `spawn` contract, not adapter trivia.**
<!-- D-026 --> `RunnerDeps.spawn`'s documented contract states that the
adapter merges `env` over the parent environment and **deletes** any key whose
value is `""`. This is normative because Node's `spawn` with `{FOO: ""}`
passes `FOO=` rather than removing the variable: a rule stated only in prose
would let `node-deps.ts` and the test fakes diverge silently, and the
divergence would only show up as a harness reading an empty credential.

**Validation.** Keys MUST match `^[A-Za-z_][A-Za-z0-9_]*$`, and neither key
nor value may contain a NUL. Anything else refuses before spawn.

Replace-the-whole-environment semantics were rejected: the caller would have
to reconstruct `PATH`, `HOME`, and every variable each CLI needs, on every
call.

**Environment values MUST NOT appear in any boundary log.** The existing
`redactArgv` guards argv by position and shape; env is a separate channel and
is where a router's provider keys live. The `spawn` boundary event gains
`envKeys: string[]` - names only:

```
{ event: "spawn", turnId, harness, argv: [...], granularity,
  envKeys: ["META_API_KEY", "HERDR_ENV"] }
```

Key names are logged deliberately: an injected-credential name is what makes a
failed turn diagnosable, and a name is not a secret. Values never are.

### 3. The failure taxonomy

#### 3.1 Vocabulary

```ts
export const FAILURE_CLASSES = [
  "rate-limit", "usage-limit", "quota", "auth",
  "budget", "task", "transport", "rejected",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
```

<!-- D-017 --> <!-- D-027 --> <!-- D-039 -->

| Class | Meaning | `retryable` | The consumer's pivot |
| --- | --- | --- | --- |
| `rate-limit` | Throttled now; this provider works again shortly | `true` | Back off to `resetsAt` if present, else descend the chain |
| `usage-limit` | A usage wall (session / weekly / plan) | `true` | Descend the chain |
| `quota` | Credits or quota exhausted | `true` | Descend the chain |
| `auth` | Credentials missing, expired, or invalid | `true` | Descend the chain; `authKind` names the human remedy |
| `budget` | A caller-set cap was exhausted | `false` | Raise the cap and rerun on the **same** model |
| `task` | The model ran and the work failed | `false` | Surface to the caller; do not re-route |
| `transport` | Spawn failure, crash, pump failure, stall, deadline | `true` | Descend the chain, or retry the same model once |
| `rejected` | The library refused to build the call | `false` | Change the options or the harness - **not** the model |

`rejected` is `retryable: false` for a different reason than `task` and
`budget`: repeating the same call fails identically at every rung of a model
fallback chain, because the refusal is a property of the harness's grammar and
the caller's options, not of any model. An agent that treated a rejection as
provider-unavailable would walk its entire chain collecting the same error.
<!-- D-039 --> The remedy dimension is on the event: `option`/`facet` names
what was rejected and `supported` names what would work instead.

`auth` is retryable because retryability is a statement about the *work*, not
about whether a human must eventually act: the provider cannot run this turn,
so the agent routes to the next model in the chain. The `authKind` on the
event is what tells it (and a human) that a re-auth is owed.

`budget` exists because the alternative classification is actively misleading.
muse exhausting `--max-model-steps` emits `run_terminal` with
`terminal: "failed"`, which would otherwise classify as `task` - telling the
agent the work failed and must never be retried, when the correct pivot is to
raise the cap on the same model.

#### 3.2 Events

A new `failure` event, and a self-sufficient summary on the terminal event:
<!-- D-004 --> <!-- D-024 -->

```ts
export interface FailureSummary {
  readonly class: FailureClass;
  /** The turn reached no verdict on the work, so routing the same work to
   *  another model is safe. False for "task" and "budget" only. */
  readonly retryable: boolean;
  /** One sentence naming what happened and the remedy dimension. Carries no
   *  harness output content. */
  readonly message: string;
  /** Present for limit classes - the existing closed LimitCode. */
  readonly code?: LimitCode;
  /** Present for class "auth". */
  readonly authKind?: AuthFailureKind;
  /** Unix epoch MILLISECONDS, from structured harness records only. */
  readonly resetsAt?: number;
  /** Present for class "rejected" - the typed refusal, so a consumer never
   *  parses the message and an agent learns what would work instead. */
  readonly issue?: RefusalIssue;
  readonly option?: TurnOptionKey;
  readonly facet?: DiscoveryFacet;
  readonly supported?: readonly string[];
}

export type HarnessEvent =
  // ... existing kinds unchanged ...
  | ({ readonly kind: "failure" } & FailureSummary)
  | { readonly kind: "done";
      readonly exitCode: number | null;
      readonly cause: ExitCause;
      /** The reduced classification, or absent if nothing was classified. */
      readonly failure?: FailureSummary };
```

The summary is the event minus its discriminator, so an agent that reads only
`done` has everything an agent that read the whole stream would have.
<!-- D-024 --> Messages are written for an agent to act on: "provider
credentials rejected by pi; re-authenticate or route to another provider", not
"limit wall detected (quota)". <!-- D-025 -->

`ExitCause` gains exactly one member: <!-- D-021 -->

```ts
export type ExitCause =
  | "clean" | "limit" | "crash" | "stall" | "killed"
  | "failed";  // new
```

`failed` is set whenever `done.failure` is present and `cause` would otherwise
be `"clean"`. Every existing path is unchanged: exit 0 with nothing classified
is still `clean`, a fired limit matcher is still `limit`, a nonzero exit is
still `crash`. This trades a compile-time break - which `tsc` catches
immediately on an exhaustive switch - for eliminating a silent false-clean: a
pi auth failure exits 0, and without `failed` a consumer keeping
`if (cause === "clean") success()` would treat it as a successful turn.

`failure` is lossless, not droppable - it MUST NOT be added to
`DROPPABLE_KINDS`.

**The existing `limit` event is retained and still emitted** for the limit
classes, so a 0.1.3 consumer keeps working unchanged. A `failure` event with
`class` in `{rate-limit, usage-limit, quota}` is accompanied by the
corresponding `limit` event carrying the same `code`.

#### 3.3 Classification sources

Wall matchers are fed only wall-eligible output - stderr lines and the
unparseable tail of a dying turn - and never assistant message content, so a
model discussing a 429 in its own output cannot fabricate a failure. That
invariant is a property of the call sites (`stream-turn.ts`'s stderr pump, and
`decodeLine`'s `JSON.parse` failure branch); parsed records never reach
`detectLimitInLine`.

| Source | Class | Extra fields |
| --- | --- | --- |
| `limitMatchers` hit, code `rate-limit` | `rate-limit` | `code` |
| `limitMatchers` hit, code `usage-limit` / `session-limit` / `weekly-limit` | `usage-limit` | `code` |
| `limitMatchers` hit, code `credits` / `quota` | `quota` | `code` |
| `authMatchers` hit | `auth` | `authKind` |
| claude `rate_limit_event`, status not `allowed` | `rate-limit` | `resetsAt` |
| claude `result` with `is_error: true` | `task` | - |
| codex `item.completed` of type `error` | `task` | - |
| pi `message_end` with `stopReason: "error"` | `auth` | - |
| muse `run_terminal` `failed`, reason matches `/did not reach a terminal state within \d+ step/i` | `budget` | - |
| muse `run_terminal` `failed`, any other reason | `task` | - |
| Spawn failure, pump failure, nonzero exit with nothing else classified | `transport` | - |
| Stall watchdog or turn deadline expiry | `transport` | - |
| `ArgvRefusalError` caught while building argv (no process spawned) | `rejected` | `issue`, `option`/`facet`, `supported` |

`LimitCode` gains `"rate-limit"`, making it `"usage-limit" | "session-limit" |
"weekly-limit" | "credits" | "quota" | "rate-limit"`. This is a union widening
and therefore breaking for an exhaustive switch on `LimitCode`; it is taken
because the alternative - a rate limit that classifies as `usage-limit` - tells
the agent to abandon a provider that will work again in seconds.

pi's `stopReason: "error"` classifying as `auth` is a judgement call recorded
as a risk. <!-- D-018 --> The one verified instance is an expired provider
token; classifying it `task` instead would strand the agent on a dead
provider, which is the worse error. A genuine task failure spelled this way
gets routed once to the next model.

#### 3.4 claude's `rate_limit_event`

The claude content reader gains an arm for the record the decoder discards
today. The fixture at `test/fixtures/a001-raw.ndjson:20` is:

```json
{"type":"rate_limit_event",
 "rate_limit_info":{"status":"allowed","resetsAt":1786358400,
                    "rateLimitType":"five_hour","overageStatus":"rejected",
                    "overageDisabledReason":"org_level_disabled",
                    "isUsingOverage":false},
 "uuid":"...","session_id":"..."}
```

Three rules govern the decoder: <!-- D-016 --> <!-- D-029 -->

1. **`status: "allowed"` is a routine heartbeat, not a wall.** The reader MUST
   classify only records whose `rate_limit_info.status` is not `"allowed"`.
   Treating every `rate_limit_event` as a failure would emit a spurious
   `failure` on every healthy claude turn.
2. **`resetsAt` is a unix epoch in SECONDS** in the source record, and is
   normalized to **milliseconds** on the event by multiplying by 1000. This is
   pure arithmetic - no `Date`, no clock read. That matters: `deps.ts` states
   the execution layer never reads a wall clock and takes `Clock` by
   injection, so formatting an ISO string with `new Date()` would bypass the
   injected clock and make the field untestable against a fake one.
3. **A missing, non-finite, or non-positive `resetsAt` MUST be omitted**, not
   coerced. `new Date(null * 1000)` is 1970-01-01, and an agent that backs off
   until 1970 retries instantly in a loop.

`overageStatus: "rejected"` alongside `status: "allowed"` is deliberately not
classified. It describes overage billing eligibility, not the current wall,
and inventing a `quota` failure from it would fire on healthy turns.

### 4. Serializable matchers

`limitMatchers` and `authMatchers` become data rather than `RegExp` literals,
so `parseOverrides` can extend them. <!-- D-005 -->

```ts
export interface LimitMatcher {
  readonly pattern: string;
  readonly flags?: string;
  readonly code: LimitCode;
}
export interface AuthMatcher {
  readonly pattern: string;
  readonly flags?: string;
  readonly kind: AuthFailureKind;
}
```

**Compilation happens at `parseOverrides` time**, not lazily at first use.
<!-- D-030 --> A pattern that will not compile MUST throw
`OverrideRefusalError` naming the file and harness, exactly as every other
malformed override does. Compiling lazily would defer that error past every
argv refusal to the middle of a turn, where there is no clean way to report
it. Descriptors compiled from code defaults compile once at module load. The
compiled form is cached in a `WeakMap` keyed by the matcher array, so a
descriptor's patterns compile once per process rather than once per line; the
cache stores entries carrying their own code, so two descriptors sharing
`SHARED_LIMIT_MATCHERS` cannot mismap.

The purity gate permits this: it forbids `node:` builtins, `require`,
`process.env`, `Date.now`, `Math.random`, and `Bun.spawn`, none of which
compilation or caching uses.

**Bounds.** <!-- D-030 -->

- `pattern.length` MUST be <= 200.
- At most 64 matchers per harness per kind.
- `flags` MUST be a subset of `imsu`. `g` and `y` are refused: a stateful
  `lastIndex` across lines would make detection order-dependent.
- **Wall scanning applies matchers to at most the first 4096 characters of a
  line.** This is the real backtracking bound. A 200-character pattern with
  nested quantifiers is still exponential against a 65,536-byte line
  (`LINE_MAX`, `src/execution/lines.ts:11`), and pattern analysis for
  catastrophic backtracking is undecidable in general - so the input window is
  what is bounded. Walls are always short; no observed phrasing is near 4096
  characters.

Shared matchers gain rate-limit patterns, so the common cases need no override
at all:

```ts
export const SHARED_LIMIT_MATCHERS: readonly LimitMatcher[] = [
  { pattern: "you'?ve hit your usage limit", flags: "i", code: "usage-limit" },
  { pattern: "usage limit (?:reached|exceeded)", flags: "i", code: "usage-limit" },
  { pattern: "purchase more credits|insufficient credits|out of credits", flags: "i", code: "credits" },
  { pattern: "resource_exhausted|quota exceeded|exceeded your current quota", flags: "i", code: "quota" },
  { pattern: "\\b429\\b|too many requests|rate[ _-]?limit(?:ed|ing)?\\b|retry[- ]after", flags: "i", code: "rate-limit" },
];
```

Ordering matters: the rate-limit pattern is last, so a line containing both
"usage limit" and a 429 classifies as the more specific wall, preserving the
existing first-match-wins discipline. The known cost is that a line like
`429 usage limit exceeded, retry-after 60s` classifies as `usage-limit` and
the "60s" is not captured. Both classes are retryable, so the agent still
pivots correctly; it loses only the backoff hint. **Text matchers never parse
a duration.** <!-- D-034 --> `resetsAt` is populated only from structured
records, and the RFC states that rather than implying the `retry-after`
pattern extracts a value it does not.

`resume.idShape` stays a `RegExp` and stays non-overridable. No consumer need
was identified, and `UUID_SHAPE` is shared across all four descriptors.

### 5. Timeouts

Two independent budgets on `RunnerDeps`: <!-- D-006 -->

```ts
export interface RunnerDeps {
  // ... existing ...
  /** Inactivity budget, rearmed on ANY output chunk, at EVERY granularity. */
  readonly stallMs?: number;
  /** Wall-clock ceiling for the whole turn, armed once and never rearmed. */
  readonly turnTimeoutMs?: number;
}
```

The `granularity !== "none"` guard on `rearm()` is removed. The guard's
original reasoning - that a structured stream proves its own liveness - is
right about *liveness* and wrong about *timeouts*: a healthy token stream
rearms constantly, so arming it covers the hung-provider case the guard
currently makes unreachable.

`turnTimeoutMs` covers the distinct case of a harness that streams forever
without finishing, which no inactivity budget catches.

**Neither budget has a library default.** <!-- D-033 --> A consumer that sets
neither has no turn deadline, exactly as in 0.1.3; a consumer that wants one
MUST set at least one. Injecting a default would silently change the behavior
of every existing caller, and there is no defensible default: a 30-second
inactivity budget is generous for a chat turn and far too short for a build.

Both expire to `cause: "stall"` with `failure = {class: "transport",
retryable: true}` and a message naming which budget fired. The first budget to
fire disarms the other, so the two timers cannot both escalate. The boundary
log distinguishes them:

```
{ event: "stall", turnId, harness, reason: "inactivity",    budgetMs }
{ event: "stall", turnId, harness, reason: "turn-deadline", budgetMs }
```

**Migration hazard.** A 0.1.3 consumer already passing `stallMs` gets a
watchdog on token- and message-granular turns where it previously got none.
A value tuned for `none` granularity may be too tight: a long silent tool call
- a 40-second `bash` invocation producing no harness output - will now trip a
30-second inactivity budget and be reported as a `transport` failure. Existing
`stallMs` values MUST be re-evaluated on upgrade. This is called out in
[Migration](#migration) rather than buried as a behavior note.

### 6. Descriptor verification

Every fact this RFC adds was verified against the installed CLI before being
written down, per the repo's standing rule that a descriptor fact is only as
good as its pin.

| Harness | Fact | Evidence | Pin action |
| --- | --- | --- | --- |
| claude | `--effort <level>` exists, ladder `low, medium, high, xhigh, max` | `claude --help` on 2.1.229 | `verifiedAgainst` 2.1.227 -> **2.1.229** |
| claude | `--setting-sources <sources>` comma-separated (user, project, local) | `claude --help` on 2.1.229 | same bump |
| claude | `--bare` bundles CLAUDE.md discovery with an auth-model change | `claude --help` on 2.1.229 | same bump |
| codex | `--sandbox` values `read-only, workspace-write, danger-full-access` | `codex exec --help` on 0.147.0 | pin unchanged |
| codex | `codex exec resume` accepts `-c <key=value>` and `--json` | `codex exec resume --help` on 0.147.0 | pin unchanged |
| pi | `-nt/-nc/-ne/-ns` long spellings and semantics | `pi --help` on 0.84.1 | pin unchanged |
| pi | `--thinking` ladder `off, minimal, low, medium, high, xhigh, max` | `pi --help` on 0.84.1 | pin unchanged (matches existing) |
| muse | `--reasoning-effort` values `none\|minimal\|low\|medium\|high\|xhigh\|ultra` (default high) | `muse exec --help` on 0.1.0 | pin unchanged (matches existing) |
| muse | `--max-model-steps <N>`, `--disable-write` (non-shell writes only), `--disable-shell` | `muse exec --help` on 0.1.0 | pin unchanged |

The claude pin bump obliges re-running `bun run smoke:seven` and re-capturing
fixtures, per `AGENTS.md`.

**What the weekly job does and does not cover.** <!-- D-031 -->
`.github/workflows/harness-versions.yml` compares each descriptor's
`verifiedAgainst` against the published or installed version and opens an
issue when one is behind. It does **not** inspect `turnOptions`, so it will
not detect that a flag was renamed inside an unchanged version - no check
does, and none can without running the CLI. The new facts are covered in
exactly the sense every existing fact is: a version bump raises the flag, and
re-verification is the local `smoke:seven` run. Claiming more than that would
overstate the guarantee.

`AGENTS.md`'s claim that the package is "source-public only (`private: true`
in `package.json`) - it is not published to npm" is false: `package.json`
carries no `private` field, `publishConfig.access` is `public`, and 0.1.3 is
published. That sentence is corrected as part of this work - a one-line
documentation fix, not a behavior change. <!-- D-019 -->

### 7. Assumptions and spikes

**A-003 - muse signals step-cap exhaustion distinguishably.**

- *Status:* **PASS.**
- *Evidence (muse 0.1.0, two runs at `--max-model-steps 1` and `2`):* the
  terminal record is `payload_type: "run.terminal.failed"` with
  `payload.terminal: "failed"` and
  `payload.reason: "model did not reach a terminal state within 1 step(s)"` /
  `"... within 2 step(s)"`. The string is stable and templated on the cap, so
  `/did not reach a terminal state within \d+ step/i` distinguishes it from an
  ordinary task failure. <!-- D-042 --> muse `exec` exits **1** on step
  exhaustion, not 0 - a useful nuance against the descriptor's blanket note
  that muse exits 0 when the work inside failed, which holds for task failure
  and not for this.

**A-001 - `codex exec resume -c sandbox_mode=<mode>` is enforced, not merely
accepted.**

- *Shipped behavior while deferred:* `resumeRender: null` - a resume carrying a
  sandbox value refuses with `unsupported-on-resume`
  ([section 1.3](#13-per-harness-declarations)). This is also the permanent
  behavior if A-001 fails, so 0.2.0 does not wait on it. <!-- D-020 -->
- *Impact if it passes:* `resumeRender` gains the `-c sandbox_mode` spelling
  and sandboxed multi-turn codex work becomes possible. Purely additive.
- *Experiment:* launch a codex turn with `--sandbox workspace-write`, then
  resume it with `-c sandbox_mode="read-only"` and a prompt that attempts a
  file write; assert the write is refused. Repeat inverted (launch read-only,
  resume `-c sandbox_mode="workspace-write"`, assert the write succeeds) to
  rule out a false pass from a model that simply declined.
- *Pass criteria:* both directions behave as the config value dictates.
- *Status:* **deferred.** Codex is at its usage limit for approximately four
  days from 2026-08-13, and this experiment needs live inference.
  <!-- D-008 --> The plan ships the refusal path, which is safe under either
  outcome, and adds `resumeRender` as a follow-up when A-001 can run.

**A-002 - claude `--effort` is honored on a `-p` headless turn.**

- *Status:* **PASS**, with a caveat that makes validation load-bearing.
- *Evidence (claude 2.1.229):* `claude -p --effort high --output-format
  stream-json --verbose --include-partial-messages` exits 0 with empty stderr
  and a normal turn, so the flag reaches the headless path.
- *Caveat:* claude does **not** enforce its own ladder. `--effort bogus`
  prints to stderr `Warning: Unknown --effort value 'bogus' - ignoring it and
  using the default effort. Valid values: low, medium, high, xhigh, max.` and
  exits 0, running the turn at default effort. The effort setting is echoed
  **nowhere** in the stream - the `system`/`init` record carries `model` but
  no effort field, and `result` carries `usage`/`modelUsage` but no effort.
  A caller therefore has no way to detect that its requested effort was
  discarded. <!-- D-043 --> This is why `renderTurnOptions` MUST refuse an
  out-of-ladder effort rather than pass it through: without the refusal, a
  typo produces a turn that ran at default effort while the router's records
  say `xhigh`, and nothing anywhere contradicts them. The warning line lands
  in `StderrTail` and matches no limit or auth matcher, so it is retained as
  crash context and classifies as nothing - correct.

## State Machine

Failure classification is a per-turn accumulator with one terminal reduction.

```
UNBUILT      --> REJECTED            (on: ArgvRefusalError; no process spawned)
REJECTED     --> DONE                (done.failure = {class:"rejected",...},
                                      exitCode null, cause "failed")

UNBUILT      --> UNCLASSIFIED        (on: successful build and spawn)
UNCLASSIFIED --> CLASSIFIED{...}     (on: matcher hit, decoder arm, or watchdog)
CLASSIFIED{...} --> CLASSIFIED{...+1} (on: any further classification; the SET grows)
CLASSIFIED{...} --> DONE             (on: exit; done.failure = reduce(set))
UNCLASSIFIED  --> DONE               (on: exit 0; done.failure absent, cause "clean")
UNCLASSIFIED  --> CLASSIFIED{transport} (on: nonzero exit or null exit code)
```

`REJECTED` is terminal on its own path: a refused call never spawns, so it can
never accumulate a second classification and needs no reduction.

**There is exactly one reduction rule.** <!-- D-022 --> `done.failure` is
`reduce(set)`: the member whose class ranks highest in the precedence order
below, with ties broken by the earliest classified. It is **not** "the last
classification wins" - under that reading, a turn that hit an auth wall and
then crashed would report `transport`, and a turn that produced a `task`
verdict and then crashed would report `transport` with `retryable: true`,
telling the agent to re-route work that already failed.

Precedence, highest first:

1. `auth` - a credential wall explains everything downstream of it.
2. `rate-limit`, `usage-limit`, `quota` - a provider wall.
3. `budget` - a caller-set cap the model ran into.
4. `task` - the model ran and the work failed.
5. `transport` - the fallback when nothing more specific fired.

Every classification still emits its own `failure` event in stream order; only
the `done.failure` summary is reduced.

## Error Handling

Argv-construction refusals reach the consumer twice: as a typed
`ArgvRefusalError` thrown by the pure builders, and as
`failure class=rejected` + `done cause=failed` from `streamTurn`, which never
throws out of its first `next()`. <!-- D-038 --> Both carry the same
structured fields.

```
failure class=rejected    (severity: critical)  retryable=false
  issue=unsupported-option
       Recovery: drop the option, or route to a harness whose `supported` list has it
       Escalation: NOT a provider failure - descending the model chain fails identically
  issue=unsupported-option-facet   - as above, for one discovery facet
  issue=unsupported-on-resume      - as above; re-launch instead of resuming
  issue=invalid-option-value       - outside the declared vocabulary/range/integrality
  issue=unknown-effort             - `supported` carries the applicable ladder
  issue=invalid-env                - env key grammar or a NUL byte
```

Stream-level failures (events, never throws):

```
failure class=auth        (severity: critical)  retryable=true
       Recovery: agent descends the fallback chain
       Escalation: authKind names the human remedy - re-login vs replace key

failure class=rate-limit  (severity: warning)   retryable=true
       Recovery: back off until resetsAt where present, else descend the chain

failure class=usage-limit / quota (severity: warning) retryable=true
       Recovery: descend the chain; this provider is done for the window

failure class=budget      (severity: warning)   retryable=false
       Recovery: raise the caller-set cap and rerun on the SAME model
       Escalation: repeated exhaustion means the task is mis-scoped, not the cap

failure class=task        (severity: critical)  retryable=false
       Recovery: NONE. The agent MUST NOT re-route this work.
       Escalation: surface to the caller with the turn's own output

failure class=transport   (severity: critical)  retryable=true
       Recovery: descend the chain, or retry the same model once
```

Retry policy is the agent's, not this library's. This library classifies; it
never retries, never backs off, and never spawns a second process for a failed
turn.

The existing contract holds unchanged: multiple `error` and `failure` events
MAY precede `done`, and a consumer treats them as informational and waits for
`done`.

## Security Considerations

**Trust boundaries.** The caller is trusted to supply prompts, models, option
values, `cwd`, and `env`; the harness CLI and its provider are not trusted to
be well-behaved. Descriptors are trusted data compiled into the package;
override files are semi-trusted and validated on load.

**The blast radius this RFC reduces.** Two of the changes exist because the
current library grants more capability than the caller asked for: a pi turn
runs with instruction files and tools live when the caller wanted an isolated
reviewer, and a resumed codex turn regains filesystem write access. Both are
quiet privilege escalations relative to caller intent. The refusal policy in
[1.5](#15-refusals) exists so that the failure mode of an unexpressible
restriction is a loud stop, never a permissive run - which is also why the
codex resume fallback refuses rather than warning. <!-- D-020 -->

**Environment injection is not a new privilege.** `env` lets a caller set
`PATH`, `LD_PRELOAD`, or `NODE_OPTIONS` for the child. This is deliberately
not validated away: a caller that can already choose the binary's argv and
`cwd` can run arbitrary code by construction, so `env` sits at the same trust
level rather than opening a new one. What IS enforced is hygiene that prevents
*accidental* corruption - the key grammar and NUL rejection in
[section 2](#2-per-call-environment) - and the rule that values never reach a
log. A consumer that accepts `env` from a less-trusted source than itself MUST
filter it before passing it here.

**Secrets.** Per-call `env` is the channel a router uses to inject provider
credentials. The library MUST NOT log environment values anywhere;
`envKeys`-only logging is normative, not advisory. `redactArgv`'s existing
position-and-shape redaction is unchanged and still covers argv. Failure
messages carry no harness output content, preserving the existing rule that
records carry identifiers and outcomes, never content.

**Input validation.** Every option value crosses a shell-adjacent boundary
into argv. `enum` values are closed vocabularies; `selector` values go through
`CLEAN_SELECTOR`; `integer` values are integrality- and range-checked. No
option value is ever sanitized - the library refuses, as it does for prompts
and session ids. `config-kv` is restricted to closed-vocabulary specs so a
value can never contain a quote that would change the meaning of the pair it
rides in.

**Override files gain a quieter capability than they had.** Making matchers
overridable is a genuinely different kind of power from rewriting `baseFlags`,
and the difference is visibility, not magnitude: a `baseFlags` rewrite shows up
in `argv` in every `spawn` boundary log, whereas a matcher edit changes
classification while argv stays identical. An override adding
`{pattern: ".*", code: "usage-limit"}` would make every stderr line classify
as a wall, and an agent would abandon healthy providers with nothing in the
log to explain it. Mitigations: the compile-time bounds in
[section 4](#4-serializable-matchers); compilation at load so a bad pattern
refuses immediately; and the `spawn` boundary log gains
`matcherOverrides: {limit: N, auth: N}` per harness when a loaded override
changed them, so a silent reclassification leaves a trace. Override files
SHOULD be treated as code and given the same file permissions and review as
the package itself.

**Prompt injection.** Unchanged and out of scope. Harness output is decoded
into typed events and never executed. Wall matchers are fed only stderr and
the unparseable tail ([3.3](#33-classification-sources)); parsed records never
reach them, and `LineBuffer` drops a line over `LINE_MAX` rather than
splitting it, so assistant text cannot arrive at a matcher by overflow either.
A model talking about rate limits still cannot fabricate a `failure` event.

## Migration

Every break, in one place. Version 0.2.0. <!-- D-011 --> <!-- D-031 -->

| # | Break | Who it hits | Remedy |
| --- | --- | --- | --- |
| 1 | `opts.tools` on codex/pi/muse now throws `ArgvRefusalError` instead of being silently dropped | Callers passing `tools` to a harness with `toolsFlag: null` | Remove the `tools` argument for those harnesses |
| 2 | `ExitCause` gains `"failed"` | Exhaustive switches on `ExitCause` | Add the arm; `tsc` names every site |
| 3 | `LimitCode` gains `"rate-limit"` | Exhaustive switches on `LimitCode` | Add the arm |
| 4 | `vocabulary.effortFlag` removed | Override documents setting it; any reader | Use `turnOptions.effort` |
| 5 | `provider` and `discoveryDisableFlags` removed from the descriptor; `providerFlagOf` and `discoveryDisableFlagsOf` removed | Callers of those two accessors | Read `turnOptions.provider` / `turnOptions.discovery` |
| 6 | codex `launch.baseFlags` no longer contains `--sandbox workspace-write` | Override documents that replace or extend codex `baseFlags` | Set `turnOptions.sandbox.default`, or pass `sandbox` per call |
| 7 | `limitMatchers` / `authMatchers` change from `RegExp` tuples to `{pattern, flags, code\|kind}` objects | Anything reading those fields; override documents | Convert to the object form - which is the point: JSON overrides now work |
| 8 | `deps.stallMs` now arms at every granularity | Consumers already passing `stallMs` | Re-evaluate the value; a budget tuned for `none` granularity may fire during a long silent tool call ([section 5](#5-timeouts)) |
| 9 | `streamTurn` no longer throws `ArgvRefusalError`; it yields `failure` + `done` instead. `ArgvRefusalError.issue` narrows from `string` to `RefusalIssue` | Callers wrapping `streamTurn` in `try`/`catch` for build refusals; anything assigning `issue` to a `string` | Handle `failure class=rejected` in the stream. The direct builders (`buildLaunchArgv`, `buildResumeArgv`, `buildSessionArgv`) still throw, unchanged |

Non-breaking additions: the `failure` event, `done.failure`, `SpawnOptions.env`,
`deps.turnTimeoutMs`, every `turnOptions` field, the structured fields on
`ArgvRefusalError`, and the new shared rate-limit matchers.

Release mechanics: release-please reads Conventional Commits, so the breaking
commits carry `feat!:` / `BREAKING CHANGE:` footers and cut 0.2.0.
`CHANGELOG.md` is release-please's and is not hand-edited.

## Alternatives Considered

**A generic option bag (`options?: Record<TurnOptionKey, string|boolean|number>`)
instead of typed fields.** Attractive because adding an option key would never
change `TurnOptions`. Rejected because the consumer would lose IDE discovery
and compile-time checking on every call site; the descriptor spec table gives
the data-driven rendering either way, so the generic bag buys only a smaller
type and costs the type safety.

**Named profiles per harness (`profile: "isolated-reviewer"`).** Attractive
because it encodes intent rather than flags. Rejected because the consumer
composes dimensions freely - effort high *and* sandbox read-only *and*
provider lmstudio - and any profile set large enough to cover the
combinations is just the option surface with worse names.

**Widening `ExitCause` with every failure class.** Attractive because
`done.cause` would then carry everything in one field. Rejected because it
conflates how the process ended with why the provider refused, and breaks
exhaustive switches for information `done.failure` already carries. Only the
single `"failed"` member is added, and only to remove a silent false-clean.

**Adding structured fields to the existing `error` event instead of a new
`failure` kind.** Smallest diff and fully backward compatible. Rejected
because `error` is documented as informational and non-terminal; overloading
it with the classification the agent's control flow depends on makes the one
event a consumer is told it may ignore also the one it must not.

**Warning instead of refusing on the codex resume sandbox gap.** Considered
and adopted in an earlier draft. Rejected on review: it reproduces the
stringly-typed `auth wall:` signal this RFC removes, and leaves a permissive
run behind an `error` message. The refusal fires only when a sandbox value is
explicitly passed, so ordinary resume is unaffected.

**Refusals as exceptions only.** Attractive because a rejection genuinely is a
caller error rather than a runtime failure, and an exception is the idiomatic
carrier. Rejected because the consumer is sometimes an agent, which would then
have to wrap `streamTurn` in `try`/`catch` **and** consume the event stream to
learn why one call did not run - two channels for one concept, and the
exception is the one channel an `for await` loop does not naturally surface.

**Refusals as events only, with `streamTurn` and the builders both
non-throwing.** Most uniform. Rejected because the pure builders live in the
interpretation layer and returning an event from a pure argv function inverts
the layering; direct callers of `buildLaunchArgv` would also lose the stack
and the fail-fast at the call site. The asymmetry would move rather than
disappear.

**Keeping `RegExp` matchers and adding a programmatic `extendMatchers()`.**
Attractive because it needs no descriptor type change. Rejected because it
leaves the override file - the library's declared extension mechanism -
permanently unable to reach the matchers, and because the consumer would then
carry harness-specific patterns in TypeScript, which is the coupling this
library exists to absorb.

**Leaving timeouts entirely to the consumer.** The abandonment path is already
sound, so a consumer-side deadline is cheap. Rejected because the dead
`granularity === "none"` guard would stay in the codebase advertising a
watchdog that never arms, and because every consumer would re-implement the
same deadline.

**Shipping a default `stallMs`.** Rejected: it would silently change behavior
for every existing caller, and no value is defensible across a chat turn and a
long build.

## Implementation Plan

Phases, with the gate that must pass before the next begins. Detailed
milestones, testing discipline, and landing strategy are assigned during the
planner's DECOMPOSE stage.

1. **Knowledge layer: option specs as data.** `TurnOptionKey`,
   `DiscoveryFacet`, `OptionRender`, `TurnOptionSpec`, `turnOptions` on
   `HarnessDescriptor`; the four per-harness tables; removal of `effortFlag`,
   `provider`, `discoveryDisableFlags`; codex `--sandbox` moved from
   `baseFlags` to the spec default; claude pin bump. Gate:
   `test/knowledge/harnesses.test.ts` and `dimensions-coverage.test.ts`
   updated to assert every declared flag matches the verified spelling.
2. **Interpretation layer: rendering and refusals.** `renderTurnOptions` with
   the ordering, de-duplication, and `resumeRender` rules; builder
   integration before the positional prompt; `RefusalIssue` as a closed union
   and the structured `ArgvRefusalError` fields including `supported`;
   `opts.tools` refusal. Gate: argv tests per harness per option on both
   launch and resume grammars; every refusal carries a non-empty `supported`
   list and a message naming the alternative; purity gate still green.
3. **Serializable matchers.** Type change, load-time compilation with bounds,
   the 4096-character scan window, rate-limit patterns, `parseOverrides`
   reaching matchers, `matcherOverrides` in the boundary log. Gate: an
   override document that adds a matcher round-trips and classifies; an
   uncompilable pattern refuses at load with the file and harness named.
4. **Failure taxonomy.** `FailureClass`, `FailureSummary`, the `failure`
   event, `ExitCause` gaining `"failed"`, the precedence reduction, the
   classification sources, claude's `rate_limit_event` arm, and `streamTurn`
   catching a build refusal into `failure class=rejected` + `done`. Gate: the
   pi exit-0 auth case yields `cause: "failed"` with a self-sufficient
   `done.failure`; a `status: "allowed"` heartbeat emits no `failure`; a turn
   that classifies `auth` then crashes reduces to `auth`, not `transport`; a
   `streamTurn` call with an unexpressible option yields `rejected` with
   `option` and `supported` set and never throws.
5. **Execution plumbing.** `SpawnOptions.env` with the delete-on-empty
   contract and key validation, `envKeys` logging, watchdog at every
   granularity, `turnTimeoutMs`, mutual disarm. Gate: fake-spawn tests for env
   merge and delete, both timeout paths, and an assertion that no env value
   appears in any captured log line.
6. **Verification and docs.** `bun run smoke:seven` re-run, fixtures
   re-captured for the claude pin, README's public-API section updated with
   the option and failure types, `AGENTS.md` publish claim corrected. A-002
   and A-003 were already run and passed during the SPIKE stage
   ([section 7](#7-assumptions-and-spikes)); no spike work remains in this
   phase.

A-001 lands as a follow-up whenever Codex is available again; the plan does
not block on it, because the refusal path is correct under either outcome.

## Open Questions

1. ~~**Should `budget` detection read muse's failure reason?**~~
   **RESOLVED** to option (a) by spike A-003: the reason string is stable and
   templated (`model did not reach a terminal state within N step(s)`), so
   `/did not reach a terminal state within \d+ step/i` is a scoped, verified
   matcher rather than a guess. <!-- D-042 -->
2. **Should `openSession` accept turn options?** This RFC wires them into
   `streamTurn` only. Session mode is claude-only and the consumer is
   spawn-per-turn, so the need is hypothetical. `env` IS wired into both.
   *Decider:* deferred until a consumer asks.
3. **Should a later plan surface runtime version drift?** The RFC scopes this
   out on the grounds that drift is invisible at runtime - but the A-002
   capture shows claude's `system`/`init` record carries
   `claude_code_version` (observed `2.1.229`), so at least one harness
   announces its version in-band. Comparing it to `verifiedAgainst` would give
   a consumer a real staleness signal on the `identity` event. *Out of scope
   here* - it is a separate capability with its own vocabulary question (what
   does a consumer DO with "this descriptor is stale?"). <!-- D-045 -->
   *Decider:* a follow-up plan.

## References

### Normative

- [Normalizer execution-layer capability survey](https://github.com/dungle-scrubs/skills/blob/research/normalizer-execution-survey/research/normalizer-execution-survey.md) - N1. The `file:line`-cited survey of v0.1.3 this RFC responds to; its "Implications for the router" section is the problem statement.
- `AGENTS.md` (this repo) - the three-layer architecture, the purity and chat-seam gates, and the descriptor re-verification rule this RFC must not weaken.
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) - keyword definitions.

### Informative

- [dungle-scrubs/skills#38](https://github.com/dungle-scrubs/skills/issues/38) - the task ticket recording the decision to extend this library rather than have the router compose argv; blocks #31, #32, and #36.
- [dungle-scrubs/skills#33](https://github.com/dungle-scrubs/skills/issues/33) - the research ticket that produced the survey.
- `src/knowledge/descriptor.ts` - the existing closed-vocabulary discipline (`LimitCode`, `AuthFailureKind`, `HarnessMode`) this RFC extends rather than replaces.
