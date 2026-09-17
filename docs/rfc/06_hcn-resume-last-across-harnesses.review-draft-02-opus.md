# Review: RFC-06 hcn --resume-last across harnesses (draft-02, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`
  - Frontmatter: `revision: 02`, `status: Draft`, `type: feature`, `date: 2026-09-17`.
  - Length: 736 lines. The file is untracked (`git status`: `??`).
- **SHA-256:** `b4766f457a4272e5f681540c4d3c5472674c70fc266745a119bdb3960c5eca71`. RFC line numbers below refer to this file.
- **Base commit:** `8a0476722674206ce7fafc92db621576c87199a0`.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review of an RFC written by a Meta Muse model.
- **Previous review:** `06_hcn-resume-last-across-harnesses.review-draft-01-opus.md`.
- **Inputs used:**
  - the RFC and its draft-02 revision record
  - `evidence.md`, including the probe-safety record and the M5 rule
  - every capture for probes 10-20 in `out/` (argv, exit, stderr, and stdout, parsed per record)
  - RFC-05 `revision: 07` (the `store.rootEnv` rows and the Resume-last section)
  - hcn source, cited per finding
- **Graph checks:**
  - `trace_path` inbound on `buildSpawnArgv`: 3 callers (`planTurn`, `streamTurn`, `buildContextInspectionArgv`).
  - `check_index_coverage` on the cited source files: all report `no_recorded_issue`.
- **Store reads:** directory listings and file times only, from the claude project store for `ws-claude` and from `~/.claude/session-env`. No transcript content was read.
- **Not read:**
  - pi session stores
  - anything under `~/.local/share/cursor-agent` or Cursor's shipped code
  - any value from the deleted `05-pi-scope.stdout`
- **Capture checks:** probes 10-20 were checked with count-only pattern scans. No values were printed.

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
- **Rung 3:** traced through hcn code.
- **Rung 4:** observed in a raw capture or in store metadata (file names and times).

This pass made no live run.

## Draft-01 findings: resolution check

| Finding | Status | Basis |
| --- | --- | --- |
| B1 captures held secret material | Resolved, with residue | `05-pi-scope.stdout` is gone, and only `.argv/.exit/.stderr` remain. The Data sensitivity text (lines 548-564) is correct. Count-only scans of probes 10-20 find no token-like strings, key fields, or email-like strings. Residue: see L3 (user hook output). |
| B2 argv order | Resolved for `turnTail`, open for the option segment | Probes 10, 12f, 13, and 14 put the prompt before stream, model, and tools flags. 12b shows prompt-after-tools fails (exit 1, the prompt is consumed by `--allowedTools`). The before-prompt turn-option segment is still unpinned: see M2. |
| H1 resume semantics and `planTurn` | Resolved | All five sites exist at the cited lines: `argv.ts:268`, `plan-turn.ts:298`, `plan-turn.ts:396`, `stream-turn.ts:231`, `context-inspection.ts:26`. A grep of `src/` for `resume === undefined`/`!== undefined` finds no other launch-vs-resume branch. The remaining hits are id-specific (`run.ts:41`, `stream-turn.ts:249`, `freshDecodeState`, native settings). New consequence: see M4. |
| H2 warning names an unknown id | Resolved in form | The text is fixed at spawn and carries no id (lines 426-430). Its content is wrong in two places: see H1 and H3. |
| H3 muse refusal predicate | Resolved | `headless: boolean` plus the `spellingOf` arm keyed on it (lines 344-348). Muse no longer lists itself. Ordering issue with RFC-05: see M3. |
| H4 RFC-05 dependency | Mostly resolved | Dependency and supersession are stated (lines 92-96). RFC-05 is `revision: 07`, as cited. Residue: see M3. |
| H5 parent session and scope granularity | Scope resolved, policy text open | Probes 16b, 17b, and 18b mint fresh ids from `sub/`, and 19b exits 1, so exact-cwd scope is supported (rung 4). The parent hazard goes to OQ3, but the pinned warning does not carry it: see H3. |
| M1 version gap and evidence | Resolved, with residue | Versions are stated, `verifiedAgainst` is frozen (lines 609-611), and the fixture destination is named. Residue: see L5. |
| M2 consumer lists | Resolved, with residue | hints, help, inspect, native approvals and settings, the identity sites, README, doc comments, `CONTEXT.md`, interactive, and the session option are all named. Residue: see L1. |
| M3 unprobed flags | Claude resolved, codex partly | 12e observed stream-json with `--continue`. 11b does not discriminate: see M2. |
| M4 cursor no-session with stream flags | Resolved | Probe 15: exit 1, stdout 0 bytes, stderr `No previous chats found.` A new ambiguity appears: see H2. |
| M5 fresh-vs-resumed premise | Resolved | OQ4 matches the captures. Checked: probe 18b header `01a0ad05-f6ca` at `01:40:44.362Z`, and probe 20 at `01:39:51.031Z` in `ws-pi-b`. |
| L1 parse-resume claims | Resolved | Lines 450-458. |
| L2 scope rests on ids | Resolved in principle | Probe 20 has an unexplained prior state: see M1. |
| L3 framing | Resolved | Lines 121-127. |

## Findings

Findings are in severity order.

### H1 (high). Claude silently created a fresh session while resumable sessions existed; the RFC hides probe 12 and states a narrower rule

- **Where:**
  - No-session table (lines 386-392)
  - warning text (lines 426-428)
  - Terminology "Silent create" (line 194)
  - grammar row evidence (line 291), which cites 12f but not 12
- **What the captures and store show:**
  - Probe 12 ran in `ws-claude` and exited 0. Its `system/init` carries a fresh `67fb70ea`, and the reply says there is no code word.
  - Store metadata for the `ws-claude` project directory, listed at the time of this review, shows 16 transcripts older than the one probe 12 created:
    - `62217c38` (last modified 08:32:32), the session probe 02 had resumed;
    - 15 transcripts written between 08:33:23 and 08:35:14.
  - `67fb70ea.jsonl` was born at 08:35:22, during probe 12. Its capture ends at 08:35:38.
  - So `claude -p --continue` minted a new session although sessions existed in the exact cwd.
  - Probe 12 also emitted a `SessionStart:resume` hook under a separate id `98f62446`. Claude attempted a resume and then filed a new session.
- **What is wrong:**
  - The RFC's rule is "starts a fresh session with exit 0 when nothing is resumable" (line 427), with the table keyed on "no prior session in exact cwd".
  - Probe 12 is a silent create with prior sessions present, most likely because the most recent ones were auth-failed turns. The mechanism is unverified.
  - 12f does not reproduce probe 12's state. Probe 12c planted a new healthy session in between, so 12f shows the argv works on a healthy store, not that probe 12's state was harmless.
- **Why it matters:**
  - The "polluted" state is ordinary for hcn callers. A failed turn (auth, limit, crash) in a directory is exactly what precedes a caller's "continue".
  - The next `--resume-last` then starts a blank session with exit 0. The pinned warning text tells the caller this happens only when nothing exists.
- **Required:**
  - Record probe 12 in the RFC as an observed silent create with prior sessions present, and widen the table row and warning clause to match.
  - Add a probe that isolates the trigger: a single failed turn after a healthy session, then `--continue`.
  - Or list the trigger as an open question for the owner.
- **Rung:** 4 for the fact. 1 for the mechanism.

### H2 (high). Cursor's `No previous chats found.` also means "wrong store root", and the RFC treats it as one meaning; the same root split causes silent create on claude and pi

- **Where:**
  - No-session table row cursor (line 391)
  - warning text for cursor (lines 429-430)
  - Native failures row 1 (line 506: "hcn cannot know pre-spawn")
  - State Machine NATIVE_ERROR (lines 477-478)
- **What the evidence says:**
  - `evidence.md` (probe-safety record and probe 14): without `XDG_CONFIG_HOME`, cursor reads `{home}/.cursor/chats/` and reports `No previous chats found.` for a cwd that has a session.
  - For claude (`CLAUDE_CONFIG_DIR`) and pi (`PI_CODING_AGENT_DIR`), the env also selects the store. Under a different root those harnesses do not error: they fall into the silent-create path with exit 0.
- **What is wrong:**
  - The RFC never mentions store-root resolution. Its cursor rows, warning text, and state machine all read the error as "nothing is resumable".
  - A caller whose environment differs from the interactive shell hits the ambiguity: launchd agents, `env -i`, CI, or `--env` overrides. The caller would then start fresh and split sessions across two roots.
  - "hcn cannot know pre-spawn" is overstated for cursor:
    - RFC-05 (`store.rootEnv`, `store.defaultRoot`, `md5-hex` slug) gives hcn the resolved root and the per-cwd chats directory before spawn, from the same environment the child inherits.
    - A directory-level existence check (`{root}/chats/{md5(cwd)}`) needs no id and ranks nothing, so it is not the hcn-side resolution that Alternative 1 rejects.
    - The claude and pi store templates also carry `{cwdSlug}` (`claude-code.ts` store, `pi.ts` store). Codex's template does not.
- **Required:**
  - State the two meanings on the cursor rows.
  - Name the resolved store root in the warning, or in a diagnostic line.
  - Add an Alternative, or an Open Question, for a pre-spawn per-cwd store-directory check on claude, pi, and cursor. The check would warn or refuse when the directory is absent. Record why it is taken or declined.
- **Rung:** 4 for the cursor store-root effect (`evidence.md`, probe 14 attempt). 3 for hcn's ability to compute the directory.

### H3 (high). OQ3 recommends "warn" for the parent-session hazard, but the pinned warning text never names the hazard

- **Where:** Safety policy item 1 (lines 375-378), item 4 texts (lines 426-430), Open Question 3 (lines 675-683).
- **What is wrong:**
  - OQ3 option (b) says: "warn (the item-4 text names the hazard; the signal marks the turn)".
  - The two pinned texts name only the most-recent pick, the cwd, and the fresh-or-error clause. Neither mentions re-entering a live parent session.
  - An implementer who pins the texts verbatim (Phase 3, line 633) ships the recommended policy with no warning for its hazard.
  - The hazard is still unprobed (rung 2). Its consequence is also broader than "wrong session": a delegate appending to the transcript a live interactive process is writing puts two writers on one session file. The blast radius (lines 539-546) does not state this.
- **Required:**
  - Make the item-4 text carry the parent-session clause if (b) is recommended, or correct OQ3.
  - Add one probe: an interactive session open in cwd, then a headless `--continue` in the same cwd, per harness. Or state the probe as the OQ3 criterion.
- **Rung:** 3 for the text mismatch. 2 for the hazard.

### M1 (medium). Probe 20 ran in a cwd that held a prior pi session, and minted a fresh id without explanation

- **Where:** Terminology "Exact-cwd scope" (line 195), Safety policy item 1 (line 363), Data sensitivity (lines 555-556), no-session row pi (line 390).
- **What is wrong:**
  - Probe 05 created pi session `01a0acef-d6ea` with header cwd `ws-pi-b`.
  - Probe 20 ran `pi -p --mode json --continue ... --no-tools` with header cwd `.../ws-pi-b` and minted fresh `01a0ad05-2677` (header `01:39:51.031Z`).
  - Exact-cwd resolution predicts a resume of `01a0acef-d6ea`. The RFC calls probe 20 a scope probe, and it cites probe 20 in the no-session row as a fresh-id example.
  - Two explanations fit, and the documents state neither:
    - the probe-05 session was removed from pi's store before probe 20 (this review did not check, per instruction), which makes probe 20 a no-session probe;
    - or pi also silently creates with a prior same-cwd session present, which is the probe-12 pattern from H1.
  - Probe 20 still shows that sibling workspaces do not cross.
- **Required:** Record the store state of `ws-pi-b` before probe 20, and relabel the probe accordingly.
- **Rung:** 4 for the header cwd and ids. 1 for the cause.

### M2 (medium). The option segment of the codex grammar is unpinned, and probe 11b does not show the sandbox is enforced

- **Where:** Grammar row codex (line 292), OQ1 (lines 661-664), revision record item 10 (line 169).
- **What is wrong:**
  - **Placement.**
    - Both builders emit the before-prompt turn options ahead of `turnTail` (`argv.ts:182` launch, `argv.ts:242` resume; the only after-prompt key is the access tool-preset at `turn-options.ts:66-72`).
    - The resume-phase sandbox render therefore lands as `codex exec resume --last --json --skip-git-repo-check -c sandbox_mode=<m> <prompt> --model <id>`.
    - Probes 11, 11b, and 17b placed `-c` after `--model`, which is not the order the builder emits. The row writes the segment as "plus resume-phase renders" with no position, so the byte-for-byte pin (line 286) is underdetermined.
    - The same gap applies to claude and pi before-prompt renders (effort, system prompt, memory flags).
  - **Enforcement.**
    - 11b asked for a write under `workspace-write`, and the file landed (a `file_change` item, then `DONE`).
    - The thread's original sandbox came from probe 01, which set none and used codex's own default and user config. So the write does not show the override took effect.
    - The existing evidence at `codex.ts:157-165` used the discriminating form: `read-only` blocks the write.
- **Required:**
  - Show the before-prompt segment in each row.
  - Probe the builder's placement.
  - Replace or extend 11b with a `-c sandbox_mode=read-only` write attempt on `--last`.
- **Rung:** 3 for placement. 4 for the capture argv.

### M3 (medium). `headless` becomes required in Phase 1, but RFC-05 lands first with `resumeLast: { flag }`, and Phase 1 and Phase 5 disagree on cursor

- **Where:** Descriptor data (lines 253-272), Phase 1 (lines 607-615), Phase 5 (lines 653-657), Scope (lines 92-96).
- **What is wrong:**
  - RFC-05 must land first (line 93), and its cursor descriptor carries `resumeLast: { flag: "--continue" }` (RFC-05 line 207).
  - Phase 1 makes `headless` part of the type, so Phase 1 must edit `cursor.ts` or typecheck fails.
  - Phase 5 says the cursor value lands "only in the conditional phase".
  - Phase 1 "pins the five descriptor values (four renderable, muse parse-only)". With RFC-05 landed, that set includes cursor as renderable, before its corpus rows exist.
- **Required:**
  - Set cursor to `headless: false` in Phase 1 and flip it in Phase 5.
  - Or state that Phase 1 renders cursor, and move its corpus rows forward.
- **Rung:** 3.

### M4 (medium). Under resume semantics, a silent-create session runs without the defaults profile, and the RFC does not say so

- **Where:** Turn-option phase rule (lines 297-306), lines 334-337, Security "Permissions model" (lines 533-537), no-session table.
- **What is wrong:**
  - Because resume-last skips the profile, a claude, codex, or pi silent create produces a new session with none of the profile's settings: memory off, sandbox `workspace-write`, effort medium, codex context window.
  - A bare `hcn run` launch in the same cwd applies all of them.
  - Probe 17b shows the effect. It ran a fresh codex session from `sub/` with `-c sandbox_mode=read-only` and replied `otter`, a word from an unrelated session, the same leak as probe 05. The RFC mentions only probe 05, as "whatever memory or profile content answered".
  - Line 537 ("no profile opinion leaks into a continued conversation") covers the resumed case, not the fresh one.
- **Required:**
  - State in the no-session table or Security that a silently created session runs with native defaults, not the profile.
  - Cite probe 17b.
  - Or give the owner the choice: apply the profile when the announced id is fresh (codex and pi only, per OQ4), or accept the difference.
- **Rung:** 4.

### L1 (low). Consumer details still missing

- **Where:** planTurn routing (lines 316-332), Refusals (lines 339-353), Phase 3.
- **What is missing:**
  - **`TurnRunOptions`.** `streamTurn` takes `TurnRunOptions extends LaunchOptions` (`stream-turn.ts:97`), not `SpawnArgvOptions`, so the `resumeLast` field must be added there too.
  - **Native-approvals refusal site.** `streamTurn` dispatches `nativeApprovals` before any argv is built (`stream-turn.ts:128-131`). The refusal must sit in `planTurn`/`nativeApprovalPlan`, and the RFC does not say which.
  - **Muse refusal raise site.** The builder, `buildSpawnArgv`, or `planTurn` is not named.
  - **Order rule for new harnesses.** No generic rule states where `extraFlags` sit relative to the resume-last token. The rows show `bin, extraFlags, --continue` for flag style and `bin, exec, resume, --last, extraFlags` for positional.
- **Rung:** 3.

### L2 (low). The warning's `<cwd>` has no defined source

- **Where:** lines 426-430.
- **What is wrong:**
  - `effective.cwd` is optional (`stream-turn.ts:106`). When it is absent, the child inherits the process cwd.
  - The harnesses slug the realpath: the claude project directory is `-private-tmp-...`, and `resume-guard.ts:22-28` resolves realpath for this reason.
  - A verbatim-pinned text needs to say which value fills `<cwd>`: the caller's `--cwd`, the process cwd, or the realpath.
- **Rung:** 3.

### L3 (low). Claude fixture candidates carry user-level hook output

- **Where:** Data sensitivity (lines 548-552), Phase 4 (lines 645-647).
- **What is wrong:**
  - Probes 12, 12b, 12e, and 12f each contain 7 `hook_response` records from the user's `SessionStart` hooks (about 47-72 KB of stream).
  - The probes kept `CLAUDE_CONFIG_DIR`, so user settings loaded.
  - Count scans found no token-like strings or emails. Hook output is still account material of the same kind as the connector names the RFC bars.
  - The safety rule lists scrubbed env and tools off, but not user hooks.
- **Required:** Add "project setting sources only, or hook records excluded" to the fixture rule.
- **Rung:** 4 (record counts only; content not read).

### L4 (low). Context inspection on resume-last is named as a site but not decided

- **Where:** line 332.
- **What is wrong:** With the discriminant, `hcn inspect claude --context --resume-last` renders `--continue` plus `forkFlag` on a harness-chosen session. No probe covers `--continue --fork-session` with the control flags, and the RFC neither refuses the combination nor lists it in OQ1.
- **Rung:** 3.

### L5 (low). Evidence durability and one uncaptured claim

- **Where:** References (lines 703-705), grammar row codex (line 292).
- **What is wrong:**
  - The normative evidence stays in a session-specific `/private/tmp` scratchpad. Phase 4 files fixtures from a re-run, so the probes this RFC is judged on have no durable home.
  - The codex `-s read-only` rejection ("10 variant") has no capture in `out/`. Only `04-codex-sandbox-reject` exists, and it covers `--sandbox`.
- **Rung:** 4.

## Open Questions assessment

- **OQ1 (carve-outs):** sound as a criterion ("observed reject, never `--help`"). Its "verified" list overstates the codex sandbox result (M2).
- **OQ2 (signal shape):** sound.
- **OQ3 (parent-session policy):** the options and recommendation are reasonable. The pinned text contradicts the recommendation (H3), and the criterion should name the missing probe.
- **OQ4 (strict continue on codex/pi):** sound. The values match the captures.
- **Missing questions** that the owner needs before sign-off:
  - the silent-create trigger with prior sessions present (H1);
  - store-root ambiguity and whether a per-cwd store-directory check belongs (H2);
  - profile-less fresh sessions under silent create (M4).

## Cleared

- **Validator.** Passed.
- **`turnTail` order on four harnesses (captures).**
  - Probe 10: `01a0acec-9c43`, reply `ORCHID-7`.
  - Probe 12f: `system/init` `d39f8b8d`, result `KITE-3`, with `--allowedTools Read` last.
  - Probe 13: header `01a0acec-ccea`, original timestamp `01:13:15.242Z`.
  - Probe 14: `d6bc3262`, cwd `ws-cursor`, result `ORCHID-7`.
- **Prompt-after-tools on claude.** 12b exits 1 with `Error: No deferred tool marker found in the resumed session ... Provide a prompt`. This confirms `turnTail`'s tools-last rule.
- **Claude identity decoding under `--continue`.** Streams 12, 12e, and 12f open with `SessionStart:resume` hook records carrying a different, throwaway `session_id` (`98f62446`, `839bdd5e`, `dfcbd527`). The claude announce matcher is `system/init` only (`claude-code.ts` identity; `identity.ts:110-113`), so hcn ignores those ids and announces the resumed id. No change is needed.
- **Exact-cwd scope.**
  - Probe 16b: fresh `10d670c1` from `sub/`.
  - Probe 17b: fresh `01a0ad05-b7f5`.
  - Probe 18b: fresh `01a0ad05-f6ca`, header cwd `ws-pi/sub`.
  - Probe 19b: exit 1, stdout 0 bytes, after plant `e72f453d` in `ws-cursor`.
  - Claude's plant `4d988a1f` is filed in the `ws-claude` project directory, which confirms the root/sub layout.
- **Cursor no-session with the full stream set (probe 15).** Exit 1, stdout 0 bytes.
- **The five discriminant sites.** Lines verified. No other launch-vs-resume branch exists in `src/`.
- **`--native-settings-fingerprint` refusal.** Already `invalid-option-value` with option `nativeSettingsFingerprint` when `opts.resume` is missing (`verified-native-settings.ts:18-31`). The RFC row matches.
- **`headless` split.** It removes muse from its own `supportedBy` and needs no harness-name branch.
- **Scope widening as the owner's decision.** Line 114-117. The draft-02 RFC-05 record is superseded (lines 129-131).
- **Labeling for the AGENTS.md scope test.** Warning as supervising policy, field as normalization (lines 121-127). ADR 0007 holds: nothing crosses process boundaries.
- **Draft-01 L1, L3, M4, M5.** Resolved as tabled above.

## Not reviewed

- **pi session stores**, per instruction. Probe 20's prior state (M1) is therefore unresolved here.
- **Transcript content** of any claude session, including the 15 transcripts from auth-variable bisecting in the `ws-claude` project directory. Only names and times were listed. Whether those transcripts hold environment material was not checked. They sit in the user's claude store, not in the captures.
- **User hook output** in probes 12-12f, beyond record counts.
- **Cursor behavior** beyond the captures and RFC-05 text. No Cursor shipped code or `~/.local/share/cursor-agent` content was read.
- **hcn skill source** (`~/dev/skills/skills/vendor/hcn/`) and `check-claims`.
- **Live behavior.** No harness was run.
