---
number: 02
title: "One owner per rule"
type: refactor
status: Draft
author: Kevin Frilot
date: 2026-09-05
---

# RFC-02: One owner per rule

## Abstract

hcn's three layers are meant to hold harness knowledge once each: facts in a descriptor, translation in interpretation, process lifecycle in execution. The codebase audit of 2026-09-05 found that several rules have two or more owners, and that some owners sit in the wrong layer: the argv token rule is copied seven times inside one function, skills rendering is split between interpretation and two CLI copies joined by a hidden field, the access preset has three descriptor shapes and three co-owners of its sandbox interaction, pi's rpc wire fields live in execution against ADR 0005, and every supervising policy CONTEXT.md names is implemented twice across the two runners. This RFC specifies one owner per rule, in the layer AGENTS.md assigns, with the argv, event, exit-code, and provenance contracts unchanged except for two latent bugs it fixes on the way. Three scope-narrowing deletions the audit surfaced are recorded as open questions for the user, not as requirements.

## Introduction

### Problem statement

`AGENTS.md` states the architecture as three layers with one-way dependencies, and `CONTEXT.md` names the parts that normalize and the six parts that supervise. Both documents assume that each rule has one place to live. The audit found the following departures from that assumption.

1. **A rule copied inside its own module.** The mapping from an `OptionRender` to argv tokens appears seven times in `src/interpretation/turn-options.ts` (`:273-283`, `:384-389`, `:411-417`, `:434-440`, `:462-468`, `:485-491`, `:513-519`). The copies already differ: prompt-text skips TOML quoting and adds `extraFlags` (`:436-437`), and the discovery branch emits `[flag, ""]` for a flag-value render (`:177-178`). `renderTurnOptions` is the most complex function in the repository (cognitive 393, cyclomatic 102, 522 lines).
2. **A rule split across layers through a hidden field.** `renderSkillsSelection` renders pi only and returns `[]` for claude and codex (`src/interpretation/skills-selection.ts:57-67`). Two verbatim CLI copies branch on harness name and pass tokens through `__skillTokens` (`src/cli/run.ts:183-205`, `src/cli/inspect.ts:208-232`); the runner reads the field at `src/execution/stream-turn.ts:196`. The descriptor field meant to drive this, `skills.overridesVia`, has no reader outside the knowledge layer. The refusal hardcodes its support list (`skills-selection.ts:48-52`), the counter-pattern `src/interpretation/support.ts:5-8` says was removed.
3. **One dimension, three shapes, three co-owners.** The access preset is a `tool-preset` on claude and pi, a `flag-value` with a values map on codex, and a `flag-list-by-value` on muse (`src/knowledge/claude-code.ts:201`, `src/knowledge/pi.ts:176`, `src/knowledge/codex.ts:141-146`, `src/knowledge/muse.ts:119-123`). The rule "access displaces codex's sandbox flag" is written at `src/interpretation/resolve-options.ts:149-161` by harness name, at `:266-270`, and at `src/interpretation/turn-options.ts:263`. `validateAccess` runs three times per launch. `renderAccessPreset` (`src/interpretation/tool-selection.ts:65-87`) is a second renderer with no callers.
4. **Harness wire fields in execution.** ADR 0005 states the execution layer "holds no harness-specific field names". `src/execution/open-session.ts:437-445` encodes pi's identity-probe command and `:462-515` decodes its response with pi's `type`, `success`, `command`, and `data.sessionId` fields hardcoded. The layering gate forbids only the literal `"user"` (`test/execution-layering.test.ts:43-73`).
5. **Supervision written twice.** Escalation, the stall clock, the stderr classification loop, question detection, and last-assistant tracking exist in both `src/execution/stream-turn.ts` (`:310-317`, `:352-372`, `:523-553`, `:489-521`, `:456-458`) and `src/execution/open-session.ts` (`:210-213`, `:226-249`, `:550-574`, `:302-337`, `:388-390`).
6. **Precedence hand-rolled per command.** Question-mode precedence is computed at `src/cli/run.ts:262-281` and again at `src/cli/session.ts:110-166`; timeout at `src/cli/run.ts:398-402`; `resolveEffectiveOptions` already passes both keys through with a tier (`src/interpretation/resolve-options.ts:335-348`). The value list `ask, assume, none` is restated in four files while `QUESTION_MODES` and `isQuestionMode` have no callers.
7. **Descriptor data with no consumer.** `tools.composable`, `tools.denySemantics`, and `launch.toolsFlag` have no behavioural reader; `tool-selection.ts:143-144` re-derives `denySemantics` by hand. The descriptor header (`src/knowledge/descriptor.ts:5-9`) says a key without a consumer arm "can only drift".
8. **Vocabularies restated as lists.** `SUPPORTED` (`src/cli/index.ts:8`) restates `HARNESS_NAMES`; `HARNESS_MODES` (`src/cli/inspect.ts:15`) restates a type with no runtime array; `enumAt` (`src/knowledge/overrides.ts:69-91`) restates eight enums and omits four; `TOOL_SELECTOR` and `CLEAN_SELECTOR` are the same regex; the matcher bounds are implemented in both `src/interpretation/limits.ts:52-68` and `src/knowledge/overrides.ts:156-193`.
9. **Refusals that name a harness nobody chose.** Ten sites in `src/cli/args.ts` and three elsewhere fill the required `harness` field with the literal `"claude"` before a harness is known. The `--timeout` refusal labels itself `option: "maxSteps"` (`src/cli/args.ts:260`).

### Scope

In scope: every candidate the audit ranked High or Medium, and the Low candidates that are pure relocations. Each becomes a numbered change in Proposed Changes with its owner named.

Out of scope, each with its reason:

- **Whether the override file feature stays.** `parseOverrides` has no caller outside its own index. Keeping it means threading a `DescriptorSet` through five interpretation functions; deleting it removes about 280 lines. That is a functionality decision under the fit check and is Open Question 1.
- **Whether the lucid-era modules stay.** `parse-resume.ts`, `presence.ts`, and `resume-last.ts` have only test callers. Deleting them narrows the codebase, not the product, but it is the user's call. Open Question 2.
- **Whether `contextHook` stays.** No execution code calls `contextEventFrom`; README calls the `context` event reserved. Open Question 3.
- **Any new capability.** This RFC adds no flag, no event kind, no config key. Two latent bugs are fixed because the single owner cannot reproduce them; they are named in Risk Assessment.
- **Restructuring `content.ts`, `hints.ts`, `AsyncChannel`, `LineBuffer`, or `node-deps.ts`.** The audit examined each and cleared it.

### Motivation

The cost is already visible. The seven token-rule copies disagree. The two skills copies append their tokens after the passthrough separator in the runner (`src/execution/stream-turn.ts:191-199`) but before it in the spawn preview (`src/cli/run.ts:317-326`), so the spawn line and the real argv differ when both are used. The access preset never consults the resume phase, so `--access read --resume <id>` on codex renders `--sandbox read-only`, which `codex exec resume` rejects (the sandbox turn option gained a `resumeRender` for exactly this at `src/knowledge/codex.ts:130-139`). Each is a symptom of a rule with more than one owner.

### Context

RFC-01 established the escalation record on `done` and left its open question 2 unanswered: whether the record "falls out for free" on sessions. It does not fall out; it is written twice. Change 5 answers that structurally.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Layer**: one of `knowledge` (`src/knowledge`), `interpretation` (`src/interpretation`), `execution` (`src/execution`), or `cli` (`src/cli`), as `AGENTS.md` defines them. Dependencies point one way: knowledge, then interpretation, then execution, then cli.
- **Rule**: one fact or decision the product depends on: how a render becomes tokens, which flag a preset displaces, when a turn has stalled.
- **Owner**: the one module that implements a rule. Every other module calls the owner.
- **Descriptor**: the immutable data describing one harness, per `CONTEXT.md`.
- **Turn option** and **spec**: a per-call dimension keyed by `TurnOptionKey`, and the descriptor entry that says how a harness renders it.
- **Render**: an `OptionRender` value: `flag-value`, `config-kv`, or `flag-list`.
- **Hidden field**: a property with a double-underscore name placed on an options object so one layer can pass data to another outside the declared interface. Today: `__explicitPrompt` and `__skillTokens`.
- **Supervising policy**: one of the six parts `CONTEXT.md` lists under "What hcn supervises".
- **Contract surface**: the outputs consumers depend on: argv per input, the `HarnessEvent` stream, exit codes, provenance lines on stderr, the structured fields of a refusal, and the `hcn session --json` framing.

## Current State

```
knowledge          interpretation                execution               cli
---------          --------------                ---------               ---
descriptor.ts      turn-options.ts (7 copies     stream-turn.ts  }       run.ts     } skills x2,
  access: 3 kinds    of render->tokens)          open-session.ts } x2    inspect.ts } precedence,
  skills.overridesVia   skills-selection.ts         supervision           session.ts   refusals
  (unread)            (pi only) ----__skillTokens-----> :196 <---------- :183-205
  composable,         resolve-options.ts:149      open-session.ts         args.ts
  denySemantics,        h.name === "codex"          pi rpc fields           harness:"claude" x10
  launch.toolsFlag    tool-selection.ts             :437-515
  (unread)              renderAccessPreset (dead)   decode.ts:116
  overrides.ts          hasCounterpart (imported,     h.name === "claude"
    enumAt (8 of 12)    unused)
```

Three patterns produce the state above.

**Interpretation grew by case, not by rule.** Each turn-option kind got its own render-to-tokens block; each harness shape got its own access spec; each caller of the counterpart test inlined it. The helpers that would own these rules exist (`resolveRender`, `hasCounterpart`, `nativeFor`, `QUESTION_MODES`) and are not called.

**The CLI absorbed rules that need I/O.** Skills rendering needs a directory listing, so the CLI took the whole rule instead of supplying the listing. Question-mode precedence needed to run on resume, where the resolver does not run, so each command re-derived it.

**Execution absorbed one harness's protocol.** pi's rpc session needs an identity round trip. The descriptor carries the command name; execution carries the request encoding and the response shape.

## Proposed Changes

Ordered by the audit's ranking. Each change names its owner and its interface. Section headings carry the change number used in Migration Strategy and Implementation Plan.

### Invariants

The contract surface MUST NOT change under this RFC, with two exceptions named in Risk Assessment (R1, R2) and two visible-but-uncontracted changes named there (R3, R4).

The purity gate (`test/interpretation/purity.test.ts`) and the chat-seam gate (`test/no-chat-imports.test.ts`) MUST pass unchanged. No change in this RFC MAY add an import from interpretation into knowledge or from execution into interpretation's callers.

A hidden field MUST NOT survive this RFC. `__skillTokens` is removed by change 2 and `__explicitPrompt` by change 13.

### 1. `tokensFor` owns render-to-tokens

Owner: `src/knowledge/descriptor.ts`, beside `resolveRender`.

```ts
export type Quoting = "toml" | "verbatim";

/** The argv tokens one resolved render produces for one value. */
export const tokensFor = (
  render: OptionRender,
  value?: string,
  quoting: Quoting = "toml",
): readonly string[];
```

- `flag-value` MUST produce `[...extraFlags, flag, value]`. A `flag-value` render with no value MUST throw; it is a descriptor error, not an empty token. Today only claude's `systemPrompt` declares `extraFlags`, so emitting them for every flag-value render changes no output.
- `config-kv` MUST produce `[flag, "<key>=<quoted>"]`, where `toml` quoting is `JSON.stringify` (as `tomlQuote` is today) and `verbatim` quoting is the value unchanged.
- `flag-list` MUST produce `flags` and MUST ignore `value`.
- Every arm of `renderTurnOptions` MUST validate, resolve the phase render, and call `tokensFor`. The seven inline copies MUST be deleted. `prompt-text` passes `verbatim`; every other kind passes `toml`.

### 2. Skills rendering is descriptor-driven

Owner: `src/interpretation/skills-selection.ts`, dispatching on `h.skills`.

```ts
// argv.ts
readonly skills?: {
  /** Resolved absolute paths of the caller's picks. */
  readonly picks: readonly string[];
  /** Every skill name in the registry the picks came from. */
  readonly known: readonly string[];
};
```

- The CLI MUST supply `known` from its directory listing (`src/cli/skills-root.ts`) and MUST NOT compute tokens. The filesystem read stays in the CLI; the rule moves out of it.
- `renderSkillsSelection(h, skills)` MUST render all three harnesses: pi through `h.skills.loadFlag` plus the `discovery.skills` facet render taken from the descriptor (not a literal `-ns`); claude and codex through `h.skills.overridesVia` (`settings-skilloverrides` and `config-skills-array`). `claudeSkillOverridesArg` and `codexSkillConfigArg` become private to the module.
- Skill tokens MUST be part of the argv `buildLaunchArgv` returns, before any passthrough separator. See R1.
- `spellingOf` in `src/interpretation/support.ts` MUST gain a `skills` arm reading `h.skills`, and the refusal at `skills-selection.ts:48-52` MUST call `supportedBy` instead of a literal list.
- `__skillTokens` MUST be deleted from `run.ts`, `inspect.ts`, and `stream-turn.ts`.

### 3. One access spec

Owner: `src/knowledge/descriptor.ts` for the shape; `renderTurnOptions` for the one rendering arm.

```ts
| {
    readonly kind: "access";
    /** Per value: a phase-aware render, the marker for "render the read
     *  preset through the tool list", or null for "emit nothing". */
    readonly renders: Readonly<Record<"read" | "write", SpecBase | "tool-preset" | null>>;
    /** The turn option this preset displaces when set (codex: sandbox). */
    readonly claims?: TurnOptionKey;
  }
```

Descriptor values:

| harness | read | write | claims |
|---|---|---|---|
| claude | `"tool-preset"` | `null` | - |
| pi | `"tool-preset"` | `null` | - |
| codex | `flag-list ["--sandbox","read-only"]`, resume `config-kv sandbox_mode` | `flag-list ["--sandbox","workspace-write"]`, resume likewise | `sandbox` |
| muse | `flag-list ["--disable-write","--disable-shell"]` | `null` | - |

- The `tool-preset`, `flag-value` (with values), and `flag-list-by-value` spec kinds MUST be deleted. `getOptionRender` and `resolveResumeRender` MUST be deleted; both have no callers.
- `renderAccessPreset` in `tool-selection.ts` MUST be deleted. The read-preset filter MUST exist once, in the access arm, and MUST use `hasCounterpart` (change 8).
- The rule "a set access displaces the claimed option's profile default and refuses an explicit value of it" MUST read `spec.claims`. The branches at `resolve-options.ts:149-161`, `:266-270`, and `turn-options.ts:263` MUST be replaced by that one read. No interpretation function MAY branch on `h.name` for this rule.
- `validateAccess` MUST run once per resolution, in `resolveEffectiveOptions`. The two calls in `renderTurnOptions` MUST be removed.
- The access arm MUST resolve the phase through `resolveRender` like every other spec. See R2.
- `spellingOf` for `access` MUST return the first token of `renders.read` when it is a render, or `h.tools.includeFlag` when it is `"tool-preset"`.

### 4. pi's rpc protocol lives in interpretation

Owner: `src/interpretation/session-input.ts`.

```ts
// descriptor.ts
readonly identityProbe: {
  readonly command: string;
  /** Dot-path to the session id in the probe response. */
  readonly responseIdField: string;
} | null;

// session-input.ts
export const encodeIdentityProbe = (h: HarnessDescriptor): string | null;
export type SessionRecord =
  | { readonly kind: "identity"; readonly sessionId: string }
  | { readonly kind: "probe-failed"; readonly message: string }
  | { readonly kind: "command-failed"; readonly message: string }
  | { readonly kind: "turn-end"; readonly isError: boolean }
  | { readonly kind: "content" };
export const decodeSessionRecord = (h: HarnessDescriptor, parsed: Record<string, unknown>): SessionRecord;
```

- `open-session.ts` MUST call `encodeIdentityProbe` at spawn and `decodeSessionRecord` per parsed line, and MUST branch on `kind` only. The `matches()` helper at `open-session.ts:424-432` MUST be deleted; turn-end detection moves into `decodeSessionRecord`, which reuses the match loop `decodeIdentity` already owns.
- The marker ids `hcn-identity` and `hcn-send` MUST be constants in `session-input.ts`.
- `test/execution-layering.test.ts` MUST extend its literal scan to the descriptor and encoder protocol literals: `"response"`, `"get_state"`, `"hcn-identity"`, `"hcn-send"`, and `"prompt"`. The gate then fails if the rule moves back.

### 5. One turn supervisor

Owner: a new execution-private module, `src/execution/supervisor.ts`, composed by both runners.

```ts
export interface TurnSupervisor {
  /** Stall clock: arm at turn start, rearm on any output, disarm at turn end. */
  arm(): void; rearm(): void; disarm(): void;
  /** SIGTERM now, SIGKILL after KILL_GRACE_MS unless the process exits. */
  escalate(): void;
  /** One stderr line: a limit, an auth wall, or plain tail. */
  classifyStderr(line: string): { kind: "limit"; code: LimitCode } | { kind: "auth"; auth: AuthFailureKind } | { kind: "tail" };
  /** The turn's last assistant message, tracked only when detection is armed. */
  noteAssistant(text: string): void;
  /** At turn end: the question event if any, the detection, and the failures to record. */
  close(): { question?: QuestionEvent; detection: EscalationDetection; failures: readonly FailureSummary[] };
}
```

- `questionEventOf(text)` MUST be added to `src/interpretation/question.ts` and MUST be the only place a detected block becomes a `question` event and an `EscalationDetection`. The two constructions at `stream-turn.ts:513-520` and `open-session.ts:329-336` MUST call it.
- Both runners SHOULD construct one `TurnSupervisor` per turn (the session runner: per turn, scoped as its stall clock is today) and SHOULD delete their private copies of the five policies. The observable event order per turn MUST NOT change; the execution test suite pins it.
- The plain-line limit scan at `open-session.ts:450-456` MUST call `decodeLine` (which already owns that rule at `decode.ts:37-47`) instead of repeating it.
- This change carries the highest churn in the RFC and lands last (Implementation Plan, phase 5).

### 6. `resolveBehavior` owns hcn-owned behaviour precedence

Owner: `src/interpretation/resolve-options.ts`.

```ts
export type BehaviorTier = "arg" | "project-config" | "user-config" | "default";
export interface ResolvedBehavior {
  readonly questions: { readonly value: QuestionMode; readonly tier: BehaviorTier };
  readonly timeoutSeconds: { readonly value: number | undefined; readonly tier: BehaviorTier };
}
export const resolveBehavior = (
  args: { questions?: QuestionMode; timeoutSeconds?: number },
  tiers: ConfigTiers,
): ResolvedBehavior;
```

- `run.ts` (launch and resume) and `session.ts` MUST obtain question mode and timeout from `resolveBehavior`. The hand-rolled chains at `run.ts:262-281`, `run.ts:398-402`, and `session.ts:110-166` MUST be deleted. The provenance line `provenance: questions = <mode> (<tier>)` MUST be printed from the returned tier so its text is unchanged.
- `args.ts`, `session.ts`, and `config.ts` MUST validate question mode through `isQuestionMode` and MUST NOT carry their own value lists. `EscalationMode` in `events.ts` MUST become `QuestionMode`.
- `--stall` stays CLI-only with no config key; adding one is out of scope.

### 7. Descriptor fields are consumed or deleted

Owner: `src/knowledge/descriptor.ts` for the shape; the named consumer for each field.

- `tools.denySemantics` MUST drive the three-way branch in `renderToolSelection`: `no-lists` refuses, `policy-gate` renders category switches, `remove-from-set` renders name lists. `isCodexShape` and `isCategoryShape` at `tool-selection.ts:143-144` MUST be deleted.
- `tools.composable` MUST be deleted. `renderToolSelection` refuses include and exclude together on every harness regardless of it.
- `launch.toolsFlag` MUST be deleted; `hcn inspect` MUST print `tools.includeFlag` in its place (R4).
- `src/interpretation/dimensions.ts` MUST be deleted; `stream-turn.ts` reads `h.stdin` directly.
- `test/knowledge/dimensions-coverage.test.ts` MUST be re-anchored to the `HarnessDescriptor` type's key set rather than the absent PLAN.md table. The test keeps its purpose: a key added without a consumer fails it.
- `contextHook`, `resumeLast`, and `presence` are decided by Open Questions 2 and 3.

### 8. One toolMap shape; helpers are called

Owner: `src/interpretation/tool-vocabulary.ts`.

- The merged shape (`MergedToolMap`, tier included) MUST be the only toolMap shape past `mergeToolMaps`. `TurnOptions.toolMap` MUST carry it. The "legacy shape" conversion at `resolve-options.ts:184-192` and the runtime shape-sniffing in `hasCounterpart` and `nativeFor` (`tool-vocabulary.ts:121-161`) MUST be deleted.
- `renderToolSelection` MUST call `hasCounterpart` and `nativeFor`; the four inline counterpart tests (`tool-selection.ts:165`, `:186`, `:228`, `:273`) and three inline native lookups MUST be deleted.
- `canonicalToolTable` MUST be deleted. The branch at `tool-selection.ts:249-260` MUST collapse to its single body.

### 9. Closed vocabularies have one runtime owner

Owner: `src/knowledge/descriptor.ts` for enums; `src/knowledge/matchers.ts` for matcher bounds; `src/interpretation/vocabulary.ts` for the selector grammar.

- Every closed string union on `HarnessDescriptor` MUST be declared as an `as const` array with its type derived, the pattern `HARNESS_NAMES` and `SESSION_INPUT_KINDS` already use: `HARNESS_MODES`, `STREAMING_GRANULARITIES`, `STDIN_POLICIES`, `CWD_SLUGS`, `RESUME_STYLES`, `RESUME_ON_MISSING`, `IDENTITY_AUTHORITIES`, `DENY_SEMANTICS`, `SKILLS_OVERRIDES_VIA`, `VERSION_SOURCE_KINDS`.
- `src/cli/index.ts` MUST use `HARNESS_NAMES`; `SUPPORTED` MUST be deleted. `src/cli/inspect.ts` MUST use `HARNESS_MODES`.
- If overrides stay (Open Question 1), `enumAt` MUST be a path-to-array table built from those constants and MUST cover every closed path, including the four it omits today.
- One selector regex MUST exist. `TOOL_SELECTOR` MUST be deleted and its users import `CLEAN_SELECTOR`.
- `compileMatcher(pattern, flags)` and the bounds (`MAX_PATTERN_LENGTH`, `MAX_MATCHERS_PER_KIND`, allowed flags) MUST live in `src/knowledge/matchers.ts`, pure. `limits.ts` and `overrides.ts` MUST both import them. The knowledge layer already exports functions from `descriptor.ts`, so this adds no impurity.

### 10. `planTurn` owns the parse-refuse-resolve-build protocol

Owner: a new `src/cli/plan-turn.ts`.

```ts
export interface TurnPlan {
  readonly argv: readonly string[];
  readonly options: TurnRunOptions;
  readonly provenance: readonly ProvenanceEntry[];
  readonly unrenderable: readonly string[];
  readonly behavior: ResolvedBehavior;
}
export const planTurn = (h: HarnessDescriptor, rawArgs: readonly string[]): Promise<TurnPlan | Refusal>;
```

- `run` MUST spawn from the plan's `argv` and options; `inspect --argv` MUST print the plan's `argv`. The two therefore agree by construction, including skill tokens and passthrough placement.
- `inspect.ts` MUST report refusals through `refuse()`; its six hand-written stderr sequences MUST be deleted.
- The resume-alias exclusivity check MUST exist once, in `args.ts`, and `inspect.ts` and `session.ts` MUST call it.
- `run.ts` MUST compute its exit code through `exitCodeForCause`, or that function MUST be deleted; one of the two, not both as today.

### 11. A refusal names a harness only when one was chosen

Owner: `src/interpretation/refusal.ts`.

- `ArgvRefusalError.harness` MUST become optional. `buildRefusalMessage` MUST omit the "on <harness>" and "<harness> cannot" fragments when it is absent. The thirteen literal `"claude"` fills MUST be removed.
- `RefusalOption` MUST gain `"timeout"`, and the `--timeout` refusal at `args.ts:254-266` MUST use it. The change is additive on the wire.

### 12. Relocations with one owner each

- `composeAnswer` MUST live in `src/interpretation/question.ts` beside the other preambles; `session.ts:387` and `session-json.ts:75-76` MUST call it.
- Every failure constructor in `src/execution/failure.ts` MUST take `retryable` from `retryableOf`.
- claude's `rate_limit_event` decoding MUST move from `decode.ts:116-143` into the claude reader in `content.ts` as a `limit`-class content event carrying `resetsAt`. `decode.ts` MUST NOT branch on `h.name`.
- `scripts/check-versions.ts` and `scripts/demo.ts` SHOULD import `src/cli/check.ts`'s resolver and `src/cli/render.ts`'s `renderEvent` instead of re-implementing them.
- The exports the audit found without callers MUST be deleted: `hintForDescriptor`, `autonomyFlagOf`, `toolsFlagOf`, `compileMatchers`, `exitCodeForRefusal`, `deepFreezeSafe` (use `deepFreeze`), `detectLimit`, `detectAuthFailure`. `DROPPABLE_KINDS` MUST be the set both runners consult; the inline sets at `stream-turn.ts:417-418` and `open-session.ts:400-402` MUST be deleted.
- The stale comments at `src/knowledge/pi.ts:52` and `src/interpretation/session-input.ts:46` (hcn queues sends itself) MUST be corrected; ADR 0007 removed the queue. README lines 99-105 MUST drop the `queued` disposition.

### 13. The prompt carries its own provenance

Owner: `src/interpretation/argv.ts`.

```ts
readonly prompt: string | { readonly text: string; readonly explicit: boolean };
```

- `TurnOptions.prompt` MAY be a string (implicit, positional) or the object form. `assertCleanPrompt` MUST apply only when `explicit` is false. `__explicitPrompt` MUST be deleted from `argv.ts`, `run.ts`, and `inspect.ts`.
- Every consumer that reads `opts.prompt` as a string (`streamTurn`, `redactArgv`) MUST read the text through one accessor `promptTextOf(opts)`.

## Migration Strategy

Every change is a relocation with a fixed contract surface, so migration is a sequence of commits each of which leaves `pnpm check` green and the snapshot corpus (Testing Strategy) unchanged, except where R1 or R2 applies.

1. **Capture the baseline first.** Before any change lands, the snapshot corpus is generated from the current tree and committed. It is the compatibility guarantee for everything that follows.
2. **Land in the phase order of Implementation Plan.** Phases 1 through 4 are independent of one another at the file level; phase 5 depends on change 5's `questionEventOf` and on change 4 having emptied `open-session.ts` of protocol code.
3. **No dual-write period.** There is no wire change, so no consumer needs a flag or a compatibility window. The `RefusalOption` addition in change 11 is additive.
4. **Rollback is a revert.** Each phase is one or more commits with no data migration. Reverting restores the previous copies of each rule.
5. **Conventional commits.** Changes 1, 3 through 13 are `refactor:`; the two bug fixes are `fix:` commits landed inside their phase so release-please records them. The visible `hcn inspect` output change (R4) is noted in the commit body, not marked breaking, per Open Question 6.

## Risk Assessment

**R1 - skill tokens move before the passthrough separator (change 2).** Today the runner appends them after `--` (`stream-turn.ts:191-199`). A run with both `--skills` and passthrough on claude currently hands `--settings` to the harness as a positional after the separator; after this RFC it is a flag. This is a fix, not a regression, and is not covered by any deterministic test today. Verification: a new argv test with both options set.

**R2 - codex access on resume renders through `sandbox_mode` (change 3).** Today `--access read --resume <id>` on codex emits `--sandbox read-only`, which `codex exec resume` rejects as a native error (evidence: the `resumeRender` on the sandbox spec, `codex.ts:130-139`, exists for the same reason). After this RFC the resume phase renders `-c sandbox_mode="read-only"`. Verification: an argv test for the resume phase and one live run through `scripts/e2e.ts`.

**R3 - refusal message prose for pre-harness refusals changes (change 11).** Messages such as `invalid value for option "questions" on claude` lose the `on claude` fragment when no harness was chosen. The structured fields (`issue`, `option`, `supported`) are unchanged. Consumers are documented as branching on fields, not prose (ADR 0002).

**R4 - `hcn inspect <harness>` prints a different descriptor shape (changes 3, 7).** `turnOptions.access` changes shape; `launch.toolsFlag` and `tools.composable` disappear. README documents `hcn inspect` as printing the descriptor, without a schema. Whether that dump is a compatibility surface is Open Question 6; the recommendation is that it is not.

**R5 - the supervisor touches the two most complex async functions (change 5).** `streamTurn` (cognitive 126) and `openSession` (cognitive 121) hold timing-sensitive state: escalation timers, pipe grace, backpressure release, abandonment. Extracting the five policies changes closure boundaries. Mitigation: phase 5 is last, lands as its own PR, and is gated on the full execution suite plus `smoke:seven` and `scripts/e2e.ts` session scenarios against installed harnesses.

**R6 - descriptor shape changes touch four files that are also fixture evidence (changes 3, 7, 9).** The descriptors cite fixtures under `test/fixtures/`; the fixtures themselves are not edited by this RFC and MUST NOT be.

**Blast radius if a change is wrong.** A wrong token rule produces a wrong argv on every launch; the argv snapshot corpus catches that before merge. A wrong supervisor produces a hung or mis-classified turn; the fake-clock execution tests catch stall and escalation ordering, and the live smokes catch the rest. Nothing in this RFC touches credentials, the filesystem beyond what the CLI already reads, or the harness stores.

## Security Considerations

**Trust boundaries are unchanged.** hcn still trusts its descriptors and config tiers, still treats harness stdout as the least trusted input (`src/interpretation/session-id.ts` header), and still writes its escalation preamble into the model's context. This RFC moves rules between hcn's own modules and adds no new input.

**Input validation moves with its rule and MUST NOT weaken.** The session-id shape check, the selector grammar, the tool-name grammar, the env-key grammar, and the matcher bounds each keep one owner and one call site per boundary. Change 9 replaces two matcher validators with one; the bounds it enforces (pattern length 200, 64 matchers per kind, flags limited to `imsu`, no `g` or `y`) are unchanged and are the defence against a crafted override file causing catastrophic backtracking.

**Permissions model.** The access preset is a permission surface: `read` narrows what a harness may do. Change 3 gives that rule one owner and makes it phase-aware, which closes R2, where a resumed codex turn today either fails or, if a future codex accepted the flag silently, would run wider than the caller asked. A single owner for "which option does access displace" also means a future harness cannot be added with the rule forgotten.

**Prompt injection surface.** `ESCALATION_PREAMBLE` and its permissions clause are not edited. `composeAnswer` moves without a wording change. The layering gate extension in change 4 does not change what reaches a model.

**Blast radius.** The worst case is a wrong argv or a wrong exit classification on one process hcn spawned. hcn holds no credentials and touches no store; the harness authenticates under the user's own session, as README states.

**Data sensitivity.** No change alters redaction. `redactArgv` still masks the prompt slot by position and secret-shaped tokens by pattern. `promptTextOf` (change 13) MUST be the accessor `redactArgv` uses so the prompt slot is still found when the prompt is the object form.

## Testing Strategy

The existing suites pin the contract surface and are the primary regression net: `test/interpretation/argv.test.ts`, `access-preset.test.ts`, `tool-selection.test.ts`, `skills-selection.test.ts`, `resolve-options.test.ts`, `cross-harness-refusals.test.ts` for argv and refusals; `test/execution/*` for the event stream under fake clock and fake spawner; `test/cli/cli.test.ts`, `session-json.test.ts`, `session-terminal.test.ts` for the CLI. Both lanes (`vitest`, `bun test`) MUST stay green after every phase.

Additions this RFC requires:

1. **An argv snapshot corpus.** A deterministic test that builds launch and resume argv for every harness across a matrix of turn options (each turn option at one non-default value, each discovery facet off, access read and write, tools include and exclude, skills with a fixed `known` list, passthrough present) and compares against committed snapshots. Captured before phase 1 from the current tree. R1 and R2 are the only expected diffs, each updated in its own commit with the reason in the message.
2. **Layering gate extension** (change 4): the protocol literals list.
3. **README contract test extension** (change 12): the disposition vocabulary (`started`, `rejected`) and the session control event kinds (`session`, `turn`, `disposition`, `closed`), so the `queued` regression cannot recur.
4. **Descriptor consumer test** (change 7): for each field named in the re-anchored coverage test, a grep-based assertion that at least one non-knowledge, non-test file reads it. This is the mechanism that makes the "dead data can only drift" comment enforceable.
5. **Both-options argv test** (R1) and **codex access resume test** (R2).
6. **Live verification, on demand only:** `bun run smoke:seven` and `bun scripts/e2e.ts` after phases 2, 3, and 5, against the installed harnesses at their `verifiedAgainst` versions. These are nondeterministic and stay out of `pnpm check`, as `AGENTS.md` already requires.

## Implementation Plan

Each phase is one or more PRs. The gate between phases is: `pnpm check` green in both lanes, the snapshot corpus unchanged (or changed only by the named fix), and no new hidden field.

**Phase 0 - baseline.** Commit the argv snapshot corpus and the layering-gate and README-contract extensions in their failing-or-passing state as appropriate. Delivers: the regression net. No production code changes.

**Phase 1 - single-file owners.** Changes 1, 9 (constants, one regex, one matcher compiler), and the relocations in 12 that touch one file each (`retryableOf`, `composeAnswer`, dead exports, stale comments). Every item is independent of the others. Rollback: revert the commit.

**Phase 2 - descriptor-driven rendering.** Changes 3, 2, 7, 8, in that order: the access spec first because change 7's `denySemantics` consumer and change 8's helper calls both touch `renderToolSelection`. R1 and R2 land here as `fix:` commits. Go/no-go: `scripts/e2e.ts --only tools` and `--only skills` against claude and pi.

**Phase 3 - layer seams.** Changes 4, 11, and the `rate_limit_event` move from 12. Extends the layering gate. Go/no-go: `scripts/e2e.ts` session scenarios on pi (the identity probe path) and `test/execution/session-questions.test.ts`.

**Phase 4 - CLI.** Changes 6, 10, 13, and the scripts item from 12. Depends on phase 2 (skills in the plan) and phase 3 (refusal shape). Go/no-go: `test/cli` and a manual `hcn inspect <h> --argv` against `hcn run <h> --json`'s spawn line for each harness, which MUST match.

**Phase 5 - the supervisor.** Change 5. Depends on phase 3 (protocol code out of `open-session.ts`) and on `questionEventOf`. Its own PR. Go/no-go: the full execution suite, `smoke:seven`, and the e2e session scenarios on claude and pi.

Open Questions 1 through 3 SHOULD be answered before phase 2 begins, because their answers decide whether `DescriptorSet` is threaded (1) and which descriptor fields phase 2 deletes (2, 3). Phases 0 and 1 do not depend on them.

## Open Questions

1. **Does the override file feature stay?** `parseOverrides` has no caller outside its own index, so the feature README's Reference section describes cannot be reached from the CLI. Options: (a) wire it as a config tier and thread a `DescriptorSet` through `argv.ts`, `tool-selection.ts`, and `resolve-options.ts`, honouring the rule `support.ts:10-12` states; (b) delete `parseOverrides`, `matcherOverridesOf`, `enumAt`, the `matcherOverrides` field on the spawn log, and `test/knowledge/overrides.test.ts`, and let `defaultDescriptors()` be the constant set. Fit check: no user reaches the feature today; the need it served (patching facts ahead of a release) is served by `verifiedAgainst`, `hcn check`, and a release. Recommended: (b), a narrowing. This is the user's decision because it removes documented functionality.
2. **Do the lucid-era modules stay?** `parse-resume.ts`, `presence.ts`, and `resume-last.ts` have only test callers, and they alone keep the `resumeLast` and `presence` descriptor fields alive. Options: keep as reserved capability, or delete the three modules, the two fields, and their tests. Recommended: delete; `hcn` exposes no command that needs them and ADR 0007 places cross-run correlation with the caller. The user's decision because it narrows.
3. **Does `contextHook` stay?** No execution code calls `contextEventFrom`, and README calls the `context` event reserved. Options: keep the field and the decoder until a statusline channel is wired, or delete both and keep only the event kind reserved. Recommended: delete the field and decoder, keep the kind. User's decision.
4. **Machine-made: the scope of this RFC.** The audit's High, Medium, and relocation-only Low candidates are specified in one RFC rather than one RFC per High candidate, on the basis that they share one design decision (one owner per rule, in its layer) and one regression net. Reversible by splitting the numbered changes into separate RFCs; the change numbering is stable for that purpose.
5. **Machine-made: the RFC type.** Taken as `refactor` without confirmation. Every change restructures existing code and none adds a capability. Reversible by re-running the init script.
6. **Is the `hcn inspect <harness>` descriptor dump a compatibility surface?** R4 changes its shape. README says the command prints the descriptor and promises no schema. Recommended: not a contract; note the change in the commit body and CHANGELOG entry rather than marking a breaking release. Settled by whoever owns a consumer of that output, if one exists.

## References

### Normative

- `AGENTS.md` - the three-layer architecture, the one-way dependency rule, the scope test, and the purity and chat-seam gates.
- `CONTEXT.md` - the normalize and supervise vocabulary and the six supervising parts this RFC gives one owner each.
- `docs/adr/0005-descriptor-owned-session-input-contract.md` - the rule change 4 restores: execution holds no harness-specific field names.
- `docs/adr/0002-structured-refusal-with-hint.md` - consumers branch on refusal fields, not prose (R3).
- `docs/adr/0007-narrow-scope-one-process-at-a-time.md` - the scope test applied in Open Questions 1 and 2, and the removal of the send queue that change 12's comment fixes follow.
- The codebase audit of 2026-09-05, delivered in the session that produced this RFC. Its evidence is reproduced in Introduction and Current State so this document stands alone.

### Informative

- `docs/rfc/01_escalation-reports-its-own-confidence.rfc.md` - RFC-01; its open question 2 is answered by change 5.
- `test/interpretation/purity.test.ts`, `test/no-chat-imports.test.ts`, `test/execution-layering.test.ts` - the gates this RFC keeps and extends.
- `test/docs/readme-contract.test.ts` - the README contract test change 12 extends.
- `src/knowledge/descriptor.ts:5-9` - the descriptor's own statement that a key without a consumer arm can only drift, which change 7 makes enforceable.
