# Resume-last live verification (RFC-06 Phase 4 + Phase 5): 2026-09-17

Phase 5 (cursor flip) is implemented and gated by `pnpm check` before any
live run below. All live runs use the built binary
(`node dist/cli.js`, called HCN); claude fork-probe argv comes from
`HCN inspect --argv`. Raw-CLI runs use byte-identical argv from inspect.

Conventions: probes numbered 80 and up, captures in
`scratchpad/resume-last/out/`. Every harness run:
`env -i HOME PATH TERM` plus only the recorded auth/store names (claude:
`USER LOGNAME TMPDIR CLAUDE_CONFIG_DIR`; pi: `PI_CODING_AGENT_DIR`; cursor:
`XDG_CONFIG_HOME`; codex: none), stdin from `/dev/null`, hcn-enforced
`--timeout`. Plant prompt: `Remember the code word ORCHID-7. Do not call any
tools. Reply OK.` Recall prompt: `What is the code word? Do not call any
tools. Reply with just the code word.` Stranger plant: same template with
HERON-4. Option probes: `Reply PONG. Do not call any
tools.` with `--questions none` (the preamble is orthogonal to the option
under test). No transcript or hook content was read: ids, counts, exit
codes, and marker counts only. Secret-scan over all captures: 0 matches for
tokens, keys, JWT, emails.

Installed versions (same as the RFC probes): claude 2.1.274, codex-cli
0.154.0, pi 0.85.1, cursor agent 2026.09.15-d2fe57e.

## Probe matrix per harness

`Oct7`/`Heron4` below are marker mention counts in the reply, not quotes.

| Probe | Harness | Result |
| --- | --- | --- |
| 80 plant | claude | exit 0, session `00041986-...` |
| 81 recall | claude | exit 0, NEW fork id `b5fd20b5-...`, ORCHID-7 x2 |
| 82 no-session (empty cwd, WITH fork pair) | claude | exit 0, fresh id `73d4c85a-...`, no recall |
| 83 subdir scope | claude | exit 0, fresh id `9bfea444-...`, no recall |
| 84/85 stranger plant + recall | claude | plant `6544aaac-...` (HERON-4); recall forks `343e9f5e-...`, HERON-4 x2 |
| 80/81 | codex | plant `01a0adf1-...`; recall same thread, ORCHID-7 x1 |
| 82 no-session | codex | exit 0, fresh `01a0adf2-...` |
| 83 subdir scope | codex | exit 0, different thread, no recall |
| 84/85 stranger | codex | plant `01a0adf2-da7f` (HERON-4); recall same thread, HERON-4 x1 |
| 80/81 | pi | plant `01a0adf3-...`; recall same session, ORCHID-7 x1 |
| 82 no-session | pi | exit 0, fresh `01a0adf4-...` |
| 83 subdir scope | pi | exit 0, different session, no recall |
| 84/85 stranger | pi | plant `01a0adf4-7a11` (HERON-4); recall same session, HERON-4 x1 |
| 80 plant | cursor | exit 0, session `683fac56-...`, marker x1 |
| 81 recall | cursor | exit 0, same session, EMPTY reply (see position series) |
| 82 no-session | cursor | exit 1, `No previous chats found.`, no ids |
| 83 subdir scope | cursor | exit 1, `No previous chats found.` |
| 84/85 stranger | cursor | plant `a2f00bd8-...` (HERON-4); recall same session, HERON-4 x1 |

Matrix verdict: recall, no-session, subdirectory scope, and stranger-case
(most-recent pick) all match the RFC tables on all four harnesses. The
claude no-session run carried the rendered fork pair, so the unverified
clause is now observed: exit 0 with a fresh id.

## Turn-option gate (Resolved question 1)

One live `--resume-last` run per expressed option. Every run below exits 0
with a PONG reply unless noted.

- claude: effort, system-prompt, append-system-prompt, discovery
  (`--no-extensions`), access, memory, tools (`--tools read`, spawn shows
  prompt before `--allowedTools Read`, re-verifying probe 12f order live).
  `--model bogus-hcn-probe` refuses hcn-side exit 2 (unknown-model).
  `--isolation tool-free` refuses exit 2 with the resume-phase refusal
  (`cannot be expressed on resume`). Stream flags ride every run.
- codex: context-window, effort, system-prompt, access (renders
  `-c sandbox_mode="read-only"` in the before-prompt slot), memory.
  `--sandbox workspace-write` with a write request lands `WRITE-OK`
  (override enforced on the resume path, mirroring 11b through HCN argv).
  `--model bogus-hcn-probe` refuses hcn-side exit 2.
- pi: effort, provider (`zai`), system-prompt, append-system-prompt,
  discovery (`--no-extensions`), access, memory (`--no-memory` no-op,
  accepted). `--model bogus-hcn-probe` SPAWNS and fails natively exit 1
  (`Model ... not found`, probe-41 pattern: the flag is forwarded).
- cursor: effort via slug (`--model claude-4.6-sonnet --effort medium`
  renders `--model claude-4.6-sonnet-medium`), autonomy (`--force` in the
  pinned after-model position, PONG x2), model (default `auto` on all other
  runs). `--model bogus-hcn-probe` refuses hcn-side exit 2.
  `--sandbox read-only` refuses exit 2 (`unsupported-option`, pre-existing).
  Bare `--effort low` without a slugged model refuses hcn-side
  (`unknown effort`, pre-existing resolver behavior, no live run needed).

No option failed: no new typed refusal was added. Two first-attempt
`--access` runs (claude 90, codex 90) refused on the access/tools and
access/sandbox mutual exclusions because the matrix base flags already
carried a tools posture; clean reruns without the base posture pass and are
filed as the probes of record.

## Codex no-override control (L3)

93 launches `--sandbox workspace-write` writing nothing (thread
`01a0adfd-...`); 94 resumes the same thread with NO sandbox flag and a write
request: file lands with `L3-OK`, same thread id, `resumeLast: true`. The
write is NOT blocked without the override, so the 64-65 enforcement
inference stands: the block comes from the read-only resume-turn override.

## Claude fork gate of record (Resolved question 3)

Parent holds planted marker FORK-MARKER-3 (verified x1 in its reply);
argv of record from `HCN inspect --argv`:
`claude -p --continue --fork-session <prompt> --output-format stream-json
--verbose --include-partial-messages --model claude-haiku-4-5-20251001
--disallowedTools ...`. Parent confirmed alive by pid immediately before the
child ran, and still alive after the child finished (real overlap).

- Child 98: exit 0, NEW id `6fe488d8-...` (differs from running parent
  `d739bffa-...`), `resumeLast: true`, recalls FORK-MARKER-3 x1.
- Parent file `d739bffa-...jsonl`: mtime and size IDENTICAL before and after
  the child (stat epochs retained in `out/97-fork-store-pre.txt` and
  `out/98-fork-store-post.txt`). No two-writers case.
- Fork file `6fe488d8-...jsonl` added alongside.

Gate verdict: PASS. The pair is accepted, recall carries through the fork,
the parent file stays untouched. No stop rule fired. (Two earlier parents
finished before the child could start; the gate run is attempt 3 with a
3000-word parent.)

Retained for review (NOT deleted): the four `ws80-fork` transcript files;
see the appendix in `scratchpad/resume-last/evidence.md` for mtime/size/id.

## Cursor `--force` position series

The pinned order renders `--force` after the stream flags; probe 14 carried
it before `--continue`. Both positions are accepted (exit 0). Reply
completeness on the auto model is flaky on BOTH positions and on raw CLI
runs outside hcn:

- force-after: HCN 81 empty, HCN 81-retry empty, raw 81c empty
  (`result.result` len 0, thinking-only), HCN 85 reply (HERON-4), raw 81g
  reply (PONG x4).
- force-before: raw 81b reply, raw 81d reply, raw 81f reply (PONG x4).
- force-after on LAUNCH replies fine (raw 81e, PONG x4): the flake is
  resume-path-specific, not a general position bug.

Conclusion: no argv change indicated; the pinned order stands (HCN 85
recalled through it). Empty resume turns exit 0 with the id announced and
`resumeLast: true`, so a consumer sees the turn shape either way. No typed
refusal added: nothing fails deterministically.

## `inspect claude --context --resume-last`

Exit 0 with context accounting (`mode headless-turn`, resume supported);
no typed refusal needed. (First attempt without a prompt refused
`missing prompt`, which is the existing prompt requirement, not a
resume-last refusal.)

## Identity signal

Spot-checked on live captures: `resumeLast: true` present with
`requestedId: null`, authority `harness-minted` on resume-last turns
(claude 98, codex 90, cursor 81); absent on launch turns (cursor 80).

## Fixtures filed

`test/fixtures/<harness>-<observed-version>/resume-last.ndjson` plus
README, consumed by `test/knowledge/resume-last-evidence.test.ts`:

- `claude-2.1.274`: native fork recall (HERON-4 x3, fork `561ce3da-...`);
  13 hook-record lines and the `system/init` line (account connector names)
  excluded at filing with counts recorded.
- `codex-0.154.0`: native recall on a fixture-dir thread (JUNIPER-6),
  filed as-is.
- `pi-0.85.1`: native recall (HERON-4 x9), scratch prefix normalized (1 line).
- `cursor-2026.09.15-d2fe57e`: native recall (HERON-4 x2, non-empty
  `result`), scratch prefix normalized (1 line).

`verifiedAgainst` does NOT move on any harness (a bump needs the smoke
tripwires per the AGENTS.md convention).
