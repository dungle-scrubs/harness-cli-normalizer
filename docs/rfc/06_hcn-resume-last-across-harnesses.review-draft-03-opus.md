not ready: 2 blocking/high

# Review: RFC-06 hcn --resume-last across harnesses (draft-03, opus reviewer)

## What was reviewed

- **RFC:** `docs/rfc/06_hcn-resume-last-across-harnesses.rfc.md`
  - Frontmatter: `revision: 03`, `status: Draft`, `type: feature`, `date: 2026-09-17`.
  - Length: 938 lines. The file is untracked.
- **SHA-256:** `bf2e6df46d4ddc685346071fab8282aef2f2c81e54523263554981f7f42d001f`. RFC line numbers below refer to this file.
- **Base commit:** `e904e6e5027f66d0ebca10a48849290cc306ed71`.
  - The working tree has uncommitted RFC-05 implementation work: `src/knowledge/cursor.ts` (untracked) and changes to `descriptor.ts`, `support.ts`, `refusal.ts`, and others.
- **Reviewer:** `claude-opus-5` (route `opus-5@claude`), reasoning effort high. One pass, no delegation. This is a cross-family review of an RFC written by a Meta Muse model.
- **Previous review:** `06_hcn-resume-last-across-harnesses.review-draft-02-opus.md`. This review corrects that review's H1 (see B1).
- **Inputs used:**
  - the RFC
  - `evidence.md`, including the draft-03 appendix
  - every capture for probes 30-50, parsed per record for ids, results, and hook-record counts
  - capture file times for probes 11b, 12, and 30-48
  - RFC-05 frontmatter
  - hcn source, cited per finding
- **Store reads:** metadata only.
  - `~/.claude/session-env/<id>` birth times.
  - Directory listings of the `ws-h1-claude` project directory and the `ws-h1-pi` pi slug directory. Both are now empty; see L2.
- **Not read:**
  - no transcript content
  - no pi store content beyond directory names
  - no hook record content
  - no Cursor shipped code

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
- **Rung 2:** consistent with docs or code comments, or reasoning from them.
- **Rung 3:** traced through hcn code.
- **Rung 4:** observed in a raw capture, a capture time, or store metadata (names and birth times).

This pass made no live run.

## Draft-02 findings: resolution check

| Finding | Status | Basis |
| --- | --- | --- |
| H1 silent create with prior sessions | **Withdrawn, and the revision built on it is wrong** | See B1. Draft-02's reading of probe 12 was wrong, and the draft-03 trigger probes show a resume of the killed run's session, not a silent create. |
| H2 cursor error has two meanings | Partly resolved | Both meanings are on the cursor rows (line 504), in the warning (lines 554-558), and in the state machine (lines 612-614). Alternative 6 and OQ6 were added. The diagnostic root is wrong for claude and pi: see M1. |
| H3 warning omits the parent-session clause | Text resolved; policy should be re-asked | The clause is pinned (lines 551-553, 556-558). Probes 47-48 confirm the hazard (ids and times check out). See H1. |
| M1 probe 20 prior state | Resolved at rung 2 | Relabeled as a no-session probe (evidence M1 appendix). It cannot be rechecked, because the pi store was cleaned. The probe-05 file question is in L3. |
| M2 option segment and enforcement | Placement resolved; enforcement probe does not discriminate | See M2. |
| M3 cursor `headless` ordering | Resolved | Phase 1 sets `headless: false` and Phase 5 flips it (lines 341-345, 777-782). `cursor.ts:705` now exists with `resumeLast: { flag: "--continue" }`. |
| M4 profile-less fresh session | Resolved | Stated at lines 507-511 and 677-681, with OQ7. |
| L1 consumer details | Resolved | `TurnRunOptions` (lines 430-432). The native-approvals dispatch is at `plan-turn.ts:342-343`, as cited. `inspect --context` also goes through `planTurn` (`inspect-context.ts:41`), so the muse refusal covers it. `extraFlags` rule at lines 377-380. |
| L2 `<cwd>` source | Resolved | Lines 543-546. |
| L3 hook output in fixtures | **Not resolved** | See M3. |
| L4 context inspection | Resolved as a release-gate item | Line 424-428. |
| L5 evidence durability, `-s` capture | Resolved | Probe 50: exit 2, `unexpected argument '-s'`. Destination named (lines 822-824). |

## Findings

Findings are in severity order.

### B1 (blocking). The killed-turn "silent create" is a misread: claude and codex resumed the killed run's own session. Draft-02 H1 was also a misread.

- **Where:**
  - Abstract (lines 24-26)
  - Terminology "Silent create" (line 268)
  - No-session table rows claude, codex, pi (lines 501-503)
  - the pinned warning clause "including after a killed or crashed turn" (lines 550-551)
  - revision record item 1 (lines 199-206)
  - Open Question 5 (lines 865-873)
- **Codex (captures only):**
  - Probe 39 (victim, a fresh `codex exec` launch, killed) opens with `thread.started` `01a0ad12-211b-70d3-a088-c42b876fd8b6`. That id's UUIDv7 time is 01:54:01, and the probe-39 argv was written at 08:54:01 local.
  - Probe 40 (`exec resume --last`) announces the same `01a0ad12-211b`.
  - Probe 40 did not create anything. It resumed the most recent thread in the cwd, which was the killed launch. That thread holds a story prompt and no HERON-4.
  - The RFC calls this "fresh thread 01a0ad12" (line 502).
  - Probes 43, 44, and 49 also announce `01a0ad12-211b`, consistent with a resume.
- **Claude (capture times plus `session-env` birth times):**
  - Probe 33 (victim, a fresh `claude -p` launch with json output, killed) has no id in its capture.
  - `~/.claude/session-env/6b879754-...` was born at 08:52:04, the same second probe 33's argv was written.
  - Probe 34 started at 08:52:32 and announced `6b879754`.
  - So probe 34 resumed the victim's session. The same birth-equals-start pattern holds for `489bd8d1` (08:51:29, probe 30) and `c7e8ad6b` (08:55:56, probe 47).
  - Evidence line "No session file for the victim appears in the ws-h1-claude project directory afterward" cannot be true once probe 34 resumed that id. The listing cannot be rechecked, because the directory is now empty (L2).
- **Probe 12 (correction of review draft-02 H1):**
  - `session-env/67fb70ea` was born at 08:35:20 and its transcript at 08:35:22. Both predate probe 12's argv (08:35:30).
  - Probe 12's throwaway hook id `98f62446` was born at 08:35:31, which is probe 12's start.
  - So probe 12 resumed the most recent session in `ws-claude`, a bisecting run created ten seconds earlier. It did not create a fresh session.
  - Draft-02 compared the transcript birth with the capture end time instead of the probe start. That H1 is withdrawn.
- **pi:**
  - Probe 36 (victim) announced header `01a0ad11-31e7`, born 01:53:00.
  - Probe 37 resumed the older plant `01a0ad11-14ba` (01:52:52), skipping the more recent killed session.
  - The pi difference is real, but it is "skips a killed session", not "no poison". Whether the victim was ever filed cannot be rechecked (L2).
- **Why it matters:**
  - The RFC now pins a false mechanism into the verbatim warning ("starts a fresh session ... after a killed or crashed turn").
  - It also asks the owner OQ5 on that basis.
  - The observed hazard is the stranger case: on claude and codex, `--resume-last` after any launch in the cwd (killed, failed, or unrelated) resumes that launch's session with exit 0, carrying that run's history. The `resumeLast` signal description "it MAY be a fresh session" (line 520) omits this case.
  - A consumer reading the warning would look for a blank session, not someone else's.
- **Required:**
  - Restore the table rows to "no session in the exact cwd → fresh".
  - Add the stranger row: "most recent session is a killed, failed, or unrelated run's session → resumed with exit 0". Observed on claude (33-34, 12) and codex (39-40). pi 36-37 skipped the killed session.
  - Rewrite the warning clause and the signal meaning to match.
  - Rewrite or drop OQ5.
  - Correct the evidence line about probe 33's missing file.
- **Rung:** 4.

### H1 (high). The parent-session policy should go back to the owner: "warn" was chosen before the hazard was confirmed

- **Where:** Safety policy item 1 (lines 479-491), Resolved question 3 (lines 854-858), Blast radius (lines 683-694).
- **What is confirmed:**
  - Parent 47 (headless `claude -p` with stream-json) announced `c7e8ad6b` and ran from 08:55:56 to 08:56:03.
  - Child 48 (`--continue`) ran from 08:55:58 to 08:56:02, announced `c7e8ad6b`, and replied `PONG.`
  - The overlap and the shared id are established at rung 4. The one-file claim cannot be rechecked, because the store was cleaned (L2). It follows from claude's per-id file layout.
- **Why "warn" is no longer a sufficient record of the decision:**
  - The owner answered OQ3 when the hazard was hypothetical. Draft-02 recommended "warn" on that basis.
  - The RFC's first named user, a delegation worker launched from a live harness session in the same repository, meets this case by default on the same harness. It does not need a race.
  - The warning goes to the caller, the parent agent, and cannot prevent the write:
    - the delegate's turn lands in the parent's history;
    - the delegate model receives the parent's full context;
    - two processes write one session.
  - Not observed:
    - an interactive (TUI) parent, since probe 47 was headless;
    - what the parent does after the child appends (its next turn, whether the history branches, whether it overwrites), since the parent was killed one second after the child ended;
    - codex, pi, and cursor.
- **Options for the owner, with consequences:**
  - **(a) Warn (current).** Smallest change. The delegate and parent share history and one file. The consumer must avoid the case on its own, and nothing in the stream says it happened.
  - **(b) On claude, render `--continue --fork-session`.**
    - The child continues from the most recent history under a new id and never writes into the parent's file.
    - Costs: the identity announces the fork id, not the resumed id; claude only; `--continue --fork-session` is unprobed.
    - The next `--resume-last` then picks the fork.
  - **(c) Refuse when a nesting marker says hcn runs inside a live session of the same harness.**
    - It prevents the write.
    - It needs a harness-exported environment marker, and none is verified here.
    - It refuses too broadly when the parent session is in a different cwd.
    - It adds an environment read in the CLI layer.
  - **(d) Accept and document only.** Drops the warning clause and keeps the hazard.
- **Recommendation:** re-ask before sign-off. If (b) is taken, add a probe of `--continue --fork-session` in builder order to the release gate.
- **Rung:** 4 for the hazard. 1 for options (b) and (c) mechanics.

### M1 (medium). The diagnostic root and the Alternative 6 check use home-based templates for claude and pi, though the probes show environment variables move the root

- **Where:** lines 560-564, Alternative 6 (lines 749-761), OQ6.
- **What is wrong:**
  - The diagnostic names "claude/pi/codex: the home-based template root". Alternative 6 checks `{home}/.claude/projects/{cwdSlug}` and `{home}/.pi/sessions/{cwdSlug}`.
  - The probes needed `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR` to find auth and store (`evidence.md` safety record).
  - Probes 45 and 46 show those variables relocate the root.
  - hcn already resolves both for transcripts (`src/cli/transcript.ts:80`, `:88`).
  - As specified, the line names the wrong root, and the check warns falsely, in exactly the case both exist for.
- **Required:** Resolve `CLAUDE_CONFIG_DIR`/`PI_CODING_AGENT_DIR` the way `transcript.ts` does, or state that the claude and pi roots stay unresolved.
- **Rung:** 3 for code. 4 for probes 45 and 46.

### M2 (medium). Probe 49 does not show the before-prompt override is enforced

- **Where:** grammar row codex (line 368), Resolved question 1 (lines 849-851), revision record item 5.
- **What is wrong:**
  - Probe 49 resumed `01a0ad12-211b` (the stream shows that thread id).
  - That thread was launched by probe 39 with `-c sandbox_mode=read-only` (probe-39 argv).
  - The blocked write can come from the thread's recorded sandbox as well as from the override.
  - Probe 11b is the reverse case, a wider override on a thread with no sandbox flag, and depends on codex's default.
  - A discriminating probe launches a thread with `workspace-write`, then resumes with `-c sandbox_mode=read-only` in the before-prompt slot and asks for a write.
- **Rung:** 4.

### M3 (medium). The hook rule rests on json-format probes that cannot show hooks, and the one stream-json probe loaded hooks under `--setting-sources project`

- **Where:** Data sensitivity (lines 696-703), Terminology "Probe" (line 272), revision record item 10.
- **What is wrong:**
  - The RFC says `--setting-sources project` "kept auth working with zero `hook_response` records across probes 30-34 and 47-48".
  - Probes 30-34, 45, and 48 use `--output-format json`, which emits only the result object. Zero hook records there shows nothing.
  - Probe 47 is the only draft-03 claude probe with stream-json. It carries 4 `hook_started` and 4 `hook_response` records (`SessionStart:startup`) despite `--setting-sources project`. Content not read.
  - The fixture rule "project setting sources only ... or hook records excluded" therefore does not keep hook output out.
- **Required:** Make "hook records excluded" the rule for every claude stream-json capture, or find what loads those hooks and turn it off.
- **Rung:** 4 (counts only).

### L1 (low). Identity arrives before auth failure on wrong roots, and the state machine skips it

- **Where:** State Machine (lines 615-617), Native failures row 2 (line 646).
- **What is wrong:**
  - Probe 45 (claude) announces `fb1e4df0` in its result before `Not logged in`.
  - Probe 46 (pi) announces header `01a0ad13` before `No API key found`.
  - hcn will emit `identity` with `resumeLast: true` for a session that then fails. The state machine goes straight from SPAWN to NATIVE_ERROR.
- **Rung:** 4.

### L2 (low). The draft-03 store evidence can no longer be rechecked

- **What is wrong:**
  - The `ws-h1-claude` project directory and the `ws-h1-pi` pi slug directory were emptied at 09:00:39. Both listings show only `.`, `..`, and a claude `memory` directory.
  - Three claims now rest on the author's listing alone:
    - "one transcript file for that id" (H3);
    - "no session file for the victim" (probe 33, contradicted in B1);
    - pi victim filing.
  - Phase 4 re-runs the probes, so this does not block implementation. The RFC should state that the stores were cleaned and when.
- **Rung:** 4.

### L3 (low). Probe 05's missing pi session file needs its cause stated

- **Where:** `evidence.md` M1 appendix ("Probe 05's announced 01a0acef left no file (mechanism unverified)").
- **What is wrong:** If the secret cleanup deleted that file, say so. "Mechanism unverified" reads as a pi behavior when it may be a manual deletion. This review did not look.
- **Rung:** 1.

### L4 (low). RFC-05 anchor and line numbers are stale

- **Where:** lines 96-104, `descriptor.ts:489-491` references, cursor rows.
- **What is wrong:**
  - RFC-05 is now `revision: 09`, `status: Accepted`. RFC-06 cites revision 08, Draft.
  - `cursor.ts` exists in the working tree with `verifiedAgainst: "2026.09.10-fd3934a"`, while the RFC's cursor probes ran on 2026.09.15-d2fe57e. Phase 5 needs the same observed-on comment rule Phase 1 applies to claude and pi.
  - `descriptor.ts` `resumeLast` is now at line 538.
- **Rung:** 4.

## Open Questions assessment

- **OQ5 (killed-turn clause):** the premise is false (B1). Replace it with a question about the stranger clause, for example "the most-recent session may be a killed, failed, or unrelated run's session". The (a)/(b) shape of keeping the clause in the text or table-only still fits. (a) remains the better recommendation.
- **OQ6 (store-directory check):** the options are sound, and (a) warn is defensible: an absent directory is also a legitimate first run. It depends on M1. It also cannot catch B1's case, because the directory exists and holds the wrong session. The RFC should say so.
- **OQ7 (profile on a fresh session):** sound. After B1, the killed-turn path no longer produces fresh sessions on claude or codex, so OQ7 covers the true empty-cwd case only. (a) accept is defensible.
- **Resolved Q3 (parent session):** re-ask (H1).

## Cleared

- **Validator.** Passed.
- **Invalid model poisons nothing.**
  - Claude 31 announces `489bd8d1`, then 32 recalls `MAGPIE-2`.
  - pi 41 exits 1 with no stream, then 42 resumes `01a0ad11-14ba` and recalls `OTTER-9`.
  - codex 43 exits 1, then 44 resumes `01a0ad12-211b`.
- **Parent-session overlap and shared id (probes 47-48).** Times and ids check out.
- **Before-prompt placement.** It matches the builder (`argv.ts:182`, `:242`; `turn-options.ts:66-72`). Probe 49 exercised that slot and the argv was accepted.
- **Probe 50.** `-s` rejected with exit 2.
- **Cursor chats layout.** The claim (per-cwd md5 directory present means resumable) is consistent with probes 04, 14, 15, and 19b. Names only; not re-listed here.
- **`TurnRunOptions`, `planTurn` refusal sites, `inspect-context` routing, `<cwd>` rule, `headless` phasing.**
- **Scope test.** ADR 0007 holds. The widening is recorded as the owner's decision.

## Not reviewed

- **Transcript and hook record content.** Only counts and ids were read.
- **pi store** beyond the `ws-h1-pi` slug directory listing.
- **The uncommitted RFC-05 implementation** in the working tree, beyond `cursor.ts` `resumeLast` and `verifiedAgainst`.
- **hcn skill source** and `check-claims`.
- **Live behavior.** No harness was run.
