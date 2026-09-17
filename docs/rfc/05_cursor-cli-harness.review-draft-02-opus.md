# Review: RFC-05 Cursor CLI harness (draft-02, opus reviewer)

**Draft-02 still has high findings.** Four of them change what gets built: passthrough on cursor, effort set in config, where the decoder state lives, and the `thinking` rows in the effort table. None of the four is a regression in a draft-01 fix. Each is a new gap in a mechanism draft-02 added.

## What was reviewed

- **RFC:** `docs/rfc/05_cursor-cli-harness.rfc.md`, frontmatter `revision: 02`, `status: Draft`, `type: feature`. The file is untracked.
- **Base commit:** `8a0476722674206ce7fafc92db621576c87199a0`.
- **SHA-256:** `80db9eeff51bd48c6fefe6dfbb422423ae09d6906f3f14c1fb32e5f7c37fb61b`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review; the author is a Meta Muse model.
- **Inputs used:**
  - the RFC and its revision record (lines 46-61)
  - `spike-addendum.md` and raw captures `out/40-*` through `out/49-*`
  - the draft-01 captures `out/13`, `15`, `20`, `43`, and `models.txt`, re-read where the RFC cites them
  - `README.md` §§ failure contract (lines 636-650), `CONTEXT.md`, and ADRs 0003 and 0005
  - hcn source, cited per finding
- **Graph and coverage checks:** coverage was checked for every cited source file in the draft-01 pass, and nothing in `src/` has changed since. `src/cli/session.ts` is still partial, and its cited range was read directly.
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
- **Rung 3:** traces existing hcn execution, or reads raw capture data that contradicts or bounds a claim.

No finding reaches rung 4. Nothing was run live.

## Draft-01 findings: resolution check

| # | Draft-01 finding | Status | Check |
|---|---|---|---|
| 1 | `resume.extraFlags` misread | Resolved | Line 110 sets `["-p"]` and describes the splice correctly (`argv.ts:236-246`). `turnTail` adds stream flags, the model, and `--force` only when `opts.autonomy` is set (`argv.ts:133-162`). Phase 4 pins the resume argv. One small gap: the order `--resume <id> -p` was never probed (probes used `-p --resume`). Probe 42 makes a problem unlikely. |
| 2 | Effort mechanism placement | Partly resolved | The composition site moves to `turnTail`, stems are intercepted, and the render-less kind is replaced by `in-model`. New findings H2, M5, and M6 come from the new design. |
| 3 | Effort facts vs model list | Partly resolved | The 223 count, bare-is-medium (probes 29/48/49 confirmed: `GPT-5.1 Medium`, `Codex 5.3 Medium`), the ladders, and `extra-high` normalizing to `xhigh` are all correct against `models.txt`. The table shape for `thinking` forms is new finding H4. |
| 4 | Decoder discriminator | Resolved on facts | Probe 43 confirms that deltas carry `timestamp_ms` and no `model_call_id`, and the flush carries neither. Probes 13 and 15 confirm that plain-stream segments carry both. The orphan `completed` rule matches `15-fetch.stdout:39-41`. The new design needs state that has no home: finding H3. |
| 5 | `--trust` through passthrough | Resolved | Probe 40 exits 1 with the trust stderr. In probe 41, `pong41 --continue` becomes the prompt. Passthrough is no longer named as a remedy. Drawing only the trust and resume conclusion from probe 41 leads to finding H1. |
| 6 | Missed consumers | Mostly resolved | All listed consumers are now named. Residual items are in L10. |
| 7 | Store root and md5 | Resolved | Probe 44 shows `CURSOR_CONFIG_DIR` beats a set `XDG_CONFIG_HOME` (`cfg-override/chats/09386466...`). Probe 45 shows the default root. Probe 46's vector `4fe2ebd9...` reproduces as md5 over the UTF-8 bytes of the path. Residual items are in L9. |
| 8 | `trust-refused` retryable | Resolved | `retryable: true` with precedence 2 now has a stated rationale. It matches README line 650 ("`true` for the rest") and the `auth` precedent. See Cleared, and the message concern in M8. |
| 9 | Unstructured denials | Resolved as a contract | `denial?: { tool, reason }` on `error` is additive. `--json` output is `JSON.stringify(event)` (`render.ts:92`), so the field reaches consumers. Residual items are in L11. |
| 10 | Owner decisions | Resolved | Open Question 1 now gates only the three bare-tier rows. The `hcn ls` reading is stated (line 31) and matches `ls.ts`. |
| 11 | Security framing | Mostly resolved | `--force` is described accurately (lines 196, 294). Alternatives item 4 now misstates which flag persists: see L11. |
| 12 | Evidence labels | Mostly resolved | Line 104 is corrected, and probe 42 confirms prompt-first order. Line 116 is corrected, but line 177 still says `harness-minted`. A new mislabel ("ask mode") is listed in L11. |

## Findings (draft-02)

Findings are in severity order.

### H1. All passthrough on cursor silently becomes prompt text, and the `--workspace` + `--resume` refusal targets a case that cannot happen

- **Severity:** high.
- **Where:** Scope line 36; Identity and resume line 207; Refusals line 281; Phase 3 line 324.
- **What is wrong:**
  - Probe 41 shows that every token after hcn's `--` joins the positional prompt, with exit 0.
  - ADR 0003's contract is that a wrong-harness flag after `--` "fails in the harness itself and surfaces as a native error (exit 1)". On cursor it does not fail. It rewrites the prompt and the run succeeds.
  - The RFC applies probe 41 only to `--trust` and `--continue`. It then specifies a refusal for `--workspace` / `--add-dir` in passthrough with `--resume`, "because the session would file under a different md5".
  - By the RFC's own evidence, `-- --workspace /x` never reaches Cursor as a flag. It becomes prompt text, the session files under the spawn cwd, and the guard's path is correct.
  - Probe 30, which the RFC cites, passed `--workspace` before the prompt, not after `--`.
  - No capture shows `--add-dir` changing the md5 either.
  - The refusal also means inspecting passthrough tokens against harness flag names. ADR 0003 defers descriptor-validated passthrough. The RFC reverses that deferral for one flag pair without saying so, and without naming where the flag list lives (data, or an `h.name` branch).
- **Impact:**
  - A caller's native flags on cursor change what the model is asked, with exit 0 and no signal.
  - The refusal adds passthrough inspection for a case the evidence shows is harmless.
  - The contract gap the evidence does show is ADR 0003 on cursor. It needs a decision, for example: cursor refuses any non-empty passthrough, backed by a descriptor field such as `launch.passthrough: "prompt-joins"`. Otherwise ADR 0003 needs an amendment.
- **Rung:** 3 (probe 41, `argv.ts:271-272`, ADR 0003).

### H2. Effort in config is harness-global, so a machine-wide `effort` makes bare cursor runs refuse

- **Severity:** high.
- **Where:** Tier rule (line 156); resolution rules on lines 164-165; Refusals line 278.
- **What is wrong:**
  - The Tier rule treats `project-config` and `user-config` as explicit.
  - Config keys `effort` and `model` are harness-global: `KNOWN_KEYS` in `src/cli/config.ts:69-72`, and `resolve-options.ts:175-183` ("per-harness sections ship with schema v2").
  - Today `effort: "high"` in `~/.config/hcn/config.json` is valid on all four ladders.
  - Under draft-02, the same config makes these refuse:
    - `hcn run cursor "..."` (explicit-tier effort with no `--model`, line 164);
    - `hcn run cursor --model composer-2.5` (bare-only stem, line 165);
    - `hcn run cursor --model claude-opus-4-8-medium` (variant conflict, line 162).
  - The same holds for a project `.hcn/config.json`.
- **Impact:**
  - One reasonable global setting breaks cursor for every caller on the machine, and the refusal names effort, not the config file.
  - A delegate route that passes a variant slug also refuses under any config effort that differs from the slug's tier.
  - The RFC should either treat config-tier effort like the profile tier on cursor (divergence), or state this cost and make the refusal detail name the config tier.
- **Rung:** 3.

### H3. The decoder's new state has no home, and "no execution-layer change" is false

- **Severity:** high.
- **Where:** Stream decoding line 173 ("no execution-layer change"); rows on lines 182-186; State Machine lines 225-238.
- **What is wrong:**
  - The rows require per-turn state: pending `call_id`s, and query args recorded by `toolCallId`, so a later orphan `completed` can emit a `tool` event with input.
  - Content readers are stateless: `contentEventsOf(harness, raw)` dispatches to `(r) => ContentEvent[]` (`content.ts:244-255`).
  - The only threaded state is `DecodeState`, defined in the execution layer (`decode.ts:15-42`).
  - Holding cursor's `call_id` / `toolCallId` bookkeeping in execution goes against ADR 0005 and the protocol-ownership gate's intent (`test/execution-layering.test.ts`). Giving readers a state parameter changes the signature for all five readers.
  - The RFC picks neither option, and does not specify:
    - when the state resets;
    - a bound on it (a long turn with many tool calls grows the map);
    - that the `toolCallId` path differs by query kind: `query.askQuestionInteractionQuery.toolCallId` (probe 20 line 6) versus `query.webFetchRequestQuery.args.toolCallId` (probe 15 lines 9 and 39).
- **Impact:** an implementer must make a layering decision the RFC says is unnecessary. The easy choice (fields on `DecodeState`) puts harness protocol state in execution.
- **Rung:** 3.

### H4. `thinking` forms cannot share an effort-word-to-slug row

- **Severity:** high.
- **Where:** Terminology "Family" (line 76); `vocabulary.effortSlugs` (line 125); variant rule (line 162); Phase 1 (line 320).
- **What is wrong:**
  - A row is defined as "exact hcn-effort-word to slug pairs". Line 125 says `claude-opus-4-8` "maps five efforts to `-low` ... `-max` slugs plus the five `thinking` forms".
  - A map from effort word to slug cannot hold both `low → claude-opus-4-8-low` and `low → claude-opus-4-8-thinking-low`.
  - The same collision occurs in `claude-opus-4-7`, `claude-fable-5-1`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-4.6-opus` (`high` / `high-thinking`), and `claude-4.5-opus`.
  - Consequences:
    - Is `--model claude-opus-4-8 --effort low` the thinking form or the plain form? Unspecified.
    - `--model claude-opus-4-8-thinking-high --effort low`: line 162 needs the row key of the variant to decide between idempotent and conflicting, and a thinking variant has no key.
  - A likely fix is a separate stem per `thinking` form (`claude-opus-4-8-thinking`, `claude-4.6-opus` + `-thinking`), but the RFC says "`thinking` forms are ordinary row entries".
- **Impact:** Phase 1 transcription cannot produce the table as defined, and the variant-conflict rule is undefined for every Claude thinking slug.
- **Rung:** 2 (`models.txt`).

### M5. The resolver runs at two sites, and the first one gives the wrong refusal for a mistyped model

- **Severity:** medium.
- **Where:** Composition site (line 154); members item 5 (line 148); Refusals line 278.
- **What is wrong:**
  - `turn-options.ts` "runs the same resolver for its error shapes", and `turnTail` resolves again. That is two owners of one rule, which RFC-02 forbids.
  - The effort key renders in the `before-prompt` pass, which `buildLaunchArgv` and `resumeArgv` call before `turnTail` (`argv.ts:180-184`, `:242-243`; placement logic in `turn-options.ts:65-71`). So the turn-options resolver refuses first.
  - Line 278 maps an unknown family to `unknown-effort`. `--model claud-opus-4-8-high --effort high` (a typo) therefore refuses as an effort problem before `validateModel` can say `unknown-model`.
- **Impact:** the refusal points the caller at the wrong field. There are two resolver call sites to keep in agreement.
- **Rung:** 3.

### M6. The composed slug never reaches `opts.model`, so capability claims degrade for stems

- **Severity:** medium.
- **Where:** Composition site (line 154); resolution rule on line 161.
- **What is wrong:**
  - The slug is composed only inside `turnTail`'s token list.
  - `stream-turn.ts:466` passes `opts.model` (the stem, for example `claude-opus-4-8`) to `decodeLine`.
  - `capabilitiesOf` degrades any non-curated explicit model to `source: "unknown"`, `streaming: "none"`, and escalation unsupported (`capabilities.ts:81-94`). Stems are keys, not members of `vocabulary.models` (line 76).
  - Every identity event for a stem-plus-effort run therefore reports unknown capabilities and no streaming, on a token-granular launch.
  - Provenance also records the stem, not the slug that ran.
- **Impact:** consumers that buffer on `streaming: "none"` lose token streaming, and the plan output does not name the model that ran. The RFC should say where the resolved slug replaces `opts.model` (for example in the plan, before spawn).
- **Rung:** 3.

### M7. hcn has no `--continue` or resume-last option, so `resumeLast` has no render path

- **Severity:** medium.
- **Where:** `resumeLast` row (line 131); Identity and resume line 206.
- **What is wrong:**
  - The RFC says "hcn renders the real `--continue` flag" and "renders them as real argv flags through its own `--resume`/`--continue` options".
  - `src/cli/args.ts` has `--resume` and its alias `--session-id` (`args.ts:212-222`), and no continue or last option.
  - The descriptor field `resumeLast` is consumed only by `parse-resume.ts:80-107`, which parses pasted commands.
  - `--resume=-1` through hcn's `--resume` is refused by the session-id shape check (`argv.ts:207-222`; ids must start with a letter or digit).
- **Impact:** the RFC describes a capability that does not exist. Adding a resume-last option is new CLI surface and needs its own fit check, or the RFC should say cursor's most-recent resume is not reachable through hcn in v1.
- **Rung:** 3.

### M8. The `trust-refused` message steers automated callers to full autonomy

- **Severity:** medium.
- **Where:** members item 2 (line 145, `messageFor`); Failure classification line 261.
- **What is wrong:**
  - The remedy text is "re-run with hcn `--autonomy`, which renders `--force`, or in a trusted directory".
  - The message is read by agent consumers. The README's canonical check (lines 643-646) routes on `retryable`, and agents act on `message`.
  - `--force` is unattended edits plus non-allowlisted shell (probes 16/17). The first-named remedy for "Cursor does not trust this directory" is to grant unattended execution in that directory.
  - The Security section calls `--autonomy` "a deliberate, visible caller choice". A message that suggests it to an automated caller undermines that.
- **Impact:** an agent that follows the remedy text escalates privileges exactly where the harness raised a trust concern. Since `retryable: true` already continues the walk, the message can name the trusted-directory remedy first and state what `--autonomy` grants.
- **Rung:** 2.

### L9. The store root default is not data; env edge cases are unspecified

- **Severity:** low.
- **Where:** members item 4 (line 147); `store.rootEnv` (line 128).
- **What is wrong:**
  - The `{home}/.cursor` fallback lives in `resume-guard.ts` code ("else `{home}/.cursor`"), not in the descriptor. That is cursor knowledge outside data.
  - `storePath` renders `{root}` "defaulting to home". A caller that computes a cursor path without the guard's resolution (`native-settings.ts` and `interactive-preflight` are `storePath` callers) would get `~/chats/<md5>`.
  - The spec does not say whether a set-but-empty `XDG_CONFIG_HOME` or `CURSOR_CONFIG_DIR` counts as "set", or how a relative value is handled.
  - The `ws-café` vector covers an NFC name only (the directory bytes are `é` precomposed).
- **Rung:** 2.

### L10. Residual consumer details

- **Severity:** low.
- **Where:** members item 1 (line 144); Phase 3.
- **What is wrong:**
  - **Hints.** `test/interpretation/hints.test.ts:13-15` pins exactly 32 entries and the key list. Its durable record is `test/fixtures/phase0/hints-confirmed.md`, which the repo's instructions forbid editing. The new cursor hint needs a stated ratification path and a test update.
  - **Support spelling.** `support.ts:66-87` reads `render.flag` / `render.flags` for effort. The `in-model` render has neither, so cursor drops out of `supportedBy` for effort although it supports effort. The RFC does not list `support.ts`.
  - **Transcript ternary.** Line 144 both "gains a cursor arm in the store-root ternary" and says the ternary "MUST NOT grow another harness-shaped branch". Those two statements conflict.
- **Rung:** 3.

### L11. Text inaccuracies

- **Severity:** low.
- **Where:** lines 177, 186, 192, 228, 311, and the `-fast` rule on line 163.
- **What is wrong:**
  - **Line 177** still says authority `harness-minted`. Line 116 says the decoder reports `caller-assigned` on resume.
  - **Lines 186 and 228** label probe 20 "ask mode". Its argv has no `--mode`, so it ran in default mode (`out/20-askq.argv`).
  - **Line 311** says "Cursor differs because its bypass persists state". The per-run bypass, `--force`, persists nothing. `--trust` persists, and it is not a bypass hcn would pass.
  - **The `-fast` rule on line 163.** "Strip, resolve, reattach" reduces to an idempotence check, because any other effort on a variant refuses. The wording promises composition that never happens. The same idea would also produce non-existent slugs: `gpt-5.4-low` exists, but `gpt-5.4-low-fast` does not.
  - **Denial messages.** The `message` text of a denial `error` is unspecified. The human renderer prints only `message` (`render.ts:49-50`), and shell denials have an empty `reason`.
  - **Line 192** overstates: "`clean` plus `denial` events means 'answered without running tools'". Some tools can succeed in the same turn.
- **Rung:** 2.

## Cleared

- The structural validator passed.
- **`trust-refused` with `retryable: true` and precedence 2.** This is consistent with README line 650 and with `auth`. The refusal happens before inference, so no verdict on the work exists. A walk that tries several cursor routes in the same cwd fails each one cheaply, the same way as `auth`.
- **`denial` field and the chat seam.** The field is added in `execution/events.ts` and the interpretation `ContentEvent`. It imports no lucid, frames, or chat-protocol types. It is additive, and `JSON.stringify` output carries it. The README contract test checks event kinds, not fields (`readme-contract.test.ts:21-33`). No in-repo consumer switches on `error` fields beyond `terminal` (`context-inspection.ts:174`, `open-session.ts:400`, `native-approval-turn.ts:423`).
- **Profile-tier divergence.** Dropping the `medium` default in the profile loop fits the existing skip-and-report path (`resolve-options.ts:342-348`). It needs a descriptor-driven condition (`spec.kind === "effort-in-model"`), not a harness-name check.
- **`in-model` render.** A zero-token render keeps the `turn-options.ts:268-270` invariant, and `tokensFor`'s exhaustive switch fails closed until the arm exists.
- **Store root precedence** is observed end to end (probes 36, 44, 45).
- **md5 input** is UTF-8 of the real path, and the vector reproduces.
- **Model facts.** 223 slugs, 70 `-fast` twins, bare-tier displays (probes 29, 47, 48, 49), and every ladder in addendum F were spot-checked against `models.txt`.
- **Discriminator.** Probe 43 matches the decoding table.
- **Autonomy.** Resume carries `--force` only under `--autonomy`.
- **Scope.** Every added capability passes ADR 0007. Nothing tracks state across processes.

## Not reviewed

- **hcn skill source.** `~/dev/skills/skills/vendor/hcn/` and its `check-claims` scripts were not read.
- **Native terminal resume.** `hcn interactive` for cursor (`interactive-preflight.ts` is codex-specific) is still unaddressed by the RFC and was not examined further.
- **External consumers.** Downstream consumers of the `error` event outside this repository (lucid, delegate) were not checked for strict schema validation that might reject an unknown `denial` field.
- **Live behavior.** No live Cursor runs were made. Every Cursor claim comes from captures 01-49 and the cited docs.
