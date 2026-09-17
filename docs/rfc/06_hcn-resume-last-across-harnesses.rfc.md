---
number: 06
title: "hcn --resume-last across harnesses"
type: feature
status: Accepted
author: "Muse Code, with Kevin Frilot"
date: 2026-09-17
revision: 06
---

# RFC-06: hcn --resume-last across harnesses

## Abstract

hcn gains one boolean option, `--resume-last`, that resumes the most recent
session on claude, codex, pi, and cursor through each harness's own
headless most-recent grammar, and refuses on muse, which has none. The
design rests on 75 live headless probes (recall, no-session, scope,
flag-acceptance, turnTail-order, subdirectory-scope, sandbox, stranger-case,
store-root, parent-session, fork, sandbox-override, and hook runs per
harness) that fix the wrong per-harness facts behind the resume-last
section removed from RFC-05. No live run was made for draft-05; all
draft-05 changes are text pinned to existing captures, and every shape
still needing a run is a named Phase 4 gate with a stop rule. The resume-last argv reuses the `turnTail`
order (prompt before stream flags, model, autonomy, tools), pinned per
harness against the new probes. Because three harnesses silently start a
fresh session with exit 0 when no session is resumable in the exact cwd,
and because claude and codex resume a killed, failed, or unrelated run's
own session with exit 0 where the caller expected history (probes 33-34,
39-40, rechecked as resumes in draft-04; probe 12 resumed a bisecting
run), the RFC pairs the flag with a required safety policy: one fixed
pre-spawn warning text with no id carrying the stranger clause
(pinned verbatim on the rendered argv shape, except the claude text,
whose no-session clause with the fork pair is unverified until the
Phase 4 gate), a machine-readable resumed-vs-fresh-or-stranger signal
on the identity event, and a normative no-session table per harness. Cursor rows are
conditional on RFC-05 landing first. Most-recent resolution is scoped to
the exact spawn cwd on all four harnesses, which bounds the stranger race
without closing it. The parent-session hazard was probed live (probes
47-48: a `--continue` run re-entered its own running parent under the
parent id): on claude the write into the parent file is designed out by
rendering `--continue --fork-session` (probes 60-63: the child starts
from the parent's saved history under a new id and never writes the
parent file, per the deleted listing; re-probed in Phase 4; the history
inheritance itself remains, by fork design),
while codex, pi, and cursor keep the parent-session warning clause.

## Introduction

### Problem statement

The owner decided on 2026-09-17 to add an hcn option that resumes the most
recent session. The first design lived inside RFC-05 (Cursor harness) and
was moved out after review `05_cursor-cli-harness.review-draft-05-opus.md`
found it unsound: finding B1 showed the rendered flags were invalid or
missing on four harnesses, H2 showed every resume safety net was skipped
with no signal, M4 showed the refusal vocabulary changes were unlisted, and
L6 showed the draft-02 "out of scope" record now conflicted with the body.
Draft-06 of RFC-05 cut the design and pointed at this RFC as its new home,
with the B1/H2 facts as starting input.

This RFC redoes the design from live evidence instead of `--help` output.
For each of the five harnesses it establishes by running the CLI: the exact
headless most-recent argv in hcn's `turnTail` order with working prompt
placement, which turn-option flags that argv accepts, what happens with no
prior session, whether most-recent crosses a subdirectory boundary, and
whether the session id appears in the stream. The captures live under
`/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/5a45c2a9-6252-4aae-9c22-f86a4afa9c3b/scratchpad/resume-last/`
(argv, stdout, stderr, exit per probe, plus `evidence.md` with
observed/documented/unverified labels and a draft-02 probe-safety record).

### Scope

In scope: the `--resume-last` CLI flag; the per-harness render rules pinned
to the observed grammars in `turnTail` order; the `resumeLast` descriptor
corrections for claude and pi plus the renderable/parse-only split; the
`RefusalOption` member and `support.ts` arm behind the muse refusal; the
safety policy (warning, signal, no-session table, parent-session policy
question); the mutual-exclusion and `hcn session` rules; the
`native-approvals` and native-settings refusals on the id-less path;
argv-corpus, refusal, and signal tests; implementation phases including the
conditional cursor phase.

Out of scope, each with its reason:

- **hcn-side most-recent resolution (store scan plus `rankResumeLast` as a
  production caller).** Every supporting harness already resolves
  most-recent natively and scopes it to the exact spawn cwd. Building hcn's
  own scan duplicates that capability instead of forwarding it, against the
  AGENTS.md habit. `rankResumeLast` stays exported and unit-tested with no
  production caller; `parse-resume.ts` mentions it only in a comment, which
  the plan corrects.
- **`--resume=-N` indexing.** It still fails the session-id shape check, as
  in RFC-05. Most-recent is reachable only through `--resume-last`.
- **A strict-continue mode (refuse when nothing is resumable) in v1.** A
  spawn-clock comparison can separate fresh from resumed on codex and pi
  only (UUIDv7 id times, pi header time; see Resolved Question 4), while claude
  and cursor expose no marker. Shipping strictness on two harnesses splits
  the contract, so v1 warns uniformly and callers that need strict
  continuation MUST store ids and use `--resume`.
- **`hcn interactive`.** It has its own `--resume` grammar with a separate
  control pipe (`INTERACTIVE_HELP` in `help.ts:21`). Resume-last does not
  extend there.
- **Cursor G-sandbox and any other RFC-05 rollout item.** That work stays
  in RFC-05. This RFC adds new render paths on claude and pi (new
  `resumeLast` values plus the resume-last builder), so it changes harness
  behavior on those two; it changes no existing argv on any harness.
- **RFC-05 landing.** RFC-05 (Cursor harness, `revision: 09`, `status:
  Accepted`) MUST land first, where landing means merge to main. All cursor rows in this RFC are a conditional
  phase that compiles only against the landed cursor descriptor, and this
  RFC supersedes RFC-05's "For cursor v1, most-recent resume is not
  reachable through hcn" sentence (Resume-last section) on landing.
  RFC-05 revision 08 removed the cursor sandbox spec (no headless spelling
  confines, so cursor refuses `--sandbox` with `unsupported-option`);
  resume-last renders no sandbox flag on cursor either way, so the removal
  changes nothing in this RFC beyond the anchor.

### Fit check

1. **Who uses this?** The owner's consumers that drive hcn across harnesses
   without keeping a session index: delegation workers and one-shot chains
   that want "continue where I left off" in a directory. Today they either
   store ids per harness or re-derive each harness's most-recent spelling
   and its hazards themselves.
2. **What is hcn for?** One stable surface that normalizes four harness
   interfaces and supervises one spawned process (CONTEXT.md, ADR 0007).
3. **Does the candidate serve that purpose?** Yes. Four harnesses each do
   most-recent differently (`--continue --fork-session` on claude,
   `--continue` on two unrelated grammars, `exec resume --last` on the
   fourth, nothing headless on the fifth), and
   the flag expresses them in one vocabulary while deciding nothing: the
   harness picks the session, hcn only renders, except on claude where
   hcn chooses the fork render over the plain native `--continue`. That
   choice is supervising policy, not normalization: it decides the
   session semantics of the one process hcn spawns. The warning
   supervises the one process hcn spawned; the identity field normalizes
   how the argv was built.
4. **Which way does it move the scope?** It WIDENS scope beyond the owner's
   "one-shot plus resume" v1 decision: a new option, a new refusal member,
   and a new warning path. Widening is an owner call, and the owner made it
   on 2026-09-17. Recorded here as decided.

### AGENTS.md scope test

The flag passes test 1 (normalizes: one boolean over five different
most-recent mechanisms, deciding nothing). For test 2 the two additions
are labeled exactly: the fixed pre-spawn warning and the claude fork
render are supervising policy (the fork render chooses `--fork-session`
over the plain native `--continue`, deciding the session semantics of
the one spawned process; the implementation adds both to the CONTEXT.md
"What hcn supervises" list), and the identity `resumeLast` field is
normalization (it reports how the argv was built, like authority). A static message alone does not count as
supervision; the CONTEXT.md entry is what makes the claim checkable. The
RFC stores nothing across process boundaries: resolution stays inside the
harness, and hcn emits no index relating two invocations. The draft-02
RFC-05 record ("adding a resume-last option is out of scope and needs its
own fit check") is SUPERSEDED by this RFC, which contains that fit check.

### Revision record (draft-02 answers review draft-01-opus)

Draft-02 answers
`docs/rfc/06_hcn-resume-last-across-harnesses.review-draft-01-opus.md`,
grounded in `evidence.md` (21 new probes, names 10 and up, with a
probe-safety record) and direct re-reads of the cited hcn source. One line
per finding:

1. B1 applied: "Data sensitivity" rewritten; only tools-off scrubbed-env
   captures may become fixtures; the deleted secret-bearing pi scope
   capture is named and its conclusion superseded by probe 20.
2. B2 applied: the resume-last argv reuses `turnTail` ordering; every
   grammar row now shows that exact order; probes 10-15 pin it (plus 12b
   proving prompt-after-tools is invalid on claude).
3. H1 applied: resume-last is a resume-semantics turn (no defaults profile,
   `resumeRender` refusals apply, env phase `resume`) routed through
   `buildSpawnArgv`/`planTurn` with a discriminant covering resume-by-id
   and resume-last; all five `resume === undefined` sites named.
4. H2 applied: one pre-spawn warning text with no id, per-harness variants
   pinned verbatim (silent-create vs cursor error).
5. H3 applied: `resumeLast` gains `headless: boolean`; refusal and
   `spellingOf` key on it; consumer test updates named.
6. H4 applied: RFC-05 must land first; cursor rows moved to a conditional
   phase; the RFC-05 "not reachable" sentence superseded; the "changes no
   existing harness behavior" claim corrected.
7. H5 applied: parent-session hazard in item 1 and blast radius;
   "cwd-scoped" reworded to exact spawn cwd per the subdirectory probes;
   the policy goes to the owner as a recommended question (warn).
8. M1 applied: probed versions stated; new facts cite "observed on
   <version>, 2026-09-17" in descriptor comments; `verifiedAgainst` stays;
   fixture destination named subject to B1.
9. M2 applied: every missing consumer named and placed in the plan
   (hints, help, inspect, native-approvals/settings, identity emit sites,
   events/render, README, stale doc comments, CONTEXT.md, interactive,
   session refusal option).
10. M3 applied: claude stream-json with `--continue` observed (12e);
    codex `-c sandbox_mode` on `--last` accepted and applies (11/11b);
    Open Questions 1 and 4 retired into normative text.
11. M4 applied: cursor no-session shape re-probed with the full stream argv
    (15): exit 1, `No previous chats found.`, empty stdout.
12. M5 applied: premise restated per harness with the spawn-clock rule and
    its limits; strict continue on codex/pi offered as an open question
    with a recommendation against v1.
13. L1 applied: `isResumeLast` covers long flags only (`-c` aliases do not
    parse); the `rankResumeLast` consumer claim corrected.
14. L2 applied: scope conclusions rest on announced ids, not reply text
    (probe 20's fresh id 01a0ad05-2677).
15. L3 applied: warning labeled supervising policy, identity field labeled
    normalization.

### Revision record (draft-03 answers review draft-02-opus)

Draft-03 answers
`docs/rfc/06_hcn-resume-last-across-harnesses.review-draft-02-opus.md`,
grounded in `evidence.md` (21 new probes, names 30-50, under the same
scrubbed-env safety record plus claude `--setting-sources project`) and
direct re-reads of the cited hcn source. One line per finding:

1. H1 applied: probe 12 recorded as an observed silent create with prior
    sessions present; the trigger isolated by new probes (a SIGTERM-killed
    mid-turn reproduces it on claude 33-34 and codex 39-40; an invalid
    `--model` poisons nothing on any harness, 31-32/41-44; pi resumes the
    healthy session after a kill, 35-37). Table rows and warning widened to
    "when no session is resumable, including after a killed or crashed
    turn"; the residual mechanism stays unverified; Open Question 5 asks the
    owner whether the trigger clause stays in the pinned warning.
2. H2 applied: both meanings of cursor's error stated on the cursor rows;
    a resolved-root diagnostic line added beside the warning; Alternative 6
    plus Open Question 6 carry the pre-spawn per-cwd store-directory check
    (claude, pi, cursor; codex has no cwd slug so no check there),
    recommended as warn with reasons. Wrong-but-empty roots observed to
    error on auth (claude 45, pi 46), not to silent-create.
3. H3 applied: the pinned warning text carries the parent-session clause;
    the hazard is now probed live (claude 47-48: child re-entered the
    running parent under its id, one transcript file for two writers) and
    the two-writers consequence is in the blast radius.
4. M1 applied: ws-pi-b store state recorded (the slug dir holds only probe
    20's own file; no `01a0acef` file anywhere in the pi store); probe 20
    relabeled as a no-session probe (tools-off re-run of 03).
5. M2 applied: each grammar row shows the before-prompt option segment in
    builder order; probe 49 proves `-c sandbox_mode=read-only` blocks a
    write in that order; probe 50 captures the `-s read-only` exit-2
    rejection.
6. M3 applied: Phase 1 sets cursor `headless: false` (parse-only, like
    muse); Phase 5 flips it to `true` with the corpus rows.
7. M4 applied: the no-session table and Security state that a silently
    created session runs with native defaults, not the profile, citing
    probe 17b and the draft-03 codex repeat (probe 40, "otter" reply);
    Open Question 7 asks the owner whether to accept this or apply the
    profile when the announced id is fresh (codex/pi only), with a
    recommendation.
8. L1 applied: `TurnRunOptions` gains the field alongside
    `SpawnArgvOptions`; the native-approvals refusal sits in `planTurn`
    (which dispatches `nativeApprovalPlan` before any argv is built);
    `planTurn` is named as the muse refusal raise site; a generic
    `extraFlags` order rule covers new harnesses.
9. L2 applied: `<cwd>` is the realpath of the spawn cwd (`effective.cwd`
    when set, else the inherited process cwd).
10. L3 applied: the fixture rule requires project setting sources only
    (draft-03 claude probes carry zero `hook_response` records) or hook
    records excluded.
11. L4 applied: `--context --fork-session` with `--resume-last` renders
    through the resume-phase rules like every other turn option, covered
    by the Resolved Question 1 release gate (probe it or refuse it before
    release).
12. L5 applied: the normative evidence lands at
    `docs/research/2026-09-17-resume-last-evidence.md` plus
    path-normalized fixtures under `test/fixtures/`, filed with the
    implementation under the B1 rules (not created by this RFC); probe 50
    fills the `-s` rejection capture gap.
13. Open Questions assessment applied: OQ1-OQ4 move to Resolved questions
    per the owner answers of 2026-09-17 (OQ1 as option (c) with the
    per-harness option list and a pre-release probe gate; OQ3 warn with
    the clause now pinned); the three missing questions the assessment
    names become Open Questions 5-7.

### Revision record (draft-04 answers review draft-03-opus)

Draft-04 answers
`docs/rfc/06_hcn-resume-last-across-harnesses.review-draft-03-opus.md`,
grounded in `evidence.md` (8 new probes, names 60-67, under the same
scrubbed-env safety record plus a draft-04 appendix with a store-retention
listing, a deletion record, and a B1 correction note) and direct re-reads
of the cited hcn source. One line per finding:

1. B1 applied: the killed-turn "silent create" is withdrawn as a misread.
   Probe 34 resumed probe 33's own victim session 6b879754 (birth equals
   probe-33 start), probe 40 resumed probe 39's own thread 01a0ad12
   (UUIDv7 time matches), probe 12 resumed the bisecting run 67fb70ea
   (birth predates probe 12); the old "TRIGGER REPRODUCED" evidence lines
   are superseded by a correction note. Table rows restored to "no session
   in the exact cwd: fresh", a stranger row added (resumed with exit 0 on
   claude and codex; pi skips the killed session), warning clause and
   signal meaning rewritten per owner answer 5a, and "silent create after
   a killed turn" dropped everywhere including the Abstract.
2. H1 applied: Resolved question 3 rewritten to option (b). Claude renders
   `--continue --fork-session` (probes 60-63 in builder order: new fork id
   announced, history recalled, planted file mtime unchanged; overlap
   repeat: child id differs from the running parent id, parent file
   untouched, no two-writers case). Descriptor gains a data `forkFlag`
   field (no harness-name branch); identity announces the fork id; blast
   radius and release gate updated; codex, pi, and cursor keep the
   parent-session warning clause. No new Open Question: the flag pair is
   accepted and the parent file stays clean.
3. M1 applied: claude and pi roots resolve the way `transcript.ts` does
   (`CLAUDE_CONFIG_DIR` plus `projects`; `PI_CODING_AGENT_DIR` plus
   `sessions` and the slug), in both the diagnostic line and the
   Alternative 6 check.
4. M2 applied: probes 64-65 discriminate (workspace-write launch, then a
   read-only resume override in the before-prompt slot blocks a write on
   the same thread), so enforcement holds, not just acceptance.
5. M3 applied: `SessionStart:startup` hook sources named (user
   `~/.claude/settings.json` plus managed settings; counts only, gated by
   widening `--setting-sources` from project-only to all). `--bare` is not
   a hook switch headless (exit 1 `Not logged in`: it skips keychain
   reads). Fixture rule is now "hook records excluded" for every claude
   stream-json capture.
6. L1 applied: the identity-before-auth-failure path (probes 45-46
   announce an id, then fail auth) added to the State Machine and the
   Native failures table.
7. L2 applied: the RFC states the draft-03 stores were cleaned at
   09:00:39 on 2026-09-17; the draft-04 appendix lists every touched store
   directory (names and birth times) before deletion and records the
   deletion time and ids.
8. L3 applied: the draft-02 safety record deletes only the
   `out/05-pi-scope.stdout` capture, no store file; the missing probe-05
   pi file stays mechanism unverified, stated plainly.
9. L4 applied: RFC-05 anchor is revision 09, Accepted; `descriptor.ts`
   `resumeLast` cited at line 538; Phase 5 carries the observed-on comment
   rule against the landed cursor `verifiedAgainst`.
10. Open Questions assessment applied: OQ5-OQ7 move to Resolved questions
    per the after-review owner answers of 2026-09-17 (OQ5 as option (a)
    with the restated stranger clause, OQ6 as option (a) with the stated
    limit that the check cannot catch the stranger case, OQ7 as option
    (a)); Resolved question 3 re-asked as option (b). No open questions
    remain.

### Revision record (draft-05 answers review draft-04-opus)

Draft-05 answers
`docs/rfc/06_hcn-resume-last-across-harnesses.review-draft-04-opus.md`
(verdict ready, 0 blocking/high). No live run was made for this
revision: every change below is text pinned to existing captures, and
every shape still needing a run is a named Phase 4 gate with a stop
rule. Line numbers were re-fixed against the current tree with symbol
names, since RFC-05 Phase 3 work shifted `plan-turn.ts` and
`stream-turn.ts`. One line per finding:

1. M1 applied: "designed out" replaced with "the write into the parent
   file is designed out; the child still starts from the parent's saved
   history" (Abstract, Terminology, Safety item 1, Blast radius);
   "fork chains never accumulate" dropped for "each claude resume-last
   turn adds one session file, and the next run picks the fork only if
   no other run in the cwd wrote since"; the render line is
   claude-accurate (`forked most-recent session as <id>`, source id
   reported nowhere); "interactive" dropped from the blast radius; the
   history-carryover claim rests on probe 61 alone (probe 63's PONG
   prompt carries no recall marker).
2. M2 applied: the claude no-session row is marked "observed without
   `--fork-session`; the rendered pair is unverified"; the claude
   stranger row reads "forks that run's session under a new id", citing
   probe 67; the claude no-session case with the fork pair is a Phase 4
   gate with a stop rule on the pinned warning text and the table.
3. M3 applied: `--fork-session` is held once, on the existing
   `contextInspection.forkFlag` (the only non-null copy in the tree);
   `resumeLast` gains only `{ flag, headless }`, and the resume-last
   builder reads the context-inspection flag, so no harness-name branch
   exists and no second copy is added; context inspection never appends
   its fork flag when the resume-last render already carries one, pinned
   by a new `inspect --context --resume-last` corpus row; the A-005
   comment (`claude-code.ts:46-48`) is named as rewritten in Phase 1.
4. M4 applied: Phase 4 is the gate of record (argv from
   `hcn inspect --argv` on the built binary, overlap with a running
   parent, a recall marker planted in the parent, store metadata
   retained until the review of that run); Resolved question 3 reads
   "probes 60-63 show the pair is accepted; the gate runs in Phase 4";
   the grammar table notes the probe argv carried builder-foreign flags
   and that the parent-untouched fact rests on the deleted listing.
5. L1 applied: profile gate `plan-turn.ts:300`
   (`if (extra.resume === undefined)` before `resolveEffectiveOptions`),
   native-approvals dispatch `plan-turn.ts:372-373`
   (`if (options.nativeApprovals)` into `nativeApprovalPlan`),
   env phase `plan-turn.ts:426`
   (`plan.options.resume === undefined ? "launch" : "resume"` in
   `writePlanDiagnostics`), `RefusalOption` `refusal.ts:35`, issue
   switch `refusal.ts:74`, turn-env phase `stream-turn.ts:236`,
   create-on-missing gate `stream-turn.ts:254`; Phase 5 states the
   cursor anchor is committed (`cursor.ts:705`), and landing means merge
   to main.
6. L2 applied: the fresh-session defaults claim cites probe 17b alone;
   probe 40 moved to a separate sentence about harness-side memory on a
   resumed thread.
7. L3 applied: the 64-65 enforcement inference cites the controls (probe
   11b and `test/fixtures/phase13-codex-sandbox-resume/`), and a
   no-override resume write joins the Phase 4 matrix.
8. L4 applied: `evidence.md` states probe 47 carries 4 `hook_response`
   records; the zero-record claim covers probes 30-34 only.
9. L5 applied: the claude fork render is labeled supervising policy
   beside the warning in both scope sections, and the CONTEXT.md entry
   covers it.

### Revision record (draft-06 answers review draft-05-opus, and acceptance)

Draft-06 answers
`docs/rfc/06_hcn-resume-last-across-harnesses.review-draft-05-opus.md`
(verdict ready, 0 blocking/high). No live run was made for this
revision: every change below is text pinned to existing captures, and
every shape still needing a run is a named Phase 4 gate with a stop
rule. One line per finding:

1. L1 applied: Phase 1 adds the second consumer (resume-last) to the
   `contextInspection` doc comment, and `descriptor-consumers.test.ts`
   pins that claude's resume-last render contains `--fork-session` (the
   failure message names Resolved Question 3) and that the other
   harnesses render no fork flag.
2. L2 applied: the final `context-inspection.ts:26` condition is stated
   as unchanged (`options.resume !== undefined`, because the resume-last
   builder already renders the flag); Phase 2 lists four discriminant
   sites plus this one unchanged site.
3. L3 applied: the `plan-turn.ts:341` effort-slug provenance guard
   (`extra.resume === undefined` in the effort-in-model slug block, added
   by RFC-05 Phase 3) joins the site list, noted for Phase 5 if RFC-05
   lands first.
4. L4 applied: the Abstract carries "per the deleted listing; re-probed
   in Phase 4" on the parent-file claim; the claude warning text says
   "forks", not "resumes"; the Phase 4 validator step drops the revision
   number.
5. L5 applied: Phase 4 gains one live
   `hcn inspect claude --context --resume-last` run, with a stop rule
   that a failure refuses the combination with a typed refusal.

Status moved to Accepted on 2026-09-17 by owner decision after review
draft-05, which recommended acceptance with L2 and L4 before acceptance
and L1, L3, and L5 as implementation-plan notes. All five are applied
above.

### Errata (2026-09-17, post-acceptance; status stays Accepted)

1. `resumeLast` descriptor data carries a third field, `warning`: the
   verbatim pre-spawn text of Safety item 4 with `{cwd}` placeholders,
   rendered purely by `resumeLastWarning` (no harness-name branch). The
   draft-05 M3 record says the field gains only `{ flag, headless }`;
   read it as `{ flag, headless, warning }` on the renderable arm.
2. A parse-only harness (`headless: false`, muse in v1) carries no
   `warning`: the type holds it only on the renderable arm, and muse
   omits it. The muse warning text drafted during implementation was
   never emitted (muse always refuses) and its no-session claim was
   never probed, so it was dropped rather than pinned.
3. `rankResumeLast` stays exported from
   `src/interpretation/resume-last.ts` with its `ResumeCandidate` and
   `ResumeLastVerdict` types and its unit tests, sharing the module
   with the new warning renderer. It has no production caller:
   most-recent resolution stays inside the harness, per the Scope
   section. The branch review finding that it had been deleted is
   answered by the restore, not by a removal.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

| Term | Meaning |
| --- | --- |
| Resume-last | The `--resume-last` hcn option: resume the harness's most recent session without naming an id. |
| Most-recent resolution | The harness picking which session "most recent" names. Always the harness's job, never hcn's. |
| Stranger | A session the caller did not intend: another run's session picked over a race window, a blank session silently created where the caller expected history, or the caller's own live parent session re-entered from inside it. The `resume-last.ts` header stance ("a guess resumes a stranger") names this hazard. |
| Silent create | A harness starting a fresh session with exit 0 where the caller asked to continue. Observed on claude, codex, and pi only when no session is resumable in the exact cwd (probes 03, 16b-18b, 20), all run without `--fork-session`, so the claude rendered pair (`--continue --fork-session`) with no prior session is unverified until the Phase 4 gate. Cursor errors instead. The draft-03 "killed turn triggers a silent create" reading is withdrawn: probes 33-34 and 39-40 resumed the killed run's own session (see the evidence.md B1 correction note), which is the stranger case below, not a fresh session. |
| Exact-cwd scope | Most-recent resolves within sessions filed under the exact spawn cwd: a subdirectory run does not see the repo root's session (probes 16b-19b), and sibling repositories do not cross (probes 05, 20). |
| Resume-last signal | The machine-readable mark that a turn used most-recent resolution (the `resumeLast` field on the identity event), plus the human-readable pre-spawn warning. The field means the announced id MAY be a fresh session or a stranger session, never a caller-requested one. |
| Grammar | The exact native argv shape in `turnTail` order, e.g. `codex exec resume --last --json <prompt> --model <id>`. |
| Probe | A numbered capture run in `scratchpad/resume-last/out/` (`<name>.{argv,stdout,stderr,exit}`), cited as evidence below. Probes 10 and up ran under the draft-02 probe-safety record (scrubbed env, tools off, secret-scanned); probes 30 and up add claude `--setting-sources project`; probes 60 and up add the draft-04 appendix (fork, sandbox-override, and hook probes with a store-retention listing and deletion record). `--setting-sources project` does not keep hook records out of stream-json captures (probes 47, 60-63); the fixture rule is "hook records excluded". The draft-03 stores were cleaned at 09:00:39 on 2026-09-17, so draft-03 store claims rest on the evidence.md appendix alone; the draft-04 appendix lists every store directory its probes touched (names and birth times) and records their deletion at 09:18:27. |
| Parent-session hazard | A resume-last run spawned from inside a harness session in the same cwd re-entering the caller's own live session. Probed live on claude without fork (47-48: the child resumed the running parent under its id, one transcript file for two writers). On claude the write into the parent file is designed out by `--fork-session` (probes 62-63: the child forks under a new id and never writes the parent file); the child still starts from the parent's saved history, by fork design. Codex, pi, and cursor keep the warn policy with the clause pinned in the warning text. Presence detection cannot see it: `presence.ts` names id-less `claude --continue` as invisible, and the same holds for every most-recent argv. |

## Motivation

A consumer that wants to continue a directory's latest session today shells
out per harness: `claude -p --continue`, `codex exec resume --last`,
`pi --mode json --continue`, `agent -p --continue`, with muse refusing the
concept headlessly. Each spelling carries its own hazards: three harnesses
silently create on empty, codex rejects `--sandbox` in the resume grammar
while accepting `-c sandbox_mode`, a lone codex positional is a session id
rather than a prompt, a prompt placed after a variadic tools flag is
swallowed as a tool name (probe 12b), and muse has no headless form at all.
That hazard table is exactly what the normalizer exists to own once:
without this RFC every consumer re-derives the grammar and rediscovers the
silent create with exit 0, which is the H2 failure mode the store guard and
F-23 warning exist to prevent on the id path.

## Design

### CLI surface

hcn gains `--resume-last`, a boolean turn flag. Collision check, verified
against `src/cli/args.ts`: no `--resume-last`, `--last`, or `--continue`
exists in hcn's surface, so the spelling is free.

- `--resume-last` with `--resume` or `--session-id` in one call MUST refuse
  with `mutually-exclusive-options`. This extends the one check every
  command already calls (`resumeIdOf` in `args.ts:214-225`): most-recent
  and a named id are two answers to one question.
- `hcn session --resume-last` MUST refuse with `invalid-option-value`
  carrying option `"resumeLast"`. A session holds one stable identity
  across turns; most-recent resolution per turn defeats it. Rationale and
  issue follow the RFC-05 draft position the review found sound.
- `hcn inspect <harness> --argv --resume-last` previews the resume-last
  argv through the same `planTurn`, with identical refusals: it goes
  through `buildSpawnArgv`, and `resumeIdOf` (also called from
  `inspect-native-settings.ts:15`) widens at the same site. No separate
  inspect rule exists.
- `--native-approvals` with `--resume-last` MUST refuse: the native
  approval plan binds to one exact session turn, and there is no id to
  bind. `--native-settings-fingerprint` with `--resume-last` MUST refuse
  with `invalid-option-value`: `renderVerifiedNativeSettings`
  (`native-settings-argv.ts:23-50`) requires `opts.resume` to equal the
  saved session id, which never holds without an id.
- Passthrough is orthogonal and composes as today: the tail appends after
  the rendered resume-last argv. Cursor's `prompt-joins` refusal still
  applies to non-empty tails there.
- Prompt sources compose as today (positional, `--prompt`,
  `--prompt-file`); the prompt renders in the harness's working placement
  per the grammar table below, always before the stream flags and the tool
  grants (probe 12b shows prompt-after-tools is invalid on claude).

### Descriptor data: `resumeLast` gains a renderable split; the fork flag is held once

`resumeLast` becomes `{ readonly flag: string; readonly headless: boolean }`.
The flag stays the parse key for `parse-resume.ts` (shell history carrying
`muse resume --last` still parses); `headless` decides whether a builder
may render it. The refusal and `spellingOf` key on `headless`.

`--fork-session` is held once in the descriptor, on the existing
`contextInspection.forkFlag` (`claude-code.ts:163`, typed at
`descriptor.ts:526`; the only non-null copy in the tree, every other
harness has `contextInspection: null`). Both consumers read that one
field: the resume-last builder renders `flag` plus
`h.contextInspection?.forkFlag` when present (claude only, no
harness-name branch), and context inspection never appends its fork flag
when the resume-last render already carries one (see planTurn routing).
No second `forkFlag` copy is added to `resumeLast`. Phase 1 rewrites the
A-005 comment (`claude-code.ts:46-48`, "forking is only the explicit
--fork-session flag (deliberate branching, never a default)"), since
resume-last makes fork the default on one path.

- claude `resumeLast: null` becomes `{ flag: "--continue", headless: true }`
  (observed on 2.1.274, 2026-09-17: `-c, --continue` continues the most
  recent conversation; probes 02, 12d-12f resume and recall; probes 60-63
  show `--continue --fork-session` accepted, recalling through the fork
  under a new id while the parent file stays untouched per the deleted
  appendix listing). The fork half renders from `contextInspection.forkFlag`.
- pi `resumeLast: null` becomes `{ flag: "--continue", headless: true }`
  (observed on 0.85.1, 2026-09-17: probes 02, 13 resume
  and recall; `--continue` example in `pi --help`). No fork mechanism is
  probed on pi, so none is rendered.
- codex `{ flag: "--last" }` (`codex.ts:99`) gains `headless: true`
  (re-verified on 0.154.0: probes 10, 11). No fork mechanism is probed on
  codex, so none is rendered.
- cursor `{ flag: "--continue" }` (`cursor.ts:705`) gains `headless: false`
  in Phase 1 (parse-only, like muse) and flips to `headless: true` only
  in the conditional phase after RFC-05 lands (observed on
  2026.09.15-d2fe57e, 2026-09-17: probes 04, 14 resume and recall). No
  fork mechanism is probed on cursor, so none is rendered.
- muse keeps `{ flag: "--last", headless: false }` (`muse.ts:88`)
  as parse data for `parse-resume.ts` only, never a render target, since
  no headless grammar exists.

`descriptor-consumers.test.ts` and `dimensions-coverage.test.ts` gain the
`headless` dimension (renderable set vs parse-only set) and pin that the
resume-last fork render reads the single `contextInspection.forkFlag` on
claude. The stale `descriptor.ts:536-538` comment
("The race it opens is owned by the corroboration ranking") is rewritten:
the harness owns resolution; the warning plus the identity signal bound
the race.

### Render rule and per-harness grammar table

One new builder for the resume-last shape, routed through `buildSpawnArgv`
(RFC-02 change 10: one owner, so the CLI preview and the runner spawn agree
by construction). Every row below is in `turnTail` order (`argv.ts:132-177`:
prompt, stream flags, model, autonomy, tools, with the variadic tools flag
LAST fed exactly one joined token). The Implementation Plan pins each argv
byte-for-byte in the corpus.

| Harness | Rendered argv | Evidence |
| --- | --- | --- |
| claude | `[claude, -p, --continue, --fork-session, <prompt>, --output-format stream-json, --verbose, --include-partial-messages, --model <id>, --allowedTools <grant>]` (`--fork-session` renders from the single `contextInspection.forkFlag`, always on this path) | Observed (12f): this exact order minus the fork flag resumes d39f8b8d and recalls KITE-3. (12e): same minus the grant resumes with the stream set. (12d): same with bare json. (30/32, run with `--setting-sources project`): resumes 489bd8d1 and recalls MAGPIE-2. Hook records appear on stream-json captures under `--setting-sources project` (47, 60-63), so no "zero hook records" claim rests on them. (61, with `--fork-session` in this position): exit 0, announces NEW fork id b53231f6, recalls JUNIPER-6, planted file mtime unchanged: the only probe showing history carryover through the fork, and its source was not running. (63): fork of a running parent announces a new id and, per the now-deleted appendix listing (rung 1, re-probed in Phase 4), leaves the parent file untouched; its PONG prompt carries no recall marker. Fork probes 61 and 63 also carried builder-foreign flags (`--setting-sources project`, `--allowedTools=`), which the builder does not render. (12b): prompt moved after `--allowedTools` exits 1 with no prompt reaching the turn, so the tools-LAST order is REQUIRED, never stylistic. |
| codex | `[codex, exec, resume, --last, --json, --skip-git-repo-check, -c sandbox_mode=<m>, <prompt>, --model <id>]` (explicit `--sandbox` maps to `-c sandbox_mode`, which renders in this before-prompt slot) | Observed (10): prompt-before-model resumes 01a0acec and recalls ORCHID-7. (11/11b): `-c sandbox_mode=workspace-write` after `--model` accepted AND applies (inside-cwd file lands). (49): `-c sandbox_mode=read-only` in this before-prompt slot BLOCKS a write ("read-only sandbox and approvals are disabled", workspace stays empty). (64-65, discriminating): a thread launched workspace-write that writes nothing, resumed with the read-only override in this slot on the same thread 01a0ad26, blocks the write with the same denial and lands no file: the override is ENFORCED. Controls against the resume-default alternative: probe 11b (a workspace-write override on `--last` writes) and `test/fixtures/phase13-codex-sandbox-resume/` (0.147.0, three sandbox settings on one thread); a no-override resume write joins the Phase 4 matrix. `--sandbox`/`-s` has no resume spelling: exit 2 "unexpected argument" (`--sandbox`: 10 variant, 04; `-s`: 50). |
| pi | `[pi, -p, --mode json, --continue, <prompt>, --model <id>, <tools>]` (before-prompt options such as `--thinking`/`--provider` render ahead of the prompt per the phase rule) | Observed (13): prompt-before-model with `--no-tools` resumes 01a0acec and recalls ORCHID-7. (35/37): `--continue` resumes 01a0ad11 and recalls OTTER-9 after a SIGTERM-killed turn. |
| cursor (conditional) | `[agent, -p, --continue, <prompt>, --output-format stream-json, --stream-partial-output, --model <slug>, --force]` | Observed (14): resumes d6bc3262 and recalls ORCHID-7. Residual variance: probe 14 carried `--force` before `--continue`; the pinned order puts autonomy after the model per `turnTail`. Boolean position is low-risk but the implementation re-verifies it live (Phase 4). |
| muse | no render: refuse before spawn (see Refusals) | Observed + documented: `muse exec` has no `--last`; `muse resume --last` needs a terminal (probe 04 exits 1 on the trust wall with no TTY). |

Before-prompt segment (normative): both builders emit the before-prompt
turn-option segment ahead of `turnTail` (`argv.ts:182` launch, `argv.ts:242`
resume); the only after-prompt key is the access tool-preset
(`turn-options.ts:66-72`). Each row above shows that segment in the
position the builder emits it. Generic `extraFlags` order rule for new
harnesses: flag-style resumes render `bin, extraFlags, <resume-last flag>`;
positional resumes render `bin, exec, resume, --last, extraFlags`; a new
harness follows its resume style's slot. The Resolved Question 1 release
gate probes every expressed option once per harness on the resume-last
argv in this order (49/50 are the first two such probes); an option that
fails gains a typed refusal and nothing ships untested.

Turn-option phase rule (normative): resume-last is a resume-semantics turn.
No defaults profile runs (the profile's sandbox `workspace-write`, memory
off, effort medium, and codex context window do not apply, so a silently
created session runs with native defaults, not the profile: probe 17b
(fresh thread, no resumable session in the cwd) answers "otter" from
harness-side state (probe 40 shows the same harness-side memory on a
resumed thread, not fresh-session behavior); Resolved
Question 7 accepts and documents this); `resumeRender`
refusals apply on all four harnesses (so `hcn run claude --resume-last
--isolation tool-free` refuses exactly as `--resume` does, per
`claude-code.ts:194` and `RUN_HELP` at `help.ts:110`); `buildTurnEnv` uses
phase `resume`. On `--continue` harnesses the resume grammar IS the launch
grammar plus the flag; on codex the `exec resume` grammar applies with its
`resumeRender` spellings (which is where explicit `--sandbox` maps to `-c
sandbox_mode`, verified by 11/11b and 49).

Two codex parsing facts the builder depends on (both observed): a lone
positional occupies the SESSION_ID slot and never triggers most-recent
(probe 04: `exec resume --json "hello-just-a-prompt"` exits 1 waiting on
stdin for the prompt), so the builder MUST always emit `--last`
explicitly; and the usage line reads
`codex exec resume --last --json [SESSION_ID] [PROMPT]`, confirming
`--last` plus a positional prompt is the documented shape.

### planTurn routing (H1)

`plan-turn.ts` owns the plan the runner and `inspect --argv` share, and
`buildSpawnArgv` has exactly three callers, so the builder enters through
it, never beside it. `SpawnArgvOptions` gains `resumeLast?: true`
(mutually exclusive with `resume` through the widened `resumeIdOf`
check); `buildSpawnArgv` routes it to the resume-last builder. Four places
that test `resume === undefined` today gain the discriminant (resume
semantics when `resume !== undefined OR resumeLast === true`), plus the
effort-slug provenance guard below, plus the context-inspection site
which stays unchanged:

- `src/interpretation/argv.ts:268` (`buildSpawnArgv` launch-vs-resume
  branch);
- `src/cli/plan-turn.ts:300` (defaults profile + config:
  `if (extra.resume === undefined)` before `resolveEffectiveOptions`;
  resume-last skips it, like resume);
- `src/cli/plan-turn.ts:426` (`writePlanDiagnostics` env phase:
  `plan.options.resume === undefined ? "launch" : "resume"`);
- `src/execution/stream-turn.ts:236` (`turnEnv` phase:
  `effective.resume === undefined ? "launch" : "resume"`);
- `src/cli/plan-turn.ts:341` (effort-in-model slug provenance guard:
  `if (extra.resume === undefined)`, added by RFC-05 Phase 3; gains the
  discriminant so a resume-last turn never carries launch-only provenance;
  applied in Phase 5 if RFC-05 lands first).
- `src/interpretation/context-inspection.ts:26` (fork flag, UNCHANGED:
  appends only when `options.resume !== undefined`, because the
  resume-last builder already renders the flag, so no discriminant is
  added here. `hcn inspect claude --context --resume-last`
  renders `--continue --fork-session` through the resume-phase rules like
  every other turn option, and the muse refusal covers `inspect --context`
  there too. The flag appears exactly once because the builder carries it
  and line 26 appends nothing on the resume-last path (pinned by an
  argv-corpus row for `inspect --context --resume-last`). No probe covers
  a duplicated `--fork-session`. Probes 60-63 show the
  `--continue --fork-session` pair is accepted; the Resolved Question 3
  release gate runs in Phase 4).

`streamTurn` takes `TurnRunOptions extends LaunchOptions`
(`stream-turn.ts:97`), not `SpawnArgvOptions`, so the `resumeLast?: true`
field is added there too and threaded into the plan the same way.

The muse refusal is raised in `planTurn` (the single owner `buildSpawnArgv`
is routed through): when the resolved harness's `resumeLast` is null or
`headless: false`, `planTurn` refuses with `unsupported-option` carrying
option `"resumeLast"` before any argv is built. The `--native-approvals`
refusal on the id-less path sits at the same site: `planTurn`
(`plan-turn.ts:372-373`: `if (options.nativeApprovals)` into
`nativeApprovalPlan`) dispatches `nativeApprovalPlan` before any argv is
built, so the refusal lands there, ahead of `streamTurn`'s
`stream-turn.ts:128` dispatch.

With the profile off, the probe-05 "otter" mechanism (whatever memory or
profile content answered there) cannot leak through a profile hcn itself
applies; what the harness natively loads stays the harness's behavior and
is documented, not rendered.

### Refusals

The muse refusal is typed: issue `unsupported-option`, option
`"resumeLast"`, a NEW member of the closed `RefusalOption` union in
`refusal.ts:35` (the `export type RefusalOption` declaration). The
`support.ts` `spellingOf` gains the matching arm:
return `h.resumeLast !== null && h.resumeLast.headless ?
h.resumeLast.flag : null`, so `supportedBy` derives the renderable spelling
list at runtime (claude `--continue`, codex `--last`, pi `--continue`,
plus cursor `--continue` once its descriptor lands) and muse never appears
in its own refusal. `buildRefusalMessage` needs no new arm (it switches on
issue at `refusal.ts:74` (`switch (issue)`), never on option). `hints.ts` `HINTS` gains the
muse `resumeLast` entry (ADR 0002: hints are curatorial and pinned
verbatim, with the hints-test count bump), and `help.ts` `RUN_HELP` plus
the `inspect` help gain the flag. The full refusal table lives under Error
Handling.

### Safety policy (normative)

**1. The stranger race: warn, and fork on claude.**
Most-recent resolution stays inside the harness: hcn runs no store scan,
takes no timestamp, and `rankResumeLast` gains no production caller, so
there is no hcn-side choice to be ambiguous. The race window the
`resume-last.ts` stance warns about is bounded by an observed fact: all
four harnesses scope most-recent to the exact spawn cwd (probes 16b-19b: a
subdirectory run does not see the repo root's session; probe 05: a
sibling-repository run minted a fresh pi session without touching the
first workspace's session), so only same-cwd runs can pick each
other's sessions. Two residual risks are accepted and documented, not
refused. First, concurrent same-cwd runs can pick each other's sessions:
no condition hcn can check pre-spawn distinguishes "the caller's session"
from "another run's session" without an id, and inventing one would be the
guess the stance forbids. The observed shape on claude and codex is a
resume of that other run's own session with exit 0 (33-34, 39-40, 12),
never a blank session; pi skips a killed session and resumes the older
healthy one (35-37). Second, the parent-session hazard: the RFC names
delegation workers as users, and a worker spawned from inside a harness
session in the same cwd re-enters the caller's own live parent session.
This is probed, not hypothetical: claude probe 48 ran `--continue` while
parent probe 47 was still running and resumed the live parent session
c7e8ad6b with exit 0, and the store held one transcript file for that id
across the overlapping runs (two writers, one file; see Blast radius).
Presence cannot gate this: `presence.ts` already names id-less
`claude --continue` as invisible, and every most-recent argv is id-less
the same way. The policy is resolved (Resolved Question 3: option (b)):
on claude the resume-last builder always renders `--fork-session` (read
from the single `contextInspection.forkFlag`; see Descriptor data), so
the child starts from the most recent session's saved history under a
NEW id and never writes the parent file. Probes 60-63 show the pair is
accepted; the gate runs in Phase 4. The write into the parent file is
designed out; the history inheritance is not: the child still receives
the parent's saved context. Each claude resume-last turn adds one
session file, and the next `--resume-last` picks the fork only if no
other run in the cwd wrote since (a live parent writing on return
re-points most-recent at the parent, which is the stranger race, not a
fork property). Codex, pi, and cursor have no probed fork mechanism
and keep the warn policy with the clause pinned in the item-4 text.
Callers that need strict continuation MUST store ids and use
`--resume`. Every resume-last turn emits the warning in item 4.

**2. No prior session: the per-harness table, not `resume.onMissing`.**
`resume.onMissing` describes the id grammar (`--resume <id>`), not the
most-recent grammar, and MUST NOT be consulted on this path: claude's
`onMissing` is `"error"` yet `claude --continue` with no prior session
silently starts a fresh session. The behavior is:

| Harness | `--resume-last` with no session resumable in exact cwd | Evidence |
| --- | --- | --- |
| claude | exit 0, fresh `session_id`, full inference run, no marker; observed without `--fork-session`, so the rendered pair with no prior session is unverified until the Phase 4 gate | Observed (03, plus 16b in a subdirectory), both without the fork flag |
| codex | exit 0, fresh `thread_id`, full inference run, no marker | Observed (03, plus 17b in a subdirectory) |
| pi | exit 0, fresh session id, full inference run, no marker | Observed (03, plus 18b in a subdirectory, plus the tools-off no-session re-run 20) |
| cursor | exit 1, stderr `No previous chats found.`, empty stdout. Two meanings: no prior session in the exact cwd, OR the store root resolved away from the session (without `XDG_CONFIG_HOME` cursor reads `{home}/.cursor/chats/` and reports this for a cwd that has a session) | Observed (02 without stream flags; 15 WITH the full stream set, stdout 0 bytes; 19b in a subdirectory; 14 attempt for the store-root meaning) |
| muse | refused before spawn (no grammar) | Observed + documented |

| Harness | `--resume-last` when the most recent session is a killed, failed, or unrelated run's session | Evidence |
| --- | --- | --- |
| claude | exit 0, forks that run's session under a new id with its history, no marker of the source | Observed without the fork flag (33-34: resumes the killed victim 6b879754; 12: resumes the bisecting run 67fb70ea); the one fork-stranger observation is probe 67 (source 8a287624, a failed auth run, new id f1d1b62e, no recall, nothing in the stream naming the source) |
| codex | exit 0, resumes that run's own thread with its history, no marker | Observed (39-40: resumes the killed victim thread 01a0ad12) |
| pi | exit 0, SKIPS the killed session and resumes the older healthy session | Observed (35-37: resumes plant 01a0ad11 after the kill) |
| cursor | unprobed for this case | Unverified; the no-session error above is the only observed shape |

A silently created session on claude, codex, or pi runs with native
defaults, not the hcn profile (the profile never runs on a resume-semantics
turn): probe 17b (fresh codex thread) answers "otter" from harness-side
state. Probe 40 shows the same harness-side memory on a resumed thread
(it resumed probe 39's own thread 01a0ad12, so it is not fresh-session
evidence). Resolved Question 7 accepts and documents this.

hcn MUST NOT present a fresh session as a resumed one on this path; the
signal in item 3 is what lets a consumer tell.

**3. The signal: one field plus one warning.**
The identity event (`events.ts:47`) gains an additive optional field,
`resumeLast: true`, set when the turn rendered through the resume-last
builder, absent otherwise. It means: "this id was picked by the harness as
most-recent in the spawn cwd, not requested by the caller; it MAY be a
fresh session or a stranger session (a killed, failed, or unrelated run's
session)." On claude the announced id is the fork id, not the resumed id.
Authority follows the existing `requestedId` rule unchanged
(`decode.ts:150`): requestedId is null on this path, so authority stays
`harness-minted`. The flag reaches decode state through the plan: the
discriminant in `planTurn` (H1) feeds `freshDecodeState` (or its
successor) alongside the null requested id, covering the first announce
and the model-attestation re-emit (`decode.ts:127-139`) and the third emit
site (`native-approval-turn.ts:336`; reached only when native approvals
are allowed, which they are not on this path, so the arm is for
completeness). Consumers: the CLI renderer (`src/cli/render.ts`) prints
`resumed most-recent <id> (exact-cwd scope)` from the field on codex, pi,
and cursor, and `forked most-recent session as <id> (exact-cwd scope)` on
claude, where the announced id is the fork id. The field never carries
the source id on claude (probe 67 names no source), so a consumer cannot
tell which session was forked. JSON consumers branch on the field, never
on prose. No existing field fits: authority
cannot distinguish (both cases are harness-minted) and message text is
prose ADR 0002 forbids branching on. README updates: the event contract
(~line 670, additive kinds note covers the field; the contract test must
tolerate it) and the identity text (~lines 122, 241).

**4. Guard and warning behavior with no id.**
The `stream-turn.ts:254` create-on-missing warning gate
(`effective.resume !== undefined && h.resume.onMissing === "create"`)
never fires on this path, since there is no id. The gate MUST extend to
the resume-last path with ONE fixed pre-spawn text carrying no id (the
resumed id is known only at the first stream announce, after the F-23
push point at `stream-turn.ts:251-256`). `<cwd>` is the realpath of the spawn cwd: the plan's `effective.cwd`
when set, else the process cwd the runner inherits (the harnesses slug the
physical path: the claude project directory carries the `-private-tmp-`
prefix, and `resume-guard.ts:22-28` resolves realpath for the same reason).
The text varies per harness:

- claude: `hcn: --resume-last forks the most-recent claude session in
  <cwd> under a new fork id; the most recent session may be a killed,
  failed, or unrelated run's session; claude starts a fresh session with
  exit 0 when no session is resumable in <cwd>` (the no-session clause is
  pinned on the rendered pair but unverified with the fork flag until the
  Phase 4 gate; if that gate shows a different shape, this text and the
  no-session table change before release)
- codex, pi: `hcn: --resume-last resumes the most-recent <harness>
  session in <cwd>; the most recent session may be a killed, failed, or
  unrelated run's session; <harness> starts a fresh session with exit 0
  when no session is resumable in <cwd>; a run from inside a live
  <harness> session in the same directory re-enters that session`
- cursor: `hcn: --resume-last resumes the most-recent cursor session in
  <cwd>; the most recent session may be a killed, failed, or unrelated
  run's session; cursor errors with exit 1 when no session is resumable,
  and the same error means the store root resolved away from the session;
  a run from inside a live cursor session in the same directory re-enters
  that session`

Beside the warning, the runner emits a diagnostic line naming the resolved
store root for the scope: `hcn: --resume-last store root <root> for scope
<cwd>`. Roots resolve the way `transcript.ts:76-91` does: claude
`resolve(CLAUDE_CONFIG_DIR ?? home/.claude, "projects")`, pi
`resolve(PI_CODING_AGENT_DIR ?? home/.pi/agent, "sessions", slug)` with
the same slug, cursor the first set `rootEnv` entry else `defaultRoot`
per RFC-05, codex `resolve(CODEX_HOME ?? home/.codex)` (no cwd slug, so
no per-cwd check there). The line is data for the caller, not a branch
point. Where a per-cwd directory check exists (claude, pi, cursor) and
the directory is absent, the runner warns (it does not refuse: the absent
case is also the legitimate first run in a new cwd) per Resolved Question
6. The check cannot catch the stranger case: the directory exists and
holds the wrong session there.

The runner yields the warning (`error` kind) before any harness output on
every resume-last turn, including cursor turns that then fail natively
(the consumer sees the policy text either way). The `run.ts:40-57` and
`session.ts:207-225` store checks cannot run (there is no id to look up);
that absence is stated here, not worked around: the warning plus the
identity field are the guards on this path. Cursor's native
`No previous chats found.` error passes through as a native failure
(verbatim stderr, exit 1); it stays a native failure rather than a refusal
because the Resolved Question 6 check only warns when the per-cwd
directory is absent and cannot separate true-empty from wrong root when it
is present. The CONTEXT.md "What hcn supervises" list gains this standing
warning policy plus the claude fork render (both are supervising policy;
the implementation updates the list and the "Six parts" wording that
follows from it).

### `parse-resume.ts` and `rankResumeLast`

`parse-resume.ts` needs no logic change: it already recognizes the new
claude/pi `--continue` long flags through the flag-style branch of
`isResumeLast` (`parse-resume.ts:79-91`), and already refuses a lone codex
positional (no `--last` present means no resume-last parse; no id-shaped
token means no id parse). Two corrections ride along: `isResumeLast`
matches the long flag only, so shell history with `claude -c` or `pi -c`
does NOT parse (aliases live on `resume.aliases`, which `resumeLast` does
not read); and the `parse-resume.ts:24-25` comment ("corroboration ranking
(rankResumeLast) decides what it names") is rewritten, since the harness
decides and `rankResumeLast` has no production caller. New corpus tests
pin: `claude -p --continue` parses as resume-last; `claude -p -c` does
not; `codex exec resume --last "prompt"` parses as resume-last with
autonomy detection intact; `codex exec resume "prompt"` parses as null.
`rankResumeLast` stays exported and unit-tested only.

## State Machine

One resume-last turn. Guards in brackets; terminal states in capitals.

```text
PARSE --> REFUSE (on: --resume-last with --resume/--session-id;
  mutually-exclusive-options, exit 2)
PARSE --> REFUSE (on: harness muse; unsupported-option resumeLast, exit 2)
PARSE --> REFUSE (on: hcn session with --resume-last;
  invalid-option-value with option resumeLast, exit 2)
PARSE --> REFUSE (on: --native-approvals or --native-settings-fingerprint
  with --resume-last; no id to bind, exit 2)
PARSE --> WARN (on: claude/codex/pi/cursor; the fixed pre-spawn text with
  the exact-cwd scope, the stranger clause, and the silent-create-or-error
  clause (the claude silent-create clause assumes the fork pair, which is
  unverified until the Phase 4 gate); per-cwd directory check warns only:
  absent dir is also a first run)
WARN --> SPAWN (on: resume-last render through buildSpawnArgv)
SPAWN --> NATIVE_ERROR (on: cursor exit 1 "No previous chats found.",
  either meaning: true-empty or wrong store root; verbatim stderr,
  failure class native)
SPAWN --> NATIVE_ERROR (on: claude exit 1 "Not logged in" or pi exit 1
  "No API key found" with no id announced; verbatim stderr, existing auth
  classes)
SPAWN --> IDENTITY (on: first id announce; authority harness-minted,
  identity carries resumeLast: true; the announce can precede an auth
  failure on wrong roots)
IDENTITY --> NATIVE_ERROR (on: claude "Not logged in" or pi "No API key
  found" AFTER the announce (probes 45-46); verbatim stderr, existing
  auth classes; the identity event already emitted with resumeLast: true)
IDENTITY --> RESULT (on: stream end; resumed and fresh sessions are
  indistinguishable here by harness design on claude and cursor)
RESULT --> CLEAN (on: exit 0, with or without recalled history)
```

Timeout behavior: the existing stall clock and wall-clock deadline apply
unchanged. Invalid transitions: none new; a turn that ends without an id
announce follows the existing malformed-identity path.

## Error Handling

### Refusals (exit 2, before spawn)

| Call | Issue | Notes |
| --- | --- | --- |
| `--resume-last` on muse | `unsupported-option`, option `resumeLast` | No headless most-recent grammar exists. `supported` derives from `supportedBy` (the renderable spellings only); hint names the stay-on-harness alternative (`--resume <id>` with a stored id). |
| `--resume-last` with `--resume` / `--session-id` | `mutually-exclusive-options` | Extends the `resumeIdOf` check; message names the one-of rule. |
| `--resume-last` on `hcn session` | `invalid-option-value`, option `resumeLast` | Stable-identity rationale: a session cannot re-resolve most-recent per turn. |
| `--resume-last` with `--native-approvals` or `--native-settings-fingerprint` | `invalid-option-value` | No id to bind the approval plan or to match the saved fingerprint against. |
| Any existing refusal on the same call (unknown model, tool grant, isolation on resume, passthrough on cursor) | as today | Refusals compose; resume-last adds no exemption. Resume-phase refusals (`resumeRender: null`, e.g. claude isolation) apply unchanged. |

### Native failures (after spawn, exit 1)

| Situation | Observed shape | hcn class | Notes |
| --- | --- | --- | --- |
| Cursor, no session resumable in cwd | Exit 1, stderr `No previous chats found.`, empty stdout | `native` | Verbatim stderr, exit code as data; holds WITH the stream-json set (probe 15). Two meanings (true-empty vs wrong store root); the Resolved Question 6 check only warns on an absent per-cwd directory, so hcn cannot tell pre-spawn when it is present, and this is not a refusal. |
| Claude/pi, store root resolving to an empty dir | Exit 1 auth errors (`Not logged in`, `No API key found`), no silent create | existing auth classes | Observed (45, 46): a wrong-but-empty root errors, it does not fall into the silent-create path. The id is announced BEFORE the auth error (claude result carries fb1e4df0, pi header carries 01a0ad13), so hcn emits `identity` with `resumeLast: true` for a session that then fails: the state machine paths this as IDENTITY then NATIVE_ERROR. Silent create under a wrong root WITH auth present stays unverified. |
| Cursor trust gate on a fresh dir | Exit 1, `Workspace Trust Required` | `trust-refused` once RFC-05 lands, else current handling | Unchanged paths; note the observed ordering: the no-session check fires before the trust gate on `--continue`. |
| Silent fresh session (claude/codex/pi, no prior session) | Exit 0, fresh id, normal stream | NOT a failure | `done` cause `clean` with the warning and `resumeLast: true` attached. The consumer decides. |

Error code ranges: no new numeric codes. Retry policy: no change; the
`retryable` derivation runs on the failure class as today. A silent fresh
session is `clean`, so nothing retries it: retrying "continue" would only
re-enter the same fresh session.

### Escalation

The escalation preamble and `hcn-question` detection apply unchanged on
resume-last turns. A resumed session that ends by asking exits 0 with
`awaiting-input` like any other turn.

## Security Considerations

**Trust boundaries are unchanged.** hcn trusts its descriptors and the
caller's boolean flag; harness stdout stays the least trusted input (the
announced id is shape-checked before it becomes a path segment, as
today). This RFC adds no new input: `--resume-last` carries no value.

**Input validation moves with its rule and MUST NOT weaken.** The
session-id shape check, the `CLEAN_SELECTOR` model grammar, and the
`--resume`/`--session-id` mutual-exclusion check each keep one owner; the
exclusion check widens to cover `--resume-last` at its existing site.

**Permissions model.** No change: autonomy still renders per harness
(`--force` on cursor was required even to probe; the flag composes with
`--continue` as observed). Resume-last grants no access beyond what the
same turn without it would have. The defaults profile does NOT run on this
path (H1), so no profile opinion leaks into a continued conversation; by
the same rule a silently created session runs with native defaults, not
the profile (probe 17b; probe 40 shows harness-side memory on a resumed
thread, not fresh-session behavior). Resolved Question 7 accepts and
documents this: a truly fresh session runs native defaults.

**Blast radius.** The worst case is resuming the wrong session: another
run's session over a same-cwd race (bounded by observed exact-cwd scope;
on claude and codex the observed shape is a resume of that run's own
session with its history, on pi a skip to the older healthy session), or
a blank session mistaken for history (bounded by the warning plus the
`resumeLast` field). On claude the write into the parent file is designed
out, not the hazard: probes 47-48 show the no-fork child appending to the
live parent's transcript under the parent id (two writers, one file,
delegate turn in the parent history), while probes 61-63 show the fork
child running under a new id (history carryover shown by probe 61 alone,
whose source was not running) with the parent file untouched per the
now-deleted appendix listing (rung 1, re-probed in Phase 4). Each claude
resume-last turn adds one session file, and the next run picks the fork
only if nothing else in the cwd wrote since. On codex, pi, and cursor
the warn policy holds (Resolved Question 3) with the clause pinned in the
warning. hcn holds no credentials and writes no
store; each harness authenticates under the user's own session. A wrong
argv is the same blast radius as any argv bug: one failed process hcn
spawned.

**Data sensitivity.** Only captures taken under the draft-02 safety rule
plus the draft-04 hook rule may become fixtures: scrubbed environment
(`env -i` with `HOME`, `PATH`, `TERM` plus only the named auth/store
locators), tools off (claude `--allowedTools=""`, pi `--no-tools`, codex
`-c sandbox_mode=read-only`, cursor tool-forbidding prompt), stdin closed,
project setting sources (claude `--setting-sources project`, which keeps
auth working) with hook records excluded on every claude stream-json
capture, secret-scanned before filing. `--setting-sources project` does
NOT keep hook output out: `SessionStart:startup` records still appear
(probes 47, 60-63), loaded from user `~/.claude/settings.json` and
managed settings, which that flag does not gate (probe 67 raises the
count from 3-4 to 6-6 when user sources load; counts only, content never
read). `--bare` is not a substitute: it exits 1 `Not logged in` headless
(probe 66) because it skips keychain reads.
The old pi scope capture (`out/05-pi-scope.stdout`) was secret-bearing
(tool results holding environment entries and `user.email`) and is
DELETED; its scope conclusion is superseded by the tools-off re-run
(probe 20, fresh id 01a0ad05-2677, zero tool calls). The remaining
`05-pi-scope.{argv,exit,stderr}` files carry no account material and stay as deletion
witnesses, never as fixtures. Fixtures keep run-specific UUIDs and
absolute scratch paths only after path normalization. The claude
no-session capture lists account connector names (Gmail, Google Calendar,
Google Drive, reviewsion): connector NAMES are not credentials but they
are account material, so that capture MUST NOT become a fixture either;
the no-session table rests on exit codes and fresh ids, which carry no
such material.

**Injection resistance.** No new model-facing text is added. The warning
and the render lines (`resumed most-recent <id>`; `forked most-recent
session as <id>` on claude) are hcn-to-caller text, never prompt
content.

## Alternatives Considered

1. **hcn-side most-recent resolution (store scan plus `rankResumeLast` as
   a production caller).** Considered because the ranking already exists
   and is unit-tested. Rejected: every supporting harness resolves
   most-recent natively and scopes it to the exact spawn cwd, so hcn's own
   scan duplicates a capability instead of forwarding it; store layouts
   differ per harness and the race remains either way.
2. **Restoring the draft-02 stance (no resume-last option at all).**
   Considered because the `resume-last.ts` stranger stance is real.
   Rejected: the owner decided on 2026-09-17 to add the option, and the
   safety policy above answers the stance with bounds (exact-cwd scope),
   warning, and signal rather than silence.
3. **Silent accept: render the flags with no warning and no signal.**
   Considered as the smallest diff. Rejected: H2 shows three harnesses
   return exit 0 on a fresh session, so silence presents a blank session
   as history with no recourse.
4. **A rich `resumeLast` shape (per-phase render tables, a
   `resumeLastRender` per option).** Considered for the codex `--sandbox`
   divergence. Rejected: the single flag plus the style-keyed phase rule
   already renders every observed grammar correctly, including codex's
   `resumeRender` path (`-c sandbox_mode`, probes 11/11b). Per-option
   carve-outs wait for observed rejects (Resolved Question 1).
5. **Refusing when nothing is resumable (strict continue).** Considered
   because silent create is the sharpest hazard. Rejected for v1: only
   codex and pi expose a fresh-vs-resumed marker (Resolved Question 4), so
   uniform strictness is impossible without the rejected hcn-side scan,
   and per-harness strictness splits the contract.
6. **A pre-spawn per-cwd store-directory existence check.** Considered
   because cursor's error has two meanings and a wrong root is otherwise
   invisible until after spawn. ADOPTED per Resolved Question 6 (warn):
   the check reads no session and ranks nothing. Roots resolve the way
   `transcript.ts:76-91` does: claude
   `resolve(CLAUDE_CONFIG_DIR ?? home/.claude, "projects")` plus
   `{cwdSlug}` (`dash-separators`, realpath), pi
   `resolve(PI_CODING_AGENT_DIR ?? home/.pi/agent, "sessions")` plus the
   slug, cursor `{root}/chats/{md5(cwd)}` (`md5-hex` over the realpath
   bytes, root from `rootEnv`/`defaultRoot` per RFC-05); codex's template
   (`resolve(CODEX_HOME ?? home/.codex)`) carries no cwd slug, so no check
   exists there. When the directory is absent the turn warns: the absent
   case is also the legitimate first run in a new cwd, so refusing would
   forbid the intended v1 silent create on claude/codex/pi. Stated limit:
   the check cannot catch the stranger case, where the directory exists
   and holds the wrong session.

## Implementation Plan

TDD implementation, then one `feat:` release. Each phase keeps
`pnpm check` (lint, typecheck, both test lanes) green. The parallel work
(RFC-05 revision plus code) shares no file with this plan except the
closed vocabularies it extends additively; coordinate only on
`RefusalOption`.

**Phase 1 - knowledge.** claude (`claude-code.ts:165`) and pi (`pi.ts:122`)
gain `resumeLast: { flag: "--continue", headless: true }` with descriptor
comments citing "observed on 2.1.274 / 0.85.1, 2026-09-17";
`verifiedAgainst` does NOT move (a bump needs `smoke:seven` plus
`smoke:questions` per the AGENTS.md convention, which Phase 4 is not).
`descriptor.ts` gains the `headless` field on `resumeLast`
(`descriptor.ts:538`); the stale race comment there is rewritten. No
`forkFlag` is added to `resumeLast`: the fork fact stays held once on
`contextInspection.forkFlag` (`claude-code.ts:163`). The A-005 comment
(`claude-code.ts:46-48`) is rewritten here, since resume-last makes fork
the default on one path. Cursor (`cursor.ts:705`) gains `headless: false`
here (parse-only, like muse) so typecheck passes without rendering
cursor; Phase 5 flips it. Phase 1 also adds the second consumer
(resume-last) to the `contextInspection` doc comment in `descriptor.ts`.
Tests pin the five descriptor values (three renderable, muse parse-only,
cursor parse-only pending Phase 5), the `headless` dimension, and that
the resume-last fork render reads the single `contextInspection.forkFlag`
in `descriptor-consumers.test.ts` and `dimensions-coverage.test.ts`.
`descriptor-consumers.test.ts` pins that claude's resume-last render
contains `--fork-session` (failure message names Resolved Question 3)
and that the other harnesses render no fork flag.

**Phase 2 - interpretation.** The `resumeLast?: true` discriminant on
`SpawnArgvOptions` and on `TurnRunOptions` (which `streamTurn` takes
instead); the resume-last builder routed through `buildSpawnArgv`,
rendering `flag` plus `h.contextInspection?.forkFlag` when present
(claude only) with no harness-name branch; context inspection left
unchanged at `context-inspection.ts:26` (appends only when
`options.resume !== undefined`); the
four `resume === undefined` sites gaining the discriminant plus this one
unchanged site (plus the effort-slug provenance guard at
`plan-turn.ts:341`, applied in Phase 5 if RFC-05 lands first);
`RefusalOption` gains `"resumeLast"`; `spellingOf` gains the
`headless`-keyed arm; `resumeIdOf` widens to the mutual exclusion;
`hints.ts` gains the muse entry (with the hints-test count bump);
`help.ts` (`RUN_HELP` and inspect help) gains the flag; argv-corpus rows
pin the observed grammars byte-for-byte in `turnTail` order with the
before-prompt segment in builder order (including the codex
`--sandbox`/`-s` negatives, the claude prompt-after-tools negative, and
an `inspect claude --context --resume-last` row pinning exactly one
`--fork-session`);
`parse-resume` gains corpus tests with no logic change (long `--continue`
parses, `-c` does not, codex `--last` with positional prompt parses, lone
positional is null) plus the comment correction.

**Phase 3 - execution and CLI.** `--resume-last` plumbing in `args.ts`
(`KNOWN_FLAGS`, parse table, prompt-source composition); the
`stream-turn.ts` warning gate extends to the resume-last path with the
pinned per-harness verbatim text plus the resolved-root diagnostic line
(roots resolved per `transcript.ts:76-91`) and the absent-directory warn
check from Resolved Question 6 (claude, pi, cursor; codex has no cwd
slug); the identity
event gains optional `resumeLast: true` with the plan-to-decode threading
(`freshDecodeState` successor) and the `src/cli/render.ts` line;
`hcn session` refuses with option `resumeLast`; `planTurn` raises the muse
`unsupported-option` refusal and the `--native-approvals` and
`--native-settings-fingerprint` refusals on the id-less path;
`run.ts` documents the skipped store check (no code: nothing to check
without an id); README event contract and identity text updated (contract
test tolerates the additive field); CONTEXT.md "What hcn supervises" gains
the warning policy plus the claude fork render (both supervising policy),
with the "Six parts" wording following from it.

**Phase 4 - verification and rollout.** Re-run the probe matrix live
(recall, no-session, subdirectory-scope, stranger-case per harness,
including the cursor `--force`-position re-verify) against the built
binary, and probe every expressed turn option once per harness on the
resume-last argv (the Resolved Question 1 release gate: an option that
fails gains a typed refusal, nothing ships untested; probes 49-50 and
64-65 are the first such probes), plus a no-override resume write on the
same codex thread (the L3 control: if the write is blocked without the
override, the 64-65 enforcement inference is restated before release),
plus the claude `--continue --fork-session` pair in builder order with
the argv taken from `hcn inspect --argv` on the built binary (not
hand-built: probes 61 and 63 carried builder-foreign `--setting-sources
project` and `--allowedTools=`), overlapping a running parent that holds
a planted recall marker (the Resolved Question 3 gate of record: if the
pair is rejected, shows no recall, or writes the parent file, stop and
re-open the parent-session question instead of shipping; per-file mtime,
size, and the set of ids are retained until the review of that run),
plus the claude no-session case with the fork pair in an empty cwd (if
the shape differs from exit 0 with a fresh id, the pinned claude warning
text and the no-session table change before release), plus one live
`hcn inspect claude --context --resume-last` run on the built binary (if
it fails, refuse the combination with a typed refusal instead of
shipping); file passing
captures as fixtures under `test/fixtures/<harness>-<version>/` ONLY when
taken under the B1 safety rule plus the hook rule (scrubbed env, tools
off, project setting sources with hook records excluded, secret-scanned);
file the normative evidence at
`docs/research/2026-09-17-resume-last-evidence.md` with the
path-normalized fixtures; both test lanes green; validator passes with
status Accepted. Per the AGENTS.md convention, audit the
hcn skill against the new flag before calling the work complete (separate
implementation-time step, not this RFC).

**Phase 5 - conditional cursor (after RFC-05 lands).** The cursor
descriptor flips to `headless: true`, and its corpus rows, its
refusal-table entries, and the `trust-refused` ordering note land only
against the landed RFC-05 descriptor, with descriptor comments citing the
observed version against the landed cursor `verifiedAgainst`
(`2026.09.10-fd3934a` committed at `cursor.ts:705`; the RFC's cursor probes ran on
`2026.09.15-d2fe57e`). Landing means merge to main: the parse-only
`headless: false` rows already depend on the committed `cursor.ts`, while
this flip compiles only against the merged cursor descriptor. This phase records the supersession
of RFC-05's "most-recent resume is not reachable through hcn" sentence.

## Resolved questions (owner answers, 2026-09-17)

1. **Which turn options need carve-outs on resume-last?** Owner answer:
   option (c). Every turn option renders through the existing resume-phase
   rules (the same rules as `--resume <id>`): claude (isolation refused via
   `resumeRender: null`, effort, systemPrompt, appendSystemPrompt,
   discovery, access, memory), codex (contextWindow, effort, systemPrompt,
   sandbox via `-c sandbox_mode`, access, memory), pi (effort, provider,
   systemPrompt, appendSystemPrompt, discovery, access, memory), cursor
   (effort via model slug, model, stream flags, `--force`; `--sandbox`
   refuses, no spec per RFC-05 revision 08), plus model, stream flags, and
   tool grants where the harness accepts them. Release gate (normative):
   the implementation MUST probe each expressed option once per harness on
   the resume-last argv before release; an option that fails a probe gains
   a typed refusal; nothing ships untested. First gate probes: 49
   (`-c sandbox_mode=read-only` blocks in builder order), 50
   (`-s read-only` rejected, exit 2), and 64-65 (read-only override in
   builder order ENFORCED on a workspace-write thread).
2. **Is `resumeLast: true` on the identity event the right signal shape?**
   Owner answer: yes.
3. **What is the parent-session policy?** Owner answer after review
   draft-03 (2026-09-17): option (b). On claude the resume-last builder
   renders `--continue --fork-session` from the single
   `contextInspection.forkFlag`, so the child starts from the most recent
   session's saved history under a NEW id and never writes into the
   parent's file; the identity announces the fork id, never the source id.
   Release gate (normative): probes 60-63 show the pair is accepted; the
   gate runs in Phase 4 (argv from `hcn inspect --argv`, overlap with a
   running parent holding a planted recall marker, store metadata
   retained). If that probe shows the pair rejected, without recall, or
   writing the parent file, stop and re-open this question instead of
   shipping. Codex, pi, and cursor have
   no probed fork mechanism and keep the warn policy: their item-4 text
   names the hazard (a run from inside a live session in the same
   directory re-enters that session) and the signal marks the turn. The
   no-fork hazard stays probed live (47-48) with its two-writers
   consequence in the blast radius.
4. **Should a strict-continue opt-in follow on codex/pi?** Owner answer:
   no v1 follow-up. Callers that need strictness store ids and use
   `--resume`.
5. **Does the stranger clause stay in the pinned warning?** Owner answer
   after review draft-03 (2026-09-17): option (a). The pinned warning
   carries "the most recent session may be a killed, failed, or unrelated
   run's session". The draft-03 "killed turn triggers a silent create"
   premise is withdrawn per B1: the observed shape is a resume of that
   run's own session, and the clause is restated to match.
6. **Does the pre-spawn per-cwd store-directory check belong?** Owner
   answer after review draft-03 (2026-09-17): option (a). The turn warns
   when the per-cwd store directory is absent (refusing would forbid the
   intended v1 silent create on claude/codex/pi); the diagnostic line
   lands either way. Stated limit: the check cannot catch the stranger
   case, where the directory exists and holds the wrong session.
7. **Does a silently created session run the defaults profile?** Owner
   answer after review draft-03 (2026-09-17): option (a). A truly fresh
   session runs native defaults; this is accepted and documented. After
   B1, the killed-turn path no longer produces fresh sessions on claude
   or codex, so this covers the true empty-cwd case only.

## Open Questions

None remain open. OQ5-OQ7 were resolved by the after-review owner answers
of 2026-09-17 and moved to Resolved questions 5-7 above; Resolved
question 3 was re-asked and settled as option (b).

## References

Normative (MUST read to implement this RFC):

- `docs/rfc/05_cursor-cli-harness.rfc.md`, Resume-last section - the
  moved-out design this RFC replaces; its "not reachable" sentence is
  superseded by Phase 5 on landing
- `docs/rfc/05_cursor-cli-harness.review-draft-05-opus.md`, findings B1,
  H2, M4, L6 - the known problems this RFC answers
- `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/5a45c2a9-6252-4aae-9c22-f86a4afa9c3b/scratchpad/resume-last/evidence.md`
  and its `out/` captures - the probes grounding every grammar and
  behavior claim, including the draft-02 probe-safety record, the
  draft-03 probes (30-50), and the draft-04 probes (60-67: fork,
  sandbox-override, and hook probes with a store-retention listing, a
  deletion record, and the B1 correction note) with the "hook records
  excluded" fixture rule.
  At implementation the normative evidence lands at
  `docs/research/2026-09-17-resume-last-evidence.md` with path-normalized
  fixtures (Phase 4); until then this scratchpad path is the anchor.
- `src/interpretation/resume-last.ts` - the stranger stance this RFC bounds
- `src/interpretation/parse-resume.ts` - the parser this RFC leaves
  behaviorally unchanged
- `src/interpretation/argv.ts` (`turnTail`, `buildSpawnArgv`),
  `src/cli/plan-turn.ts` (profile gate, env phase), `src/cli/args.ts`
  (`resumeIdOf`), `src/cli/run.ts`, `src/cli/session.ts`,
  `src/cli/resume-guard.ts` - the CLI sites this RFC touches
- `src/interpretation/presence.ts` - what is (and is not) detectable for
  Resolved Question 3
- `src/interpretation/refusal.ts`, `src/interpretation/support.ts`,
  `src/interpretation/hints.ts`, `src/cli/help.ts`,
  `src/cli/inspect-native-settings.ts`,
  `src/interpretation/native-settings-argv.ts`,
  `src/execution/stream-turn.ts` (F-23 warning), `src/execution/decode.ts`
  and `src/execution/native-approval-turn.ts` (identity emit sites),
  `src/execution/events.ts`, `src/cli/render.ts` - the refusal, signal,
  and consumer sites
- ADR 0007 (supervise one process) and `CONTEXT.md` (scope test) - the
  boundary this RFC is tested against
- The fit-check skill - the discipline behind the Fit check section

Informative (helpful context):

- `docs/rfc/05_cursor-cli-harness.rfc.md`, full text - cursor descriptor,
  trust gate, and passthrough rules referenced here
- `src/knowledge/` descriptors (`claude-code.ts`, `codex.ts`, `pi.ts`,
  `muse.ts`) - current `resume` and `resumeLast` values
- README event contract and identity text - the consumer surface the
  signal extends
- The draft-rfc template - section and RFC 2119 language conventions this
  document follows
