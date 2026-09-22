# Live compaction signals across the six harnesses

Probed 2026-09-22 on `pro`. Six research tickets, one per harness, asking the
same three questions of each: what records reach a live headless stream while
compaction runs, what percentage or occupancy numbers they carry, and what the
stream shows during the compaction pause.

These findings are the input to
[ADR 0009](../../adr/0009-compaction-status-event.md), which decides how hcn
reports compaction upward. The decision map is
[#229](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/229).

| Harness | Ticket | What the stream carries | Findings |
|---|---|---|---|
| claude | [#230](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/230) | Status and boundary records with token deltas. | [claude](claude/claude-compaction-signals.md) |
| codex | [#231](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/231) | Nothing on the observed path. The exec JSONL processor drops the compaction item at source, and the item carries no numbers anyway. A second, unobserved compaction path prints a prose warning typed as an error. | [codex](codex/codex-compaction-signals.md) |
| pi | [#232](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/232) | A complete `compaction_start` / `compaction_end` pair, already on the stream hcn reads. Its decoder drops both. | [pi](pi/pi-compaction-signals.md) |
| muse | [#233](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/233) | Nothing on stdout when compaction succeeds; a prose reason on `run.terminal.failed` when it fails. The structured signal is on the MSP view hcn already attaches for approvals. | [muse](muse/muse-compaction-signals.md) |
| cursor | [#234](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/234) | Nothing. The emitter has no compaction code path. The `preCompact` hook fires, with every occupancy field zero. | [cursor](cursor/cursor-compaction-signals.md) |
| antigravity | [#235](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/235) | One bare `checkpoint` record ending the pause, carrying a duration and nothing else. | [antigravity](antigravity/antigravity-compaction-signals.md) |

## The finding that reframed the design

No harness pushes an occupancy percentage on any live compaction signal.

Claude's percentage is reachable, but only by pulling it on a control channel
that needs a bidirectional session. Cursor declares three occupancy fields on
its hook and reports `0` for all three in 11 of 11 captures. The other four
report none on a live stream.

Numbers adjacent to occupancy do exist, and none of them is one. Claude's
stdout carries per-response `usage` from which occupancy can be derived after
the fact, against a window the stream never names, so the derivation was wrong
by a factor of 25 on the turn that actually compacted. Codex records occupancy
inputs in its rollout file, which never reaches stdout. Antigravity has a
`/context` panel, refused in print mode. So a compaction event can carry the
absolute token counts three harnesses report, and no derived percentage.

## Measured compaction pauses

The stream goes silent while a harness compacts. On claude and pi the silence
is announced before it begins. On the rest it is indistinguishable from a slow
model until it ends, or entirely.

| Harness | Silent window | Announced before the pause |
|---|---|---|
| codex | 24.3 to 32.5 s | no |
| cursor | 25 to 39 s | no |
| claude | 25 to 28 s | yes |
| antigravity | 4.5 to 18 s | no |
| pi | 7 to 10 s | yes |
| muse | about 7 s | not established |

Muse's MSP view carries an `item/started` record for compaction, so the start
exists as a record. These probes read the view retrospectively rather than
live, so whether it arrives before the pause is open. Implementation ticket
[#241](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/241)
closes that question.

The codex figures are the stdout-silence intervals around three crossings, not
isolated measurements of compaction itself. A caller whose inactivity budget
sits below these kills a healthy run. hcn's `--stall` is opt-in and unset by
default.

## Two premises these probes corrected

Two tickets were charted on prior research that turned out to describe a
different harness. The cursor ticket cited `auto_compact_*` stream records;
those are Grok Build CLI's, and no such record exists anywhere in the cursor
bundle. The antigravity ticket cited a `compaction_checkpoints/` store
directory; that is Grok Build CLI's too, and no such directory exists in
antigravity's store. Both tickets reached the right conclusion by other
evidence, and both corrections are recorded in their findings files.

## Why the captures are not here

Each findings file was written beside a `captures/` directory holding the raw
harness output its claims rest on, and each file still refers to those paths.
They are not published, and those references do not resolve here.

The reason is the captures, not the findings. Raw stdout from these harnesses
echoes the operator's own agent configuration back into the stream: pi's
captures carry the operator's global instruction file in full, across 15 files,
and muse's carry descriptions from the local skill library. That is machine
configuration, not harness behaviour, and this repository is source-public.
Editing it out is not an option either, because an edited capture is not a
capture, and `AGENTS.md` is explicit that captured harness output is evidence
that must not be scrubbed.

So the captures stay on the machine that produced them, on local
`research/compaction-<harness>` branches. What survives here is the part
written to be read: every record a claim rests on is quoted verbatim inside the
findings file that makes the claim.

Two redactions inside the captures are documented in the findings themselves
and were verified to have held: claude's local `SessionStart` hook stdout, and
cursor's account email. Muse's two session-log extracts are truncated by their
extraction script, which its own capture index records.
