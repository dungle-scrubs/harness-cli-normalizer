# Review: RFC-05 Cursor CLI harness (draft-03, opus reviewer)

Draft-03 has one high finding and no blocking finding. The high finding is H1: the one place that calls the effort resolver fires only when `--model` and `--effort` are both passed on the command line. As a result, the refusal rules for "`--effort` with no `--model`" never run, and an explicit `--effort` is silently ignored.

The other findings are medium or low. Each is a sentence-level fix or a test-matrix pin. Once H1 is fixed and M2 and M3 are decided, an implementer can build the rest with TDD without guessing.

## What was reviewed

- **RFC:** `docs/rfc/05_cursor-cli-harness.rfc.md`, frontmatter `revision: 03`, `status: Draft`, `type: feature`, untracked.
- **Base commit:** `8a0476722674206ce7fafc92db621576c87199a0`. `src/` and `test/` are unchanged since the draft-01 review.
- **SHA-256:** `faef1ad241d936dc64f351adc9fcc557db1c2b277557ce73dde4ead883e72f15`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review; the author is a Meta Muse model.
- **Inputs used:**
  - the RFC, including both revision records (lines 47-78)
  - `spike-addendum.md` §I and `out/50-help.*`
  - `out/models.txt`: the Stem rule was re-derived by script over all 223 slugs
  - `out/15-fetch.stdout` and `out/20-askq.stdout`
  - hcn source, cited per finding: `plan-turn.ts`, `provenance.ts`, `refusal.ts`, `resolve-options.ts`, `decode.ts`, `content.ts`, `interactive.ts`, `native-settings.ts`, `interactive-preflight.ts`, `test/execution-layering.test.ts`, `test/interpretation/hints.test.ts`
- Nothing under `~/.local/share/cursor-agent` was read.

## Structural results

Command:

```
npx tsx ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/05_cursor-cli-harness.rfc.md
```

Output, verbatim:

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Evidence grades

- **Rung 2:** points at RFC lines, capture files, or hcn source.
- **Rung 3:** traces existing hcn execution, or re-derives a claim from raw capture data by script.

No finding reaches rung 4. Nothing was run live.

## Draft-02 findings: resolution check

| # | Draft-02 finding | Status | Check |
|---|---|---|---|
| H1 | Passthrough becomes prompt text; the `--workspace` guard targeted a case that cannot happen | Resolved | `launch.passthrough: "prompt-joins"` with an `unsupported-passthrough` refusal in `buildSpawnArgv` is data-driven. Every `run` spawn argv goes through that function (`plan-turn.ts:342-347`). The `--workspace` guard is removed. Probe 50 (`Usage: agent [options] [command] [prompt...]`) supports the rationale. Open Question 5 flags the ADR 0003 exception for the owner. Text residue is in L6. |
| H2 | Config-tier effort breaks bare runs | Resolved in design | Effort from config or profile now diverges. The divergence output path is not ready for it: M4. |
| H3 | Decoder state has no home | Resolved in design | Opaque state, owned by interpretation and threaded by execution, keeps protocol literals out of `src/execution` (`execution-layering.test.ts` `PROTOCOL_LITERALS`). `contentEventsOf` has one other caller (`context-inspection.ts:173`), which a third argument that the other readers ignore leaves unaffected. Residual contract gaps are in M2 and L5. |
| H4 | `thinking` forms collide in one row | Resolved | Applying the Stem rule by script to `models.txt` gives zero duplicate `(stem, effort, fast)` keys. Only `gpt-5.3-codex`, `gpt-5.2`, and `gpt-5.1` have a bare slug inside a row, and none of those rows has an explicit `-medium`, so bare-is-medium never collides. The bare-only set matches the RFC exactly. Residual items are in M3 and L6. |
| M5 | Resolver ran at two sites | Resolved, but the single site now under-fires | The single owner and model-first order are correct. The call condition is too narrow: H1. |
| M6 | Composed slug never reached `opts.model` | Mostly resolved | Capabilities and the decoder read `plan.options` after the replacement. Provenance does not: M4. |
| M7 | No resume-last path | Resolved | Checked: `args.ts` carries only `--resume` and `--session-id` (`args.ts:212-222`), and `parse-resume.ts` is the only consumer of `resumeLast`. |
| M8 | Trust message steers callers to autonomy | Resolved | The trusted-directory remedy comes first and the autonomy grant is spelled out. Open Question 12 flags the order for the owner. |
| L9 | Default root not data; env edge cases | Resolved in data, with new unprobed rules | `store.defaultRoot` moves the default into data. The empty-means-unset and relative-path rules are unprobed: M5. |
| L10 | Hints, support spelling, transcript ternary | Partly resolved | `support.ts` arm and hints count 32 to 34 are fine. The ratification record's location and the transcript arm are in L6. |
| L11 | Text inaccuracies | Mostly resolved | Identity authority (line 199), probe 20 labeled default mode (line 208), Alternatives item 4 (line 341), and the denial `message` text (line 206) are fixed. Two stale statements remain: L6. |

## Findings (draft-03)

Findings are in severity order.

### H1. An explicit `--effort` without a command-line `--model` is silently ignored; the refusal rules have no call site

- **Severity:** high.
- **Where:** Composition site (line 175); resolution rules on lines 186-187; Refusals line 309; member 6 (line 169).
- **What is wrong:**
  - The resolver runs only "when ... an arg-tier `--model` plus `--effort` are both present" (line 175).
  - `turn-options.ts` "validates the effort WORD ... only", and the `in-model` render emits zero tokens (line 169).
  - Line 186 says "Arg-tier `--effort` with no `--model` MUST refuse with `unknown-effort`", and line 309 repeats it for resume. Neither site raises that refusal. The resolver is not called, and the word check passes any ladder word.
  - What happens under the spec as written:
    - `hcn run cursor --effort high "..."` runs at the harness default with exit 0.
    - `hcn run cursor --resume <id> --effort high "..."` does the same.
    - `--effort high` with `model` set in config (a harness-global key, `config.ts:69-72`): no refusal and no resolution. The model's own tier runs and the flag is dropped.
- **Impact:**
  - An explicit option disappears with no signal. That breaks the explicit/divergence split the RFC relies on (line 100: "only arg-tier `--effort` enforces and can refuse").
  - An implementer following line 175 builds the silent drop; one following line 186 builds a refusal. They have to guess which.
  - One possible fix: call the resolver whenever arg-tier `--effort` is present, and let it take the model from any tier or none. Rules 186 and 187 then have a caller.
- **Rung:** 3 (`plan-turn.ts:293-311`: only arg effort survives the tier drop, so "effort present" is the right trigger).

### M2. A `tool_call/completed` with an unknown `call_id` always emits a denial, even when the result is `success`

- **Severity:** medium.
- **Where:** Stream decoding rows on lines 204-207; the eviction note on line 195; State Machine lines 265-267.
- **What is wrong:**
  - The unknown-`call_id` row maps to "`tool`, then `error` (non-terminal) with `denial`" and does not branch on `result.success` versus `result.rejected`.
  - The only observed orphan is the rejected `webSearchToolCall` in `15-fetch.stdout:39-41`. Whether an approved web search under `--force` also omits `started` is unobserved.
  - If it does, the literal row emits a false `denial` for every successful search. That corrupts the one structured signal draft-02 added.
  - Eviction adds a second case. A pending `call_id` dropped at the 128-entry cap turns a normal `completed` into an orphan: a duplicate `tool` event, and a false denial if the result was a success.
- **Impact:** machine consumers branching on `denial !== undefined` (line 214) could get false positives.
  - The row should split on result: success emits `tool` only, rejected emits `tool` plus denial.
  - The spec should state whether an evicted pending entry may emit a second `tool` event.
  - A `--force` web-search capture would settle the observed shape.
- **Rung:** 2.

### M3. `--model gpt-5.2 --effort high` matches two rules, and "applied in order" does not say first match wins

- **Severity:** medium.
- **Where:** Resolution rules on lines 181-188; Stem rule step 6 (line 94).
- **What is wrong:**
  - `gpt-5.2`, `gpt-5.1`, and `gpt-5.3-codex` are each both a stem key (line 183 resolves) and a row value, the medium tier (line 184 refuses a conflicting effort).
  - Line 179 says the rules are "applied in order" but does not say the first applicable rule wins. Read that way, `--model gpt-5.2 --effort high` resolves to `gpt-5.2-high`. Read the other way, it refuses `invalid-option-value`.
  - The `-fast` path is asymmetric. `gpt-5.2-fast` is only a value after stripping (line 184), so `--model gpt-5.2-fast --effort high` refuses, although `gpt-5.2-high-fast` exists.
  - Stem rule step 6 maps a bare slug to `medium` by citing probe display names, not by a mechanical test. The script check shows the mapping is safe today only because none of the three rows lists an explicit `-medium`. The rule should say "bare maps to `medium` only when the row has no `-medium` entry; otherwise the transcription fails".
- **Impact:** Phase 4's "effortSlug matrix" has to pin one outcome, and the RFC does not say which. The row guard keeps a future `models.txt` from silently double-mapping `medium`.
- **Rung:** 3 (Stem rule re-derived by script).

### M4. Config-tier divergence and provenance claims need consumers the RFC does not name

- **Severity:** medium.
- **Where:** Tier rule (line 177); Refusals line 311; composition site (line 175: "provenance ... see the real slug"); Phase 2 (line 352).
- **What is wrong:**
  - **Divergence wording.** `writeProvenance` prints every divergence as `divergence: profile "<key>" not expressible on <harness>` (`src/cli/provenance.ts:14-18`). `ResolvedOptions.unrenderable` is `readonly string[]` of keys only (`resolve-options.ts:48-50`). A record that "names the tier and the `effort` key" needs a shape change in both places. Neither is listed.
  - **Loop naming.** Config values for profile keys (effort is one) go through the profile loop's tier branch (`resolve-options.ts:337-341`), not the second "config loop" (`:426-437`, which skips keys in `DEFAULT_TURN_PROFILE`). The "config-loop and profile-loop arms" in Phase 2 name the wrong loop.
  - **Provenance timing.** Provenance is computed inside `resolveEffectiveOptions`, before the plan-step replacement (`plan-turn.ts:299-311`). It still shows the stem `model` at tier `arg`. Line 175's claim that provenance sees the real slug is false unless the step also rewrites or appends a provenance entry.
- **Impact:** the owner-facing divergence line says "profile" for a config-file setting, which is the opposite of the "so the owner can see which file set it" goal. The model provenance line names a stem that never ran.
- **Rung:** 3.

### M5. Two new root-resolution rules are unprobed guesses; the relative-path base is probably wrong

- **Severity:** medium.
- **Where:** `store.rootEnv` (line 147); member 4 (line 167).
- **What is wrong:**
  - "A set-but-empty variable counts as unset" is labeled a new rule with no precedent and no probe of what Cursor does with `CURSOR_CONFIG_DIR=""`.
  - "A relative value resolves against the process cwd" cites hcn's own `transcript.ts`, not Cursor's behavior.
  - hcn spawns the child with `cwd: effective.cwd` (`stream-turn.ts:256-259`), so Cursor most likely resolves a relative value against the spawn cwd (hcn `--cwd`), not hcn's process cwd.
  - When the two differ, the resume guard computes a different root than Cursor writes to. With `onMissing: "create"`, a wrong path refuses a valid resume (line 233).
- **Impact:** both rules sit in the table the RFC calls "normative, not advisory". Two cheap probes (empty value, relative value with a different spawn cwd) would replace the guesses. Otherwise the spec should resolve against the spawn cwd and mark both rules unverified.
- **Rung:** 2.

### L5. The reader-state contract leaves mutation versus return unspecified

- **Severity:** low.
- **Where:** Stream decoding (line 195); Phase 2 (line 352).
- **What is wrong:**
  - `contentEventsOf(h, raw, state)` returns `ContentEvent[]`, so the cursor reader must mutate `state` in place.
  - Interpretation is described as "pure functions that read ... and return values" (`AGENTS.md`), and the existing interpretation readers return values; only `decode.ts` in execution mutates `DecodeState`.
  - The RFC should say which contract applies: mutate the opaque value, or return `{ events, state }`. The per-turn-reset test and the bound test are written differently under each.
  - The ADR 0005 and layering-gate claims hold. The gate scans `src/execution` for a fixed set of session-protocol literals, and an opaque slot adds none. ADR 0005 itself covers session input; the RFC applies its principle, which is reasonable.
- **Rung:** 2.

### L6. Stale and contradictory text

- **Severity:** low.
- **Where:** lines 92, 148, 164, 165, 250, 284.
- **What is wrong:**
  - **Lines 165 and 284** say "no new `RefusalIssue` was needed". Draft-03 adds `unsupported-passthrough` (lines 168, 227, 306; `REFUSAL_ISSUES` in `refusal.ts:11-27`). These are normative contradictions an implementer will trip over.
  - **Line 250** in the State Machine still says "announces harness-minted session_id". Line 199 says authority follows the `requestedId` rule.
  - **Line 92** refers to "the Stem rule above". The Stem rule row is below it.
  - **Line 148** says every `storePath` caller, including `native-settings.ts` and `interactive-preflight`, "resolves through" `defaultRoot`. Those two compute only codex paths (`codexRecordsRoot`, `native-settings.ts:53`, `interactive-preflight.ts:87`). The claim is harmless but untrue.
  - **Line 164 (transcript arm).** An "explicit cursor refusal arm" in `cli/transcript.ts` is a harness-name branch, which line 82 forbids. A descriptor-driven check (`resolveHarness(...).transcript === null` before the root ternary) gives the same outcome without the branch.
  - **Line 164 (hints record).** The ratification record goes "beside `test/fixtures/phase0/hints-confirmed.md`". That places a new file inside `test/fixtures/`, whose contents are captured evidence the repo instructions say not to edit. The RFC should name a location outside `test/fixtures/` (for example `docs/`), and the hints test comment that cites the record.
- **Rung:** 2.

## Cleared

- The structural validator passed.
- **Passthrough refusal.** It is data-driven, placed in the one spawn-argv owner, and typed per ADR 0002. `README.md:662` already lists a stale subset of `RefusalIssue`, so there is no contract test to break. Probe 50 confirms `agent [options] [command] [prompt...]`.
- **Native terminal resume is out of v1.** `INTERACTIVE_INTERFACES` has no cursor entry (`src/knowledge/interactive.ts:6-16`), so `interactiveArgv` returns undefined and the request is refused as `unsupported-interface`.
- **Stem rule mechanics.** Over all 223 slugs there are no duplicate keys. The bare-only set is exactly `auto`, `claude-4-sonnet`, `claude-4-sonnet-thinking`, `claude-4.5-sonnet`, `claude-4.5-sonnet-thinking`, `composer-2.5`, `gemini-3-flash`, `gemini-3.1-pro`, `gemini-3.5-flash`, `gpt-5-mini`, `kimi-k2.7-code`. `-extra-high` maps only to `gpt-5.5`. The reachability test in Phase 1 is sound and would catch mis-stemming.
- **Addendum §I:** four query kinds with both `toolCallId` paths (re-read in probes 15 and 20); `-fast` counts 70 twins, zero orphans, and 83 non-fast slugs without a twin.
- **One resolver owner.** A single `resolveEffortSlug` at the plan step with model-first order fixes draft-02's typo-shape problem. `turnTail` validating the final slug makes a stem that reaches it unresolved refuse `unknown-model`.
- **Divergence of non-arg effort.** Only arg effort survives `resolveEffectiveOptions`, so a machine-wide config `effort` no longer breaks cursor.
- **`store.defaultRoot`** puts the fallback in data. Root precedence and the md5 vectors are unchanged from draft-02 and still observed.
- **`trust-refused` message and retry.** The message order and `retryable: true` are consistent with README line 650 and the `auth` precedent.
- **`resumeLast`.** Unreachable in v1, stated correctly and verified.
- **Owner questions.** Open Questions 5-12 each record a machine-made choice with an alternative, so the owner can accept or reverse each without re-reading the review trail.

## Not reviewed

- **hcn skill source.** `~/dev/skills/skills/vendor/hcn/` and its `check-claims` scripts were not read.
- **External consumers.** Consumers of the `denial` field outside this repository were not checked. The RFC now states that strict-schema consumers MUST tolerate unknown fields (line 214).
- **Live behavior.** No live Cursor runs were made: approved web search under `--force`, empty or relative `CURSOR_CONFIG_DIR`, and NFD path names are all unprobed. Every Cursor claim comes from captures 01-50 and the cited docs.
