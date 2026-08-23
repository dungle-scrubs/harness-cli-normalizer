---
number: 01
title: "Escalation reports its own confidence"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-08-23
---

# RFC-01: Escalation reports its own confidence

## Abstract

hcn tells a model how to ask its caller a question, then parses the answer back out of the model's text. Every other contract hcn offers distinguishes "cannot express this" from "expressed it"; this one cannot. A model that should have asked and did not produces a turn indistinguishable from one that had nothing to ask, and hcn reports it as clean. This RFC does not fix that, because no layer can detect a question that was never asked. It makes the uncertainty legible instead: a tri-state `--questions` flag that names what hcn injects, a per-turn record of what hcn asked for and what came back, a confidence claim on the capability carrying its own provenance, and a probe that re-runs when a descriptor's version moves.

## Introduction

### Problem statement

Exit codes and argv are guarantees. "The model ends its turn with a fenced `hcn-question` block" is a hope, prepended to a prompt.

Three specific failures follow from treating the second like the first:

1. **The absence says nothing.** No `question` event is ambiguous between three states: nothing needed asking, something did and the model stayed silent, or something did and the model asked in prose that hcn walked past. The turn ends `clean` either way.
2. **The capability claim is unqualified.** `src/interpretation/capabilities.ts:22` already carries `confidence: "high" | "medium" | "none"` for vision, images, streaming, and session. Escalation asserts a capability and uses none of it, while resting on probes captured against claude 2.1.235 and codex 0.146.1 when the descriptors now declare 2.1.239 and 0.147.0.
3. **A flag misstates what hcn does.** `--no-escalate-questions` does not disable injection. It swaps `ESCALATION_PREAMBLE` for `NO_ESCALATION_PREAMBLE`, an instruction never to ask (`src/interpretation/question.ts:56-64`). The flag chooses which text hcn injects, never whether it injects.

### Scope

In scope: the `--questions` flag and its config-tier key; an `escalation` record on `done`; an `escalation` claim on `CapabilityResult`; wiring the existing escalation probe into the pre-bump tripwires.

Out of scope, each with its reason:

- **Detecting a question that was not asked.** Epistemic, not an hcn limitation. No layer knows what the model SHOULD have said.
- **A prose heuristic on the final message.** Parsing a format hcn specified is not the same as judging free text, and a heuristic's false positives would land in a field callers are meant to trust.
- **Normalizing native harness asks.** Neither claude's `AskUserQuestion` nor codex's `request_user_input` surfaces on a headless stream, so there is nothing to normalize.
- **Removing escalation.** No harness offers a headless caller-answer loop, so nothing would replace it.
- **Moving the preamble to the caller.** hcn keeps ownership. The parser only finds a block because the preamble asked for one, so a caller-owned instruction makes the protocol a convention rather than a guarantee and fails silently when forgotten.
- **What a consumer does with a low-confidence stamp.** ADR 0007 puts that on the caller.

### Motivation

Evidence, not argument. Both claude 2.1.239 and codex 0.147.0, given a genuine unrecoverable decision and **no preamble at all**, recognised they should ask and asked in prose (`test/fixtures/phase9-native-asks/`). claude stated why: "A 50/50 coin flip on an unrecoverable, non-reversible artifact is worse than one round-trip question."

So the models are willing. What is missing is structure, and structure is what hcn supplies. The feature is sound; the claims around it are what overstate.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Escalation**: hcn's protocol for a model to ask its caller a question. A preamble in, a fenced `hcn-question` block out.
- **Preamble**: text hcn prepends to the caller's prompt. Three exist: `ESCALATION_PREAMBLE`, `NO_ESCALATION_PREAMBLE`, and `SESSION_ESCALATION_PREAMBLE`.
- **Question mode**: which preamble hcn injects for a turn - `ask`, `assume`, or `none`.
- **Detection**: what `detectQuestionBlock` found in the final message - a block, a malformed attempt, or nothing.
- **Instructed-and-silent**: mode `ask` with detection `none`. hcn asked for the protocol and the model produced no block.
- **Probe**: a live run against a real harness that observes whether the block is produced when instructed.
- **`verifiedAgainst`**: the harness CLI version a descriptor's facts were checked against.

## Motivation

See Introduction. The decisive point is that escalation is the one place hcn asserts a capability it cannot verify and reports no divergence for, in a product whose stated identity is honest divergence reporting.

## Design

### 1. Question mode: `--questions <ask|assume|none>`

The `--escalate-questions` / `--no-escalate-questions` pair MUST be replaced by a single tri-state flag. The default MUST be `ask`, preserving current behaviour.

| value | hcn injects |
|---|---|
| `ask` | `ESCALATION_PREAMBLE`, or `SESSION_ESCALATION_PREAMBLE` in session mode |
| `assume` | `NO_ESCALATION_PREAMBLE` |
| `none` | nothing |

`assume` MUST be retained rather than deleted. An uninstructed headless run does not proceed quietly: it asks in prose and produces a question nobody can answer, as an ordinary successful turn. `NO_ESCALATION_PREAMBLE` is what prevents that.

`none` MUST be reachable by flag. It is achievable today only by beginning the prompt with the literal string `[hcn question protocol]`, which makes `composeEscalatedPrompt` pass through untouched (`question.ts:62`). That escape hatch exists for resumed turns and MUST continue to work, but a caller SHOULD NOT need to know it.

The config-tier key `escalateQuestions` MUST move out of `BOOL_KEYS` (`src/cli/config.ts:81,91`) and become an enum-valued key. Precedence rules are unchanged.

### 2. Per-turn record on `done`

The `done` event MUST carry an `escalation` object:

```ts
{ kind: "done", exitCode, cause, failure?,
  escalation: {
    mode: "ask" | "assume" | "none",
    detection: "block" | "malformed" | "none"
  } }
```

Both fields MUST be present on every `done`, including turns that failed.

`mode` MUST be recorded rather than inferred. A caller that passes no flag cannot derive it: hcn defaults escalation on (`src/execution/stream-turn.ts:140`) and a config tier can set it, so the caller knows what it requested, not what hcn did.

`detection` MUST carry all three values. `malformed` is not derivable by any other party - only hcn's parser sees that a model tried to ask and botched the shape (`question.ts:149`), and that distinction currently dies inside hcn.

The record MUST NOT be a separate event kind. The README promises unknown event kinds are ignored while the consumer waits for `done`; a correctly written reader would therefore ignore the very event intended to end the silence.

### 3. Capability claim on `CapabilityResult`

`CapabilityResult` MUST gain a nested `escalation` claim. The four existing capabilities and the top-level `source` and `confidence` MUST NOT change.

```ts
interface CapabilityResult {
  vision: boolean
  images: boolean
  streaming: StreamingGranularity
  session: boolean
  source: "runtime-verified" | "curated" | "unknown"
  confidence: "high" | "medium" | "none"
  escalation: {
    supported: boolean
    source: "runtime-verified" | "curated" | "unknown"
    confidence: "high" | "medium" | "none"
    observedOn?: { harness: string; model: string; version: string; date: string }
  }
}
```

Nesting is REQUIRED because the two kinds of claim decay differently. Vision does not stop working because a model shipped; it holds until the CLI changes, which `verifiedAgainst` already tracks. Escalation compliance is a model behaviour that drifts on a schedule nobody controls. A single `confidence` cannot carry both without misstating one.

`supported` MUST be documented as "this harness and model were observed to emit the structured block when instructed", NOT as "this harness can ask". The probes establish that models ask regardless; the claim is about structure.

Values for the escalation claim:

- `runtime-verified` + `high`: a probe exists for this harness and model, at a version not behind the descriptor's `verifiedAgainst`.
- `runtime-verified` + `medium`: a probe exists at a version behind `verifiedAgainst`.
- `curated` + `medium`: the descriptor asserts it with no probe behind it.
- `unknown` + `none`: no probe for this harness, or an uncurated model.

Staleness MUST be computed from `observedOn.version` against `verifiedAgainst`, and MUST NOT be stored as a separate field. Two stored facts can disagree; a derived one cannot.

`capabilitiesOf(h, model, mode)` is already keyed on harness, model, and mode and already degrades an explicitly-given uncurated model to `source: "unknown"`, `confidence: "none"` (`capabilities.ts:26-45`). The escalation claim MUST inherit that degradation by the same rule.

### 4. Probe freshness

`scripts/e2e-questions.ts` MUST be wired into `package.json` as its own script and added to the capability tripwires that `AGENTS.md:110-112` already requires before a `verifiedAgainst` bump.

The probe MUST write `observedOn` provenance, not merely pass. A green check with no provenance cannot be compared against `verifiedAgainst` later. `.smoke/seven.json` is the precedent for where evidence lands.

The probe MUST NOT run in the deterministic suite. It requires live harnesses and credentials, as `smoke:seven` does.

Its existing scenario named `question-off` MUST be renamed to match the `assume` mode, and a scenario for `none` MUST be added.

## State Machine

Question mode and detection are independent, and the meaning of a turn comes from the pair:

```
mode=ask     detection=block      → question event; done cause=awaiting-input
mode=ask     detection=malformed  → no question event; done cause per outcome
mode=ask     detection=none       → INSTRUCTED-AND-SILENT; the countable case
mode=assume  detection=none       → the model did as instructed
mode=assume  detection=block      → the model ignored the instruction
mode=none    detection=none       → hcn said nothing and claims nothing
mode=none    detection=block      → the caller supplied its own preamble
```

Only `mode=ask, detection=block` MUST produce a `question` event and `awaiting-input`. Every other pair leaves the turn's cause determined by its ordinary outcome.

## Error Handling

This RFC adds reporting, not failure modes. No new failure class is introduced.

```
E-ESC-001  Unknown --questions value             (severity: warning)
           hcn MUST refuse before spawn, exit 2, listing ask|assume|none.
           Consistent with existing invalid-option-value refusals.

E-ESC-002  Malformed hcn-question block          (severity: info)
           The model tried to ask and botched the shape.
           Recovery: none. The turn completes normally.
           Reported as detection: "malformed"; MUST NOT be swallowed.

E-ESC-003  Probe run against an absent harness   (severity: info)
           Recovery: skip that harness, as smoke:seven does.
           The escalation claim reports source "unknown", confidence "none".
```

An escalation claim whose `observedOn` is missing MUST NOT be treated as an error. It means no probe exists, which `curated` and `unknown` already express.

## Security Considerations

**Trust boundary.** hcn writes into the model's context. That is the whole mechanism and it is unchanged by this RFC, but this document makes it visible in the flag, which is the point: a reader of `--questions ask` can see that hcn injects, where a reader of `--escalate-questions` could not.

**Injection resistance.** `ESCALATION_PREAMBLE` carries a permissions disclaimer - asking is not how the model obtains permission, and the protocol removes no permission the run already has. That clause MUST be retained verbatim in any rewording. Without it, a model can read the protocol as a channel for requesting privileges it was not granted, and a hostile repository could exploit that reading.

**Blast radius of a wrong claim.** An escalation claim of `high` that is false leads a caller to trust a route that will not ask. Consequence: a run proceeds on a guess where the caller expected a question. The `medium` default under staleness is the conservative direction, and staleness being computed rather than stored means it cannot silently drift out of step.

**Data sensitivity.** The `escalation` record on `done` carries no prompt content, no model output, and no credential - two enum values only. `observedOn` carries a harness name, a model id, a version, and a date. None is sensitive.

**What this does not defend against.** A model instructed to ask that instead exfiltrates through the question text. The question is caller-facing prose, and hcn does not inspect it. That risk exists today and is unchanged.

## Alternatives Considered

**Per-claim confidence for all five capabilities.** Uniform and the most honest overall. Rejected on blast radius: it changes the shape every reader decodes, and lucid decodes it today (`src/harness/hcn-runner.ts`). The nested form is additive.

**Escalation riding the existing single `confidence`.** No shape change at all. Rejected because one number cannot carry a curated harness fact and a drifting model observation: a stale probe would drag down vision's confidence, which is false, or vision's certainty would overstate escalation's, which is the problem being fixed.

**A dedicated `escalation` event kind.** Cleaner separation, leaving `done` about cause. Rejected on its own logic: the README promises unknown kinds are ignored, so a correct consumer would ignore it.

**Recording only what is not derivable.** Drop `mode`, emit detection alone. Rejected because `mode` is genuinely not derivable when the caller passed no flag, and because a three-value enum where one value is inferred and two are reported is harder to consume than one that always reports.

**Deleting `NO_ESCALATION_PREAMBLE`.** It looked like dead weight. Rejected on evidence: `test/fixtures/phase9-native-asks/` shows both models ask in prose when uninstructed, so removing it would make headless runs produce unanswerable questions.

**Removing escalation entirely.** Would take hcn out of the model's context completely. Rejected because `docs/research/2026-08-23-native-question-handling.md` establishes no harness offers a headless caller-answer loop, so nothing would replace it, and `delegate.ts` would lose the `recommended` answer it takes when unattended.

## Implementation Plan

**Phase 1 - the flag.** `--questions <ask|assume|none>`, the config-tier enum, and `composeEscalatedPrompt` taking a mode rather than a boolean. Verified by argv preview per mode and by a refusal on an unknown value. Rollback: revert; nothing downstream reads it yet.

**Phase 2 - the `done` record.** `escalation: { mode, detection }` on every `done`. Verified by asserting the pair for each row of the State Machine table against fake-harness fixtures. Rollback: the field is additive, so removing it restores the prior stream.

**Phase 3 - the capability claim.** The nested `escalation` on `CapabilityResult`, with computed staleness. Verified by `hcn inspect --capabilities` across curated and uncurated models, asserting the degradation rule. Rollback: additive; removal restores the prior shape.

**Phase 4 - the probe.** Wire `scripts/e2e-questions.ts` into `package.json`, rename `question-off` to the `assume` scenario, add a `none` scenario, emit `observedOn`, and extend the AGENTS.md tripwire clause. Verified by a live run against installed harnesses producing provenance that phase 3 then reads.

Phases 1 and 2 MUST land together, because phase 2's `mode` field has three values only after phase 1. Phase 3 depends on nothing but MAY be deferred; until phase 4 runs, every claim reports `curated` or a stale `runtime-verified`.

Go/no-go before phase 4: phase 3 MUST be able to consume `observedOn` and compute staleness, or the probe writes provenance nothing reads.

## Open Questions

1. **Does `SESSION_ESCALATION_PREAMBLE` get its own mode value?** Today session mode is selected by the `mode: "turn" | "session"` parameter to `composeEscalatedPrompt`, orthogonal to the tri-state. Settled by whether a caller ever wants session transport with turn wording; if never, the current orthogonality stands and no fourth value is needed.

2. **Should the `escalation` record appear on `hcn session --json` turn ends as well as `hcn run`?** A session's turns end with the same `done` vocabulary, so it likely falls out for free. Settled by checking whether the session runner constructs `done` through the same path.

3. **What does the probe do when a harness is installed but unauthenticated?** Distinct from absent. Settled by what `smoke:seven` already does in that case; this RFC SHOULD follow it rather than invent a second behaviour.

4. **Machine-made:** the RFC type was taken as `feature` without confirmation, on the basis that the bulk is new reporting surface rather than restructuring. Reversible by re-running the init script.

## References

### Normative

- RFC 2119 - Key words for use in RFCs to Indicate Requirement Levels.
- Wayfinder map `#74` "Escalation tells the truth about itself", closed, and its six tickets. Every normative statement here traces to one: `#75` the probe result; `#76` the capability claim; `#77` the `done` record and its amendment; `#78` the tri-state flag; `#79` probe freshness; `#80` ruled out of scope.
- ADR 0007 `docs/adr/0007-narrow-scope-one-process-at-a-time.md` - the scope test that places consumer behaviour outside hcn.
- `CONTEXT.md` - the normalize/supervise split, and the flagged ambiguity that "question" means a permission prompt in some harnesses and an open decision question here.
- `src/interpretation/question.ts`, `src/interpretation/capabilities.ts`, `src/execution/stream-turn.ts`, `src/cli/config.ts` - the code this RFC changes.

### Informative

- `test/fixtures/phase9-native-asks/` - live probes showing neither claude nor codex surfaces a native ask headless, and that both ask in prose unprompted.
- `test/fixtures/phase7-questions/` - the original compliance probes, captured against claude 2.1.235 and codex 0.146.1.
- `docs/research/2026-08-23-native-question-handling.md` - the desk survey. Read with the correction in `phase9`'s README: the codex key is `tools.experimental_request_user_input={enabled=true}`, a struct, not the boolean spelling reported there.
