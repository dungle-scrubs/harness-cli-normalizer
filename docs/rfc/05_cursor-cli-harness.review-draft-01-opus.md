# Review: RFC-05 Cursor CLI harness (draft-01, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/05_cursor-cli-harness.rfc.md`, `status: Draft`, `type: feature`, `date: 2026-09-16`.
- **Version:** the frontmatter has no `revision` field, so the document does not state a version. This review treats the file as draft-01 because of the save name the caller gave. The file is untracked (`git status`: `??`).
- **Base commit:** `8a0476722674206ce7fafc92db621576c87199a0`.
- **SHA-256:** `cbcf8f2b854190e360ca3c3c8f7c8275f21bdac1be9c27b71b12b8a3c9b281c2`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review of an RFC written by a Meta Muse model.
- **Inputs used:**
  - the RFC
  - the spike report `spike-report.md`, the session notes `notes-session.md`, and the raw captures in `out/`, including `models.txt`
  - the background research doc `docs/research/2026-09-16-cursor-and-grok-build-harnesses.md`, for cross-checks only
  - `AGENTS.md`, `CONTEXT.md`, and ADRs 0003 and 0007
  - hcn source, cited per finding
- **Graph checks:** `trace_path` on `storePath` and `validateEffort`, and `check_index_coverage` on every cited source file. All cited files report no recorded gap except `src/cli/session.ts` (partial parse, lines 1-454). The cited range in that file was read directly.
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
- **Rung 3:** traces existing hcn execution, or reads raw capture data that contradicts a claim.

No finding reaches rung 4. Nothing was run live and no reproducer was written.

RFC line numbers refer to the file with the SHA-256 above.

## Findings

Findings are in severity order.

### 1. `resume.extraFlags` is misread as a list of accepted flags; resume argv breaks and every resume runs with `--force`

- **Severity:** blocking.
- **Where:** Design, Descriptor fields, RFC line 92. Also Identity and resume, lines 180-184.
- **What is wrong:**
  - The RFC sets `extraFlags: ["--model", "--output-format", "--mode", "--force"]` and calls it "the resume grammar".
  - In code, `extraFlags` is a list of literal tokens spliced into every resume argv (`src/interpretation/argv.ts:236-246`: `h.bin, ...subcommands, h.resume.flag, id, ...h.resume.extraFlags, ...`).
  - Existing descriptors use it that way: claude `["-p"]` (`claude-code.ts:54`), pi `["-p", "--mode", "json"]` (`pi.ts:48`), codex `["--json", "--skip-git-repo-check"]` (`codex.ts:49`).
  - `launch.baseFlags` is not emitted on resume, so `-p` must be in `extraFlags`.
  - As specified, the resume argv becomes `agent --resume <id> --model --output-format --mode --force <prompt> --output-format stream-json ...`:
    - `--model` swallows `--output-format` as its value.
    - `--mode` swallows `--force`.
    - `-p` is missing.
- **Impact:**
  - Every `hcn run cursor --resume` either fails natively or runs with a wrong model or mode.
  - If Cursor's parser tolerates the tokens, `--force` lands on every resume. That means unattended shell and edits, plus a trust-gate bypass, with `--autonomy` off. This contradicts the profile ("autonomy OFF", `profile.ts:29-31`) and the Security section's claim that the trust gate is not weakened (line 261).
  - The value should likely be `["-p"]`. `turnTail` already appends `streamFlags` and the model on resume (`argv.ts:133-150`).
  - Phase 4 has no argv-corpus test that would catch this.
- **Rung:** 3.

### 2. The effort mechanism is placed in the wrong consumers and cannot run as written

- **Severity:** blocking.
- **Where:** New closed-vocabulary members, item 5 (line 130); Effort mechanism (lines 136-145); Refusals (lines 245-248); Phase 2 (line 289).
- **What is wrong:**
  1. **The model token is not rendered where the RFC says.**
     - `--model` is emitted by `turnTail` in `argv.ts:139-150`, after `validateModel` checks the id against `vocabulary.models`.
     - `renderTurnOptions` (`turn-options.ts`) emits option tokens. It cannot replace a token that `argv.ts` already emitted.
     - The RFC names `turn-options.ts`, `vocabulary.ts`, and `resolve-options.ts`, but not `argv.ts` (launch `turnTail`, resume `resumeArgv`).
  2. **Family bases are not slugs.**
     - `models.txt` has `claude-opus-4-8-low` through `-max` but no bare `claude-opus-4-8`. The same holds for `claude-fable-5-1`, `gpt-5.6-sol`, and others.
     - With `extensible: false` (line 108), `--model claude-opus-4-8 --effort high` refuses `unknown-model` in `turnTail` before any rule on line 139 runs.
     - The RFC also never says what `--model claude-opus-4-8` does with no effort.
  3. **Profile divergence cannot be decided per model with today's code.**
     - Expressibility is per harness: `EXPRESSIBLE.effort = (h) => h.turnOptions.effort !== undefined` (`resolve-options.ts:84`).
     - With a spec present, the profile default `medium` is always copied into the resolved options (`resolve-options.ts:342-423`).
     - `renderTurnOptions` gets only the value, with no tier. It cannot tell a profile default from an explicit `--effort`.
     - The rules on lines 141-142 (explicit refuses, profile default diverges) therefore need a model-aware expressibility check and tier data. Neither is specified.
  4. **A render-less spec kind breaks a stated invariant.**
     - `{ kind: "effort-in-model" }` has no `render`.
     - `turn-options.ts:268-270` says "From here every spec carries a render", then calls `resolveRender(spec, phase)` and reads `spec.render.kind` (`:301`).
     - The `TurnOptionSpec` union and those sites need an explicit arm. The RFC does not name them.
  5. **Several combinations are unspecified:**
     - **Profile default with an explicit variant slug** (for example `--model claude-opus-4-8-high` and profile `medium`). Rule 3 (line 140) refuses a conflicting effort but speaks only of `--effort`. An implementer who applies it to the profile value refuses every run that names a variant slug.
     - **Config-tier effort** (`user-config`, `project-config`). This is neither "explicit" nor "profile default".
     - **Resume with `--effort` but no `--model`.**
- **Impact:** an implementer has to invent the family-base validation order, the tier plumbing, and the argv site. Different reasonable choices produce blanket refusals on bare variant-slug runs.
- **Rung:** 3.

### 3. The effort facts disagree with the raw model list

- **Severity:** high.
- **Where:** Terminology "Family base" (line 58); Descriptor fields lines 104, 106, 107; Effort rules lines 138, 142, 143; Refusals line 245.
- **What is wrong:**
  - **`gpt-5.2` does have effort variants.** `models.txt` lists `gpt-5.2-low`, `gpt-5.2-high`, `gpt-5.2-xhigh` and their `-fast` twins. Probe 29 shows bare `gpt-5.2` announcing `"model":"GPT-5.2 Medium"`, so the bare slug is the medium tier.
    - The RFC's "`gpt-5.2` maps none (bare slug only)" (line 107) is wrong, and so is its use as a complete selection (line 138).
    - As specified, `--model gpt-5.2 --effort high` refuses although `gpt-5.2-high` exists.
    - The spike report §10 makes the same error; the raw capture is authoritative.
  - **`gpt-5.3-codex` has no gap at medium.** It lists `-low`, bare, `-high`, `-xhigh`, so the bare slug is the middle tier. Line 142's example of a family "which offers low/high/xhigh but no medium" is the same misreading, and the divergence it prescribes is not needed. `gpt-5.1` has the same shape.
  - **The slug count is wrong.** `models.txt` has 223 slugs (70 of them `-fast`), and probe 26's stderr lists 223 comma-separated entries. The RFC (line 104) and the References (line 312) say 110, a count carried over from the spike report.
  - **Irregular spellings go beyond what line 143 lists:**
    - `claude-4.6-sonnet-medium-thinking` and `claude-4.6-opus-max-thinking` put `thinking` after the effort, not in the middle.
    - The default display tier is not always `-high`: `claude-opus-4-7-xhigh` is "Claude Opus 4.7 1M", `kimi-k3-max` is "Kimi K3", `gemini-3.6-flash-high` is "Gemini 3.6 Flash".
    - `kimi-k3` has low/high/max with no medium. `glm-5.2` has high/max only.
    - The RFC never says whether `-fast` slugs belong to their own family rows.
  - **The table keys are unspecified.** `gpt-5.5-extra-high` sits beside `xhigh` everywhere else. Line 106 puts `extra-high` into `efforts` as a separate effort. The RFC does not say whether `effortSlugs` keys are hcn effort words (`xhigh` maps to `gpt-5.5-extra-high`) or Cursor suffix spellings. Only the first choice normalizes. The second makes callers learn Cursor's spelling per family.
- **Impact:** the snapshot test in Phase 1 would faithfully encode a wrong table. The "family" concept has no definition an implementer can apply to the irregular entries.
- **Rung:** 3.

### 4. The decoder's `timestamp_ms` rule turns message-granularity text into tokens

- **Severity:** high.
- **Where:** Stream decoding table lines 156-158; `launch.streamFlags` line 88; State Machine lines 199-206.
- **What is wrong:**
  - The RFC maps `assistant` WITH `timestamp_ms` to `token` and WITHOUT it to `message`.
  - The captures contradict this outside probe 11:
    - `out/15-fetch.stdout` lines 7 and 16 and `out/13-edit.stdout` are plain `stream-json` runs with no partial flag. Their pre-tool assistant segments carry both `timestamp_ms` and `model_call_id`.
    - Only the final flush lacks `timestamp_ms`.
    - Under the RFC rule, those full segments are decoded as `token` events on a message-granularity stream.
  - The spike's own description of partial deltas (§3: `timestamp_ms` and NO `model_call_id`) points to a different discriminator. That discriminator was never tested against a partial run that uses tools.
  - No capture combines `--stream-partial-output` with tool calls. Line 88's claim that the partial flag "changes nothing else" is unverified for tool turns.
  - **Tool events can be lost.** `out/15-fetch.stdout:39-41` shows the rejected `webSearchToolCall` with `interaction_query` request and response, then `tool_call/completed`, and no `tool_call/started`. The "fire once on start" rule (line 158) emits no `tool` event for it.
  - **The event order in the state machine is wrong.** In `out/20-askq.stdout` the `interaction_query` pair comes before `tool_call/started`, not inside TOOL_CALL (lines 204-206).
- **Impact:**
  - Consumers get wrong granularity on message pins.
  - A tool can run, or be denied, with no `tool` event.
  - Phase 4 fixtures (probes 11 and 11b only for assistant shapes) would not catch either problem.
- **Rung:** 3.

### 5. Passing `--trust` (and `--continue`) through the `--` separator is unverified and likely becomes prompt text

- **Severity:** high.
- **Where:** Scope line 32; Autonomy line 172; Identity and resume line 182; Failure classification line 229 (via `messageFor`, line 127); Alternatives item 4 (line 278).
- **What is wrong:**
  - hcn passthrough forwards a literal `--` to the harness: `[...base, "--", ...opts.passthrough]` (`argv.ts:271-272`, ADR 0003).
  - Cursor takes the prompt as positional words joined by spaces (research doc line 176, documented). So `agent -p <prompt> --output-format stream-json -- --trust` most likely treats `--trust` as prompt text, or fails on extra positionals.
  - No probe passed any flag after `--`.
  - The RFC's only remedy for the new `trust-refused` class ("re-run with `--trust` ... passthrough", line 127) and its account of `--continue` / `--resume=-N` (line 182) both rest on this path.
- **Impact:** the typed failure points callers at a remedy that may not work. The owner decision that callers opt into `--trust` explicitly then has no working channel.
- **Rung:** 2. A single probe settles it.

### 6. Consumers of the new vocabulary are missing from the "verified against the code" list

- **Severity:** medium.
- **Where:** New closed-vocabulary members (line 124, "Verified against the code"); Implementation Plan phases 3-5.
- **Consumers found that the RFC does not name:**
  - **`NATIVE_SETTINGS_SOURCES`** (`src/knowledge/native-settings.ts:4-9`). It is indexed by harness at `src/execution/native-settings.ts:40`, so typecheck fails without a `cursor: null` entry.
  - **Refusal hints.** `hints.ts` has no cursor table. `tool-selection.ts:152-154` falls back to `"nearest control on codex: category switches ... see hcn inspect codex"`. The owner-mandated `--tools` refusal on cursor would print a codex hint.
  - **Override validation.**
    - `overrides.ts:77-78` hard-codes `store.cwdSlug` to `["dash-separators","pi-dash-wrapped","verbatim"]` instead of reading `CWD_SLUGS`, so any cursor override that touches `store.cwdSlug` is refused.
    - `validateMatchers` and the `matcherOverrides` counting (`overrides.ts:172-262`) cover only `limitMatchers` and `authMatchers`.
    - The Security claim that a crafted override "cannot widen" `trustMatchers` (line 263) needs those sites extended. They are not listed.
  - **Classification sites.** Auth phrasings are detected per stderr line in `supervisor.ts:190-202`, not only at the two sites named on line 127. The RFC does not say whether trust detection joins that scan. It also does not say where it sits relative to the transport and unavailable checks in the tail scan (`stream-turn.ts:571-581`).
  - **Transcript root selection.** `src/cli/transcript.ts:76-89` is a nested ternary on `options.harness` whose final branch is pi, so cursor would resolve a pi store root. It is harmless today because `transcript: null` refuses at `chooseTranscriptMethod`, but it is a latent `h.name` branch the RFC-02 rule (line 47) says not to add to.
  - **Smoke scripts.** `scripts/smoke-seven.ts:29`, `scripts/smoke-questions.ts:34`, and `scripts/smoke-all.ts` hard-code the four descriptors. Phase 5 ("with the cursor harness") cannot run without editing them.
  - **README contract.** `test/docs/readme-contract.test.ts:55-57` fails unless the README lists `"trust-refused"`. `CONTEXT.md` and `AGENTS.md` say "four harness interfaces". No phase updates them.
  - **Resume-last ranking.** Line 113 says the most-recent race "is owned by the existing corroboration ranking". `rankResumeLast` has no production caller (only `test/interpretation/resume-last.test.ts`).
- **Impact:** `pnpm check` fails partway through Phase 3 in ways the plan does not predict, and the cursor `--tools` refusal ships with a codex hint.
- **Rung:** 3.

### 7. The store root and md5 slug rest on unobserved precedence, and a wrong path refuses valid resumes

- **Severity:** medium.
- **Where:** `store.rootEnv` line 110; `store.cwdSlug` line 111; members item 4 (line 129); Identity and resume line 181; Phase 4 line 293.
- **What is wrong:**
  - Line 110 states "First set var wins" with `CURSOR_CONFIG_DIR` first, and a default of `{home}/.cursor`.
    - The spike report §1 records CURSOR_CONFIG_DIR precedence over XDG_CONFIG_HOME as **not observed**.
    - Nothing shows that `CURSOR_CONFIG_DIR` moves `chats/` at all (it is documented only as the config dir).
    - The `{home}/.cursor/chats` default was never observed; this machine runs with `XDG_CONFIG_HOME` set.
    - The XDG behavior is documented for Linux/BSD and was observed on macOS once (probe 36).
  - With `onMissing: "create"`, a wrong computed path does not warn. It refuses a valid resume with exit 2 (`run.ts:41-57`). That is the class of bug fixed in #103 (`resume-guard.ts:46-50`).
  - `--workspace` passed through makes Cursor file the session under `md5(<workspace>)` (probe 30). The guard computes from the spawn cwd, so it refuses that resume too. Line 175 calls targeting "the spawner's job" but does not refuse or warn on the passthrough form.
  - The md5 input is not specified as bytes. The spec should say UTF-8 of the real path with no trailing slash, and include a non-ASCII vector.
- **Impact:** the resume guard is the one part the RFC calls load-bearing (line 181), and its precedence table is a guess stated as fact.
- **Rung:** 2.

### 8. `trust-refused` sits in the retryable precedence tier but is non-retryable, with no rationale

- **Severity:** medium.
- **Where:** members item 2 (line 127); Failure classification lines 229 and 238; Open Question 3 (line 303).
- **What is wrong:**
  - `failure.ts:5-13` defines the load-bearing split: provider-unavailable classes are safe to route elsewhere, and `rejected`/`native` are terminal-by-classification (`PRECEDENCE` 0).
  - The RFC places `trust-refused` at precedence 2 (the provider-unavailable family) and sets `retryable: false`.
  - A trust refusal happens before any inference, so there is no verdict on the work. Routing the same work to another harness is safe, which argues for the router's walk to continue. `rejected` (non-retryable because "the remedy is different options or a different harness") argues the other way.
  - The RFC neither picks the family deliberately nor explains the mix.
  - Since cursor stderr never co-occurs with another failure in the captures, the precedence number is mostly moot. The retryable bit is what the delegate walk branches on.
- **Impact:** a fallback walk stops on a failure that another route would clear, or continues on one the owner wanted to surface. The RFC does not say which outcome is intended.
- **Rung:** 2.

### 9. Denials that exit 0 surface only as unstructured `error` events

- **Severity:** medium.
- **Where:** Stream decoding line 160 and the paragraph at line 167; Failure classification line 233; Escalation lines 255.
- **What is wrong:**
  - Rejected tool calls become non-terminal `error` events whose only content is prose ("Names the tool and the reason when non-empty").
  - The same event kind already carries identity errors (`decode.ts:157`, `:166`) and codex notices (`content.ts:142-146`).
  - A caller cannot tell "Cursor denied shell/web access" from other informational errors without parsing prose, which runs against ADR 0002.
  - `done` stays `clean` with exit 0.
  - Probe 15 shows the model answering from training data after every fetch path was denied. A caller that ran without autonomy gets a clean result for work that never ran.
  - Reporting what happened inside one supervised process passes ADR 0007. The RFC neither adds a structured marker (for example `error` with a tool name field) nor states in the event contract that denials are indistinguishable.
- **Impact:** the exit-0 denial case, which is the main behavioral difference of v1 without ACP, is invisible to machine consumers.
- **Rung:** 2.

### 10. Owner decisions are rendered inconsistently

- **Severity:** medium.
- **Where:** Effort mechanism line 134; Open Question 1 line 301; members item 1 line 126; Scope line 30; Abstract line 14.
- **What is wrong:**
  - **Effort (decision 6).** The owner decision as briefed is that `--effort` works on cursor, adapted to slug suffixes because brackets are rejected. The RFC treats the adaptation as unconfirmed:
    - Open Question 1 offers option (b), "park `--effort` on cursor entirely (always refuse)", which contradicts the decision.
    - It makes Phase 2 wait for an answer ("MUST NOT start Phase 2"), which blocks work that is already settled.
  - **`hcn ls`.** The decision puts transcripts and `hcn ls` out of v1. Line 126 says the `SHARED_DESCRIPTORS` entry "is also what makes `hcn ls` list it".
    - `src/cli/ls.ts` lists descriptors (`name@verifiedAgainst`), not sessions. The Abstract speaks of "session listings".
    - Either the owner meant session listings, so `hcn ls` listing cursor is fine, or the owner meant the command. The RFC should state which reading it takes.
- **Impact:** a settled decision is re-opened and blocks work, and a stated exclusion is contradicted without comment.
- **Rung:** 2.

### 11. The Security section understates what `--force` grants and omits the codex precedent

- **Severity:** low.
- **Where:** Scope line 32; Autonomy lines 171-173; Security line 261; Alternatives item 4 (line 278).
- **What is wrong:**
  - `--force` is the full autonomy flag: unattended shell and edits (probes 16/17). On cursor, `--autonomy` therefore also bypasses workspace trust.
  - Line 261 presents this as not weakening the gate. It weakens the gate exactly when autonomy is on.
  - The remedy text on line 127 should name hcn's own `--autonomy` and say what it grants, not only raw `--force`.
  - hcn already bypasses codex's trusted-directory check on every run (`codex.ts:27-32`, `--skip-git-repo-check` in `baseFlags`). Alternatives item 4 does not mention this, or why cursor is treated differently.
  - Citing ADR 0007 against `--trust` (lines 32 and 278) misapplies it. The ADR bars hcn from tracking or storing state across processes; a harness persisting its own trust file is a different matter. The owner decision stands on its own and does not need that argument.
- **Rung:** 2.

### 12. Evidence labels and small inaccuracies

- **Severity:** low.
- **Where:** lines 86, 88, 113, 153, 157.
- **What is wrong:**
  - **Line 86** says "Observed: positional words joined as the prompt (probes 09-11)". Every probe passed the prompt as one escaped token (`out/09-text.argv`, `out/11-partial.argv`), so this is documented, not observed. hcn also places the prompt before the stream flags and `--model` (`turnTail`, `argv.ts:133-150`), while every probe put the prompt last. Flags after the positional were never observed.
  - **Line 113** says `--continue` "equals `--resume=-1`". Probes 22 and 23 ran against different most-recent sessions, so equality is inferred, not shown.
  - **Line 153** says identity authority is `harness-minted`. On resume the decoder emits `caller-assigned` whenever `requestedId` is set (`decode.ts:150`), as it does for codex today. The table should match the code or the RFC should change the code.
  - **Line 157** gives the token-granularity double delivery as "by design". It is observed for one tool-free turn only (see Finding 4).
  - **No large-prompt transport.** `stdinPrompt` is absent (line 87), so large prompts hit ARG_MAX with no alternative. That is acceptable for v1 but unstated.
- **Rung:** 2.

## Cleared

- The structural validator passed.
- **ADR 0007 scope.** Every proposed capability normalizes or supervises one spawned process. No cross-process state, index, or correlation is added. `rootEnv` and the md5 slug are normalization of store location.
- **Purity and chat-seam gates.** A vendored pure-TypeScript md5 in `src/interpretation/store.ts` imports no `node:` builtin. `TextEncoder` is already used in the pure layer (`argv.ts:123`). `node:crypto` is used only in cli/execution (`execution/native-settings.ts:1`). Nothing proposed touches lucid, frames, or chat-protocol imports.
- **Line 128:** `dash-separators` replaces only `/` and `.` with no collapsing or trimming (`store.ts:21-22`).
- **Line 126:**
  - `READERS` is `Record<HarnessName, ...>` (`content.ts:244`) and fails closed.
  - `NATIVE_APPROVAL_PROTOCOLS` is indexed by `h.name` at `native-approval-plan.ts:19` and fails closed at typecheck.
  - `SUPPORTED` derives from `HARNESS_NAMES` (`cli/index.ts:11`).
  - `DescriptorSet` is `Partial` (`overrides.ts:27`).
- **Stdin close policy.** `close-required` spawns with stdin `"ignore"` (`node-deps.ts:103`), which is `/dev/null`. The spike's passing probes used `</dev/null`, and the hang (notes 07) used an open pipe. The policy matches the evidence.
- **`onMissing: "create"` guards.** Both named guards exist: the pre-spawn refusal at `run.ts:41-57` (and `session.ts:207-225`), and the warning at `stream-turn.ts:249-252`. The unknown-UUID-creates behavior matches probe 24.
- **Trust refusal detection.** Probe 01 stderr contains `Workspace Trust Required` on one line, with empty stdout and exit 1. Without a detector, the tail scan would classify it as `native` (`stream-turn.ts:562-581`). The `trust-refused` class needs a detector in that path, as the RFC says.
- **Stream-level failures.**
  - The terminal-error forward rule (line 163) mirrors the claude reader (`content.ts:80-85`).
  - Killed shapes (probes 33b/34, exit 143/130, no `result`) fit the `killedByAbort` path.
  - No failure in the spike wrote JSON to stdout.
- **`transport` fallthrough.** A silent nonzero exit stays `transport` (`stream-turn.ts:581`).
- **Transcripts.** `transcript: null` reaches `passive-read-unverified` (`methods.ts:32-45`), not a crash.
- **`--tools` on cursor.** `denySemantics: "no-lists"` refuses (`tool-selection.ts:143-156`); the hint problem is in Finding 6.
- **Owner decisions rendered faithfully:**
  - Cursor only, with Grok deferred.
  - v1 is one-shot turns plus resume, no ACP.
  - No hidden flags (`idFlag: null`; identity comes from `system/init`).
  - hcn does not pass `--trust` by default, and trust refusal is a typed failure.
  - Auto-update is left alone as a drift risk.
  - Transcripts are out of v1.
  - Name `cursor`, bin `agent`.
  - TDD, then one `feat:` release with the hcn skill updated and `check-claims` run.
- **Data sensitivity** (line 271) agrees with the spike's fixture guidance.

## Not reviewed

- **hcn skill source.** `~/dev/skills/skills/vendor/hcn/` and its `check-claims` scripts were not read. Phase 5 names them correctly, but whether they need structural change for a fifth harness was not checked.
- **Native terminal resume.** `interactive-preflight.ts` is codex-specific and would refuse other harnesses. The RFC is silent on `hcn` native terminal resume for cursor, and whether that silence is acceptable was not checked.
- **Research doc.** Only the sections used for cross-checks were read (Cursor prompt shape, stdin, the model count, and the descriptor mapping rows).
- **Live behavior.** No live Cursor runs were made. Every claim about Cursor behavior comes from the spike captures and cited docs.
- **`src/cli/session.ts`.** It has partial graph coverage. Only lines 180-225 were read directly.
