# Review: RFC-06 hcn --resume-last across harnesses (draft-01, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`
  - Frontmatter: `revision: 01`, `status: Draft`, `type: feature`, `date: 2026-09-17`.
  - Length: 495 lines. The file is untracked (`git status`: `??`).
- **SHA-256:** `0dd6dbd567b40d391839f047a028383e618f5eea0c3bafe691ce5f894d8d7f13`. RFC line numbers below refer to this file.
- **Base commit:** `8a0476722674206ce7fafc92db621576c87199a0`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review of an RFC written by a Meta Muse model.
- **Inputs used:**
  - the RFC
  - `evidence.md` and all 25 probe captures in `scratchpad/resume-last/out/` (argv, exit, stderr, stdout)
  - RFC-05 revision 06 (the Resume-last section and the draft-02 and draft-06 records) and `05_cursor-cli-harness.review-draft-05-opus.md`
  - `AGENTS.md`, `CONTEXT.md`, ADRs 0002 and 0007, `docs/harness-updates.md`
  - hcn source, cited per finding
- **Graph checks:**
  - `trace_path` inbound on `buildSpawnArgv`. Callers: `planTurn`, `streamTurn`, `buildContextInspectionArgv`.
  - `check_index_coverage` on all 20 cited source files. All report `no_recorded_issue`.
- **Not read:** nothing under `~/.local/share/cursor-agent`. Secret values in the captures were not read (see B1).

## Structural results

Command:

```
npx tsx ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md
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

- **Rung 1:** the RFC's own claim, not checked.
- **Rung 2:** consistent with repo docs, code comments, or reasoning from them.
- **Rung 3:** traced through hcn code, or checked against `--help` text in the captures.
- **Rung 4:** observed in a raw probe capture. That includes values computed from capture data.

This pass made no live run and wrote no reproducer.

## Findings

Findings are in severity order.

### B1 (blocking). The probe captures hold secret-bearing material, and the RFC says they do not

- **Where:**
  - Security Considerations, "Data sensitivity" (lines 372-379)
  - Implementation Plan Phase 4 (line 442: "transcribe evidence into the corpus fixtures")
  - References (line 483), which make the captures normative
- **What is wrong:**
  - The RFC says: "The captures contain only scratch UUIDs, scratch paths, and model reply text; the evidence record names no token, keychain entry, or account email."
  - `out/05-pi-scope.stdout` disproves this. In the scope probe the pi agent ran about 20 bash tool calls, including `env | sort | head -80` and `git config --list`, and the tool results are recorded in the stream.
  - A name-only grep of that file finds environment entries named `CLAUDE_CODE_MESSAGING_TOKEN=` and `META_API_KEY=`, and a `user.email=` entry. The values were not read.
  - `out/03-claude-nosession.stdout` lists the account's connector names (Gmail, Google Calendar, Google Drive, reviewsion).
  - The codex stderr files carry plan-tier text ("not available on your current plan").
- **Why it matters:**
  - Phase 4 tells the implementer to transcribe this evidence into `test/fixtures/`. AGENTS.md says fixtures are never scrubbed, so anything copied in stays in git.
  - The pre-push TruffleHog hook might not catch the values.
  - The review process sends these files to hosted models. Under the global privacy override, secret material must not enter a hosted model's context.
- **Required:**
  - Treat `05-pi-scope.stdout` as secret material. Any check of its values runs on a local model.
  - Remove the "no token ... or account email" claim.
  - Name which captures may become fixtures, and say how they are cleaned before capture. The pi scope probe must be re-run with tools off or in a workspace with no readable siblings.
- **Rung:** 4.

### B2 (blocking). The grammar table's token order contradicts the argv builder, and taken literally it puts the prompt inside a variadic tools flag

- **Where:** Render rule and per-harness grammar table (lines 186-192), Implementation Plan Phase 2 (line 427: "pin the four observed grammars byte-for-byte").
- **What is wrong:**
  - The table puts `<prompt>` last on every row, for example `[claude, -p, --continue, ...launch-phase turn options, ...stream flags, <prompt>]`.
  - hcn's builder puts the prompt before those flags. `turnTail` (`src/interpretation/argv.ts:132-177`) emits `prompt, ...streamFlags, model, autonomy, tools, skills` in that order.
  - Its comment says why: "the variadic tools flag LAST and fed exactly one joined token so nothing after it can be swallowed as a tool name." With the prompt after `--allowedTools`/`--tools`, the prompt is consumed as a tool name.
  - The probes do not settle the order. Every probe put the prompt last, with at most `--model` and one output flag before it. No probe used hcn's real order (prompt, then stream flags, model, autonomy, tools).
- **Why it matters:**
  - A TDD implementer must pin argv "byte-for-byte". The table and the existing builder give two different byte sequences, and the RFC does not say which one wins.
  - Following the table breaks any claude resume-last turn that carries a tool grant.
  - Following the builder uses an order the probes never ran.
- **Required:**
  - State that the resume-last argv reuses `turnTail` ordering.
  - Show each row in that exact order.
  - Add probes in that order for at least codex (`exec resume --last --json --skip-git-repo-check <prompt> --model X`) and claude (prompt followed by the full stream-json set and a tool grant).
- **Rung:** 3.

### H1 (high). The launch-phase rule skips resume refusals and turns on the defaults profile, and the RFC never names `plan-turn.ts`

- **Where:** Turn-option phase rule (lines 194-201), CLI surface (lines 139-158), Implementation Plan Phase 3 (lines 433-438).
- **What is wrong:**
  - **Resume refusals are skipped.**
    - claude `isolation` has `resumeRender: null` (`claude-code.ts:194`), and the descriptor comment says "Resume and native overrides are refused". `RUN_HELP` says `--isolation <tool-free>` means "Fresh tool-free turn (claude); no resume" (`help.ts:110`).
    - Under the RFC's rule, `hcn run claude --resume-last --isolation tool-free` renders `--bare --tools "" --disallowedTools mcp__* --strict-mcp-config` onto a continued conversation.
    - The same session semantics (re-entering an existing conversation) would then refuse or render depending only on how the id was chosen.
  - **The defaults profile turns on.**
    - `planTurn` runs `resolveEffectiveOptions` only when `extra.resume === undefined` (`plan-turn.ts:298`). The comment: "Defaults profile + config: LAUNCH-ONLY. Omitted settings follow native behavior on resume".
    - `buildTurnEnv` picks its phase from the same test (`plan-turn.ts:396`, `stream-turn.ts:229`).
    - A resume-last turn has no resume id. It would therefore get launch semantics: the profile's sandbox `workspace-write`, memory off, effort medium, and the codex context window, plus provenance lines. `hcn run --resume <id>` gets none of these.
    - For codex this also means `-c sandbox_mode=workspace-write` renders on every resume-last turn, which Open Question 1 still marks unverified.
  - **The difference is visible in the probes.** In probe `05-codex-scope`, codex without the profile answered "otter", a code word from an unrelated session. The evidence attributes that to persistent memory. Whether the profile runs therefore changes model-visible content.
  - **The one owner is missing.** `plan-turn.ts` owns the plan the runner and `inspect --argv` share (RFC-02 change 10), and `buildSpawnArgv` has exactly three callers (graph). The RFC adds a separate `buildResumeLastArgv` and says nothing about how it enters `buildSpawnArgv` or `planTurn`.
- **Required:**
  - Define resume-last as a resume-semantics turn: no profile, `resumeRender` refusals apply on all four harnesses, and `buildTurnEnv` uses phase `resume`.
  - If launch semantics is the intent instead, justify it and list each option whose behavior changes.
  - Route the builder through `buildSpawnArgv` so `planTurn` and `streamTurn` stay in agreement.
- **Rung:** 3.

### H2 (high). The warning must name an id that does not exist before spawn, and the RFC gives two different warning texts

- **Where:** Safety policy item 4 (lines 267-279), State Machine WARN (lines 302-303), item 1 (line 235).
- **What is wrong:**
  - Item 4: "the runner yields an early `error`-kind warning naming the resumed id and the cwd scope, before any harness output."
  - With resume-last, the resumed id is known only when the stream announces it. The F-23 warning is pushed before stdout decoding starts (`stream-turn.ts:245-252`, `:291-293`), so no id is available at that point.
  - The State Machine instead says the warning names "cwd scope and the silent-create table". The two texts conflict.
  - On cursor, which exits 1 with "No previous chats found.", a silent-create warning would be false.
- **Why it matters:**
  - A TDD implementer cannot write a passing test for "names the resumed id before any harness output".
  - The warning text is the only human-readable guard on this path.
- **Required:**
  - Pick one text, fix at spawn time, with no id.
  - Say whether it varies per harness (silent create on claude, codex, and pi; error on cursor).
  - Pin it verbatim.
- **Rung:** 3.

### H3 (high). The muse refusal has no descriptor predicate, and the specified `spellingOf` arm lists muse as supported

- **Where:** Descriptor data (lines 176-178), Refusals (lines 213-219), Error Handling row 1 (line 324).
- **What is wrong:**
  - muse keeps `resumeLast: { flag: "--last" }` (`muse.ts:88`) "as parse data ... never a render target". No descriptor field records that "never a render target" status.
  - So nothing in the data lets a builder decide to refuse muse. The only possible test is `h.name === "muse"`, which is a harness-name branch the descriptor architecture avoids.
  - The specified arm, `return h.resumeLast?.flag ?? null`, returns `"--last"` for muse. `supportedBy(defaultDescriptors(), "resumeLast")` then yields claude, codex, pi, **and muse**. The muse refusal would list muse itself as a harness that supports the option.
  - The RFC says this arm yields "the four-harness spelling list (claude `--continue`, codex `--last`, pi `--continue`, cursor `--continue`)". That is wrong on two counts: muse is included, and cursor is absent from the default set (H4).
- **Required:**
  - Add descriptor data that separates a renderable resume-last from a parse-only one. Examples: `resumeLast: { flag, headless: boolean }`, or a separate `parseOnly` marker.
  - Key both the refusal and `spellingOf` on it.
  - Update `descriptor-consumers.test.ts` and `dimensions-coverage.test.ts` if the shape changes.
- **Rung:** 3.

### H4 (high). Every cursor row depends on the unlanded RFC-05, and RFC-05 says the opposite

- **Where:** Abstract (line 16), Scope (lines 73-74), Descriptor data (line 174), Implementation Plan Phase 1 (lines 421-423), Error Handling (line 334).
- **What is wrong:**
  - `src/knowledge/` has no cursor descriptor. `HARNESS_NAMES` and `defaultDescriptors()` hold four harnesses.
  - RFC-05 is at `revision: 06`, `status: Draft`.
  - RFC-05's Resume-last section (lines 303-305) says: "For cursor v1, most-recent resume is not reachable through hcn."
  - RFC-06 makes it reachable but declares no dependency, no landing order, and no supersession of that sentence.
  - Phase 1 says "Tests pin the five descriptor values". Only four descriptors can compile.
  - Line 74 says "this RFC changes no existing harness behavior". claude and pi gain a new render path, so the claim is false.
- **Required:**
  - State that RFC-05 must land first, or split the cursor rows into a conditional phase.
  - Record the supersession of RFC-05's "not reachable" sentence.
  - Correct line 74.
- **Rung:** 3.

### H5 (high). The stranger-race bound misses the RFC's own named user, and the scope probes cannot separate cwd from repository root

- **Where:** Safety policy item 1 (lines 224-235), Terminology "Cwd-scoped" (line 119), Fit check user 1 (lines 78-82), Security "Blast radius" (lines 365-370).
- **What is wrong:**
  - **The race is not only between concurrent hcn runs.**
    - The RFC names "delegation workers" as users and says "only same-cwd concurrent runs can pick each other's sessions".
    - A delegation worker usually runs from an interactive harness session in the same repository. `claude --continue` resolves "the most recent conversation in the current directory", and probe 02 shows it re-enters that session under the same id.
    - So `hcn run claude --resume-last` launched from a Claude Code session in the repo would pick the caller's own live parent session and append a turn to it. The same holds for any interactive session the user has open in that cwd.
    - `descriptor.ts` presence docs already name `claude --continue` as invisible to presence detection.
    - Not probed. Rung 2.
  - **Scope granularity is not established.**
    - Every A and B workspace is its own git root: `git rev-parse --show-toplevel` returns the workspace itself for `ws-*` and `ws-*-b`.
    - The probes show that sibling repositories do not share most-recent. They cannot show whether a harness scopes by exact cwd, git root, or project.
    - No probe ran from a subdirectory of a repository with a session at the root.
    - "Most-recent resolves within sessions filed under the spawn cwd ... Observed on all four" states more than the probes observed.
- **Required:**
  - List the parent-session hazard in item 1 and in the blast radius.
  - Reword Cwd-scoped to what was observed: sibling repositories do not cross.
  - Add a subdirectory-versus-root probe per harness, or mark the granularity as unverified.
- **Rung:** 2 for the parent-session hazard. 4 for the git-root layout.

### M1 (medium). The version gap and evidence preservation are not handled

- **Where:** Problem statement (lines 45-48), Descriptor data (lines 169-178), Implementation Plan Phase 4 (lines 440-445), References (line 483).
- **What is wrong:**
  - **No versions or verification anchor.**
    - The RFC never states the probed versions and never mentions `verifiedAgainst`.
    - The probes ran on claude 2.1.274, codex 0.154.0, pi 0.85.1, and muse 1.3.0. The descriptors say 2.1.263, 0.153.4, 0.84.2, and 1.1.1.
    - `docs/harness-updates.md` and AGENTS.md allow a bump only after `smoke:seven` and `smoke:questions`, updated together with `versionSource` and `escalation.observedOn`.
    - The correct handling is: new descriptor facts (claude and pi `--continue`, the no-session table) cite "observed on <version>, 2026-09-17" in descriptor comments, and `verifiedAgainst` stays unchanged.
    - Phase 4's "re-run the probe matrix" is not that procedure. The RFC should say so, or an implementer may treat it as grounds for a bump.
  - **Ephemeral evidence.**
    - The normative evidence sits in a session-specific `/private/tmp/claude-501/.../scratchpad/` path that will not survive.
    - The repo convention is captured evidence under `test/fixtures/<harness>-<version>/`.
    - The RFC should name that destination, subject to B1.
- **Rung:** 3.

### M2 (medium). Consumer and vocabulary lists are incomplete

- **Where:** Refusals (lines 213-220), Safety policy item 3 (lines 254-265), Implementation Plan Phases 2-3.
- **Missing consumers:**
  - **`hints.ts` `HINTS`.** Error Handling line 324 promises a hint. ADR 0002 says hints are "curatorial, versioned, and pinned verbatim", so a muse `resumeLast` entry and a hints-test count bump are needed. This repeats the RFC-05 M4 pattern.
  - **`help.ts`.** `RUN_HELP` needs the flag. The `inspect` help needs it too, if `inspect --argv` accepts it.
  - **`inspect --argv`.** It goes through `planTurn`, and `resumeIdOf` is also called from `inspect-native-settings.ts:15`. The RFC never says whether `hcn inspect <h> --argv --resume-last` previews the argv or refuses.
  - **`--native-approvals` and `--native-settings-fingerprint`.** Both require an exact resume id (`native-settings-argv.ts:23-50`, README native approvals). The refusal raised today with no id reads as "fresh sessions ... refused". The resume-last combination needs a stated refusal.
  - **Identity emit sites.**
    - `decode.ts:127-139` covers the first announce and the model-attestation re-emit.
    - The flag must reach decode state. `freshDecodeState(effective.resume ?? null)` has no input for it.
    - `native-approval-turn.ts:336` is a third emit site. It only matters if native approvals are not refused.
    - `events.ts` needs the type, and `render.ts:18` the renderer line.
  - **README.** The event contract at line 670 and the identity text at lines 122 and 241. Say whether a README contract test covers the new field.
  - **Doc comments made false by this RFC.** `descriptor.ts:489-490` ("The race it opens is owned by the corroboration ranking") and `parse-resume.ts:24-25` ("corroboration ranking (rankResumeLast) decides what it names").
  - **`CONTEXT.md` "What hcn supervises".** It lists six parts and says "Six parts supervise". A standing warning policy is a new one, or the RFC should say why it is not.
  - **`hcn interactive`.** It has its own `--resume` grammar. State that resume-last is out of scope there.
  - **`hcn session` refusal.** Name the `option` field it carries.
- **Rung:** 3.

### M3 (medium). The "verified subset" claims more than the captures show

- **Where:** Grammar table rows for claude and codex (lines 188-189), phase rule (lines 198-199), Open Question 1 (lines 449-454).
- **What is wrong:**
  - **claude.** Probes 02, 03, and 05 used `--output-format json`. hcn renders `--output-format stream-json --verbose --include-partial-messages` (`claude-code.ts` `launch.streamFlags`). `--continue` combined with the stream-json set is unobserved, yet the row says "...stream flags" and line 198 calls json output verified "on all four".
  - **codex.** Line 189 says the resume-phase render "MUST apply here". `evidence.md` marks `-c sandbox_mode` on the `--last` argv as unverified, and Open Question 1 leaves it open. A normative MUST rests on an open question.
  - H1 makes this worse: with the profile on, that render appears on every codex resume-last turn.
- **Required:** Probe both before they become normative, or mark them unverified in the table.
- **Rung:** 4 (the capture argv files).

### M4 (medium). The cursor no-session row was captured without the output flags hcn renders

- **Where:** No-session table (line 248), Native failures table (line 333).
- **What is wrong:**
  - Probes `02-cursor-continue-nosession` and `05-cursor-scope` ran `agent -p --continue` and `agent -p --force --continue` without `--output-format stream-json`.
  - The table states "stderr `No previous chats found.`, empty stdout" as the shape hcn sees. hcn always renders stream-json, and cursor may report the error as a JSON `result` on stdout under that flag.
- **Required:** One probe with the full hcn argv in an empty workspace.
- **Rung:** 4.

### M5 (medium). "No harness reports fresh-vs-resumed in-stream" is false for codex and pi

- **Where:** Scope out-of-scope item 3 (lines 69-72), Alternative 5 (lines 408-411), Open Question 5.
- **What is wrong:**
  - **UUIDv7 timestamps.** codex thread ids and pi session ids are UUIDv7. Their embedded timestamps, computed from the captures:
    - Resumed ids predate the spawn: codex `01a0acec-9c43` is 01:13:02 and was resumed at 01:13:58; pi `01a0acec-ccea` is 01:13:15 and was resumed at about 01:14.
    - Fresh ids fall inside the run: codex no-session `01a0acef-1869` is 01:15:45, with stderr at 01:15:42; pi `01a0acee-6484` is 01:14:59.
  - **pi's header.** pi's `{"type":"session"}` record also carries a `timestamp` field. In `06-pi-model-resume` it is the original 01:13:15; in `03-pi-nosession` it matches the run.
  - Claude showed no such marker.
- **Why it matters:**
  - Alternative 5 is rejected on the grounds that detection is impossible without a store scan.
  - A spawn-clock comparison inside one supervised process fits the ADR 0007 boundary and would enable strict continue on two harnesses.
  - Whether UUIDv7 layout and header timestamps are stable enough to rely on is an open question, not a settled no. It is an owner call.
- **Required:** Restate the premise per harness and give the owner the choice.
- **Rung:** 4 for the data. 1 for stability as a contract.

### L1 (low). `parse-resume.ts` claims are slightly off

- **Where:** lines 65-66, 283-290.
- **What is wrong:**
  - `isResumeLast` matches only `h.resumeLast.flag`, so shell history with `claude -c` or `pi -c` does not parse. The RFC says the parser "already recognizes" the new commands. That holds for the long form only.
  - "`parse-resume.ts` stays its only production-adjacent consumer" of `rankResumeLast`: `parse-resume.ts` mentions it only in a comment, and `parseResumeCommand` has no production caller (grep of `src/`).
- **Rung:** 3.

### L2 (low). The pi scope conclusion must rest on the id, not the reply

- **Where:** line 229, `evidence.md` pi scope.
- **What is wrong:** In `05-pi-scope` the agent read `../out/01-pi-turn1.stdout` and `02-pi-resume-last.stdout`, found ORCHID-7, and declined to use it. The reply "no code word" shows the agent's judgment, not scope. The fresh id `01a0acef-d6ea` is the valid evidence. The claude and codex B probes also rely on fresh ids, which hold.
- **Rung:** 4.

### L3 (low). The scope-test framing of the warning is loose

- **Where:** AGENTS.md scope test (lines 98-102).
- **What is wrong:** A fixed pre-spawn warning does not "watch the process". Under `CONTEXT.md` it is a supervising policy. The identity field is normalization, since it reports how the argv was built. Labeling each correctly avoids a precedent where any static message counts as supervision.
- **Rung:** 2.

## Cleared

- **Validator.** Passed.
- **Scope widening is recorded as the owner's call.** Fit check item 4 (lines 91-94) names WIDENS and records the 2026-09-17 owner decision. The draft-02 RFC-05 record is marked SUPERSEDED (lines 103-105). This answers RFC-05 review L6.
- **ADR 0007.** hcn stores nothing and correlates nothing across processes, and no hcn-side store scan is added. The rejection of hcn-side resolution (Alternative 1) matches the AGENTS.md habit "check whether the harness already does it".
- **Recall grammar (probes 02 and 04).**
  - claude 02 kept `62217c38`.
  - codex 02 kept thread `01a0acec-9c43`.
  - pi 02 kept `01a0acec-ccea`.
  - cursor 04 kept `d6bc3262`.
  - Each replied `ORCHID-7`.
- **Codex grammar facts.**
  - Probe `04-codex-sandbox-reject`: exit 2, `unexpected argument '--sandbox'`, usage `codex exec resume --last --json [SESSION_ID] [PROMPT]`.
  - Probe `04-codex-lone-positional`: exit 1, "Reading prompt from stdin... No prompt provided via stdin." A lone positional does not become a prompt.
  - Probe `06-codex-model-resume`: `--model` accepted on `--last`.
  - The "always emit `--last`" rule is sound.
- **No-session behavior for claude, codex, and pi (probes 03).** Each exits 0 with a fresh id and a full inference run. `resume.onMissing` must not be consulted: claude is `"error"` in `claude-code.ts` yet silently creates here.
- **Cursor flags.**
  - `06-cursor-model-resume`: `--model` is validated on `--continue`, exit 1 with zero inference.
  - `04-cursor-resume-last`: `--force` and `--output-format stream-json` compose with `--continue`.
  - The no-session check runs before the trust gate (02, in an untrusted workspace).
- **Muse has no headless grammar.** `04-muse-resume-help` shows picker semantics and no prompt argument. `04-muse-resume-last-attempt` stops at the workspace trust wall with no TTY.
- **Identity authority.** `requestedId` is null on this path, so `decode.ts:150` gives `harness-minted`. An additive optional field is compatible with README line 670 ("additive across releases").
- **Mutual exclusion site.** `resumeIdOf` (`args.ts:212-225`) is the one shared check, so widening it there is correct.
- **`buildRefusalMessage`** switches on issue, not option (`refusal.ts:73`), so it needs no new arm.
- **Codex `resumeRender` data.** `sandbox` and the `access` presets already carry `-c sandbox_mode` resume renders (`codex.ts:166-185`). No new descriptor spelling is needed for the id path.
- **Probe count.** 25 argv captures, matching the abstract.

## Not reviewed

- **Secret values** in `out/05-pi-scope.stdout`. Only variable names were matched. Checking values needs a local model under the privacy override.
- **hcn skill source** (`~/dev/skills/skills/vendor/hcn/`) and its `check-claims` scripts.
- **`src/cli/session.ts` refusal placement**, beyond the `resumeIdOf` call site at line 88.
- **`test/docs/readme-contract.test.ts`**, beyond confirming that it lists `identity` among event kinds. Whether it pins identity fields was not checked.
- **Live behavior.** No harness was run. Every behavior claim above comes from the captures.
