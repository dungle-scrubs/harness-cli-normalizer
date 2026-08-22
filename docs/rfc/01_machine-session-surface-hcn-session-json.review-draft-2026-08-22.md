# Review: RFC-01 Machine session surface: hcn session --json

## What was reviewed

- Path: `docs/rfc/01_machine-session-surface-hcn-session-json.rfc.md`
- Version: the document carries no version field. Reviewed the draft with
  frontmatter `status: Draft`, `date: 2026-08-22`, as it stood untracked in
  the working tree on 2026-08-22 after the two decisions recorded in its
  Open Questions (`--provider` now; `closed` over `done`).
- Status: Draft.

Reviewers:

- Cross-family: `muse-spark-1.2-contributor@muse` via
  `delegate.ts` (route `intended` = `actual`; `status: ok`). `choose-model`
  warned that no non-Claude candidate meets the high-stakes bar for `plan`
  (intelligence >= 9, taste >= 7), so every cross-family finding below was
  re-traced against the code before it was kept; one was downgraded (F13).
- Same-family pass: Claude Fable 5, the draft's author. Findings marked
  `[own]`; cross-family marked `[muse]`; both marked `[both]`.

## Structural results

`npx tsx ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/01_machine-session-surface-hcn-session-json.rfc.md`

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

Ordered by severity. Each names the section it lands in and its rung on
the evidence ladder (1 asserted, 2 pointed at code, 3 traced, 4 ran, 5 saw
in the running system).

### Blocking

**F1. `--stall` is specified against a watchdog the session runner does not have.** `[both]` (rung 3)
Sections: "`--stall <seconds>` on `hcn session`", Introduction / Scope, State Machine / Timeouts.
The RFC says the budget is "hcn-enforced through the runner's existing `stallMs`" and that "the runner's stall handling kills the process". `stallMs` is read only in `src/execution/stream-turn.ts:339-357` (arm) and `:450`, `:505` (rearm). `src/execution/open-session.ts` never reads `deps.stallMs`; its `finalize` (`open-session.ts:478-487`) derives `cause` from `limitSeen` and `exitCode` only: `limit`, `clean`, `killed`, `crash`. No `stall` arm exists. Delivering `--stall` needs a per-turn watchdog inside `openSession`, which Scope rules out ("Changing `openSession` or the descriptors" is out of scope). Two normative statements cannot both hold. The RFC must either widen Scope to `openSession` or define stall as CLI-owned (a timer on stdout inter-arrival in `session.ts` that calls `close()` and synthesizes the cause).

**F2. `--provider` on `hcn session` also needs a runner change.** `[both]` (rung 2)
Sections: "Flags accepted", Abstract, Scope.
`openSession` builds its argv with `buildSessionArgv(h, {sessionId, model})` (`open-session.ts:98-101`). `SessionOptions` and `buildSessionArgv` (`src/interpretation/argv.ts:194-224`) carry no provider; `OpenSessionOptions` (`open-session.ts:65-75`) has no `provider` field. The pi descriptor renders a provider selector (`src/knowledge/pi.ts:124`), but only `buildLaunchArgv` / `buildResumeArgv` consume that table. The flag is expressible; the RFC's claim that the runner does not change is not. Widen Scope to `argv.ts` (`SessionOptions`) and `OpenSessionOptions`, or drop the flag.

**F3. `closed.cause` has no producer for `failed` or `stall` on harness death, and omits `awaiting-input` without saying so.** `[muse]` (rung 2)
Sections: Message Formats / `closed`, Error Handling.
`ExitCause` (`src/execution/events.ts:21-30`) is `clean | limit | crash | stall | killed | failed | awaiting-input`. The RFC's `closed.cause` comment lists six values and the text says it "follows the runner's final `done` cause when the harness died". `finalize` (`open-session.ts:481-487`) produces only `limit`, `clean`, `killed`, `crash`. `failed` appears only in the CLI-synthesized S001/S002 paths; `stall` appears nowhere (F1). The RFC should state exactly which causes `closed` can carry and where each is produced, and state that `awaiting-input` is turn-scoped and never a `closed.cause`.

**F4. `turn.id` correlation rests on a FIFO the runner does not carry, with one unclosed case at the boundary.** `[both]` (rung 3)
Sections: Protocol Overview rules 6-7, Message Formats / `turn`, Implementation Notes.
`pendingSends` holds text only (`open-session.ts:153`, `:569-570`); the runner never sees the consumer's id. The CLI must keep a parallel FIFO of ids in lock-step. In `endTurn` (`open-session.ts:273-274`) the runner shifts the next text and calls `startTurn()` only if `writeUser(next)` returned true. On a write failure the shifted text is dropped, no turn starts, and the error `writeUser` pushes goes to `activeTurn?.push` while `activeTurn` is `null`, so it is lost. The CLI's FIFO then attributes the next turn to the wrong id. The RFC needs either a runner change (`send` takes `{id, text}` and the turn iterable carries the id, or the drop is surfaced) or a CLI rule: when a boundary passes without a `turn`, reject the head id with `write-failed`. Either way the "runner unchanged" claim or the correlation rule gives.

**F5. Refusal and spawn failure before the `session` line have no JSON path in the session CLI.** `[both]` (rung 3)
Sections: Error Handling S001, S002; Protocol Overview rule 3; Implementation Notes.
`src/cli/session.ts:16-30` and `:103-115` handle `no-session-mode`, `ArgvRefusalError`, config errors, and `SessionSpawnError` by writing prose to stderr and setting the exit code, with nothing on stdout. `src/cli/refuse.ts:37-46` is the helper `hcn run --json` uses, and it writes `failure` + `done`, not `failure` + `closed`. The RFC's rule 3 ("first line MUST be `session`, or `failure` + `closed`") has no implementation path and Implementation Notes do not name one. Add: the session branch synthesizes the pair itself (or `refuse` takes the terminal kind), and the exit code is set only after the `closed` line is flushed.

### Major

**F6. Consumer stdout closed is an uncovered state.** `[own]` (rung 2)
Sections: State Machine, Protocol Overview rule 4.
LIVE exits on `close`, stdin EOF, SIGINT, SIGTERM, and harness death. hcn's own stdout closing (the consumer died) is not listed. Today `src/cli/index.ts:10-17` handles `EPIPE` with `process.exit(0)`: no `close()`, no grace, no SIGTERM, exit 0. Rule 4 ("last line MUST be `closed`... except on SIGKILL") cannot hold, and the harness child is left to notice stdin EOF by itself. Specify: on stdout EPIPE in `--json` mode, hcn runs `close()` (grace, escalation) and exits 1.

**F7. `write-failed` cannot be distinguished from `closed`, and S007 contradicts "a rejection never ends the session".** `[muse]` (rung 2)
Sections: Disposition semantics, Error Handling S005/S007.
`writeUser` (`open-session.ts:177-190`) pushes an error and returns false; `send` then throws `SessionClosedError` (`open-session.ts:~575`). The CLI sees one exception type for both cases. S007 also says a `write-failed` rejection moves the session to DEAD while Disposition semantics says a rejection never ends the session. Pick one: either `write-failed` is a distinct runner signal (runner change) and is terminal, or it is folded into `closed`.

**F8. Backpressure rule 8 conflates two hops.** `[muse]` (rung 2)
Sections: Protocol Overview rule 8, Implementation Notes.
`activeTurn.push` (`open-session.ts:285-289`) already blocks past the channel's high-water mark (`src/execution/channel.ts:21`, 1024/256), which is the harness-to-CLI hop. The CLI-to-stdout hop is `src/cli/render.ts:84-86`, a bare `process.stdout.write`. Rule 8 should name the stdout hop explicitly (check `write()`'s return, await `drain`) and say the runner's channel handles the other.

**F9. Malformed command in CLOSING or DEAD has two applicable rules.** `[muse]` (rung 2)
Sections: stdin commands (last bullet), Error Handling S004, State Machine / Invalid transitions.
S004 says a malformed line gets an `error` and no disposition. Invalid transitions say any command in CLOSING/DEAD gets `disposition: rejected`. A malformed line in CLOSING satisfies both. State that malformed is decided first and produces `error` only, in every state.

**F10. Turn-scoped `done.exitCode` is not always `null`.** `[own]` (rung 2)
Section: Message Formats, field rules.
True for turns ended by the harness's turn-end record. When the harness dies mid-turn, `finalize` ends the open turn with the process exit code (`open-session.ts:~512`). Say: `null` except on the death path, where it equals `closed.exitCode`.

**F11. `--mode` and `--capabilities` are not parsed flags; no validation is specified.** `[muse]` (rung 2)
Section: `hcn inspect <harness> --capabilities`.
`parseCommonFlags` (`src/cli/args.ts:~421-468`) has a closed option table without `capabilities` or `mode`; Node's `parseArgs` rejects unknown long flags. The RFC enumerates the three `HarnessMode` values (`src/knowledge/descriptor.ts:46`) but specifies no refusal for an invalid `--mode`. Add both to Implementation Notes and give `--mode` a refusal with the supported list. (The cross-family claim that `--capabilities` without a prompt would fail prompt validation was checked and does not hold: `inspect.ts:24-37` gates the prompt path on `--argv` only.)

### Minor

**F12. Queued sends on death: the runner drops them as one `error`, the CLI must emit the per-send rejections itself.** `[both]` (rung 3)
Section: Error Handling S003, Implementation Notes.
`finalize` routes one error ("N queued send(s) died with the session", `open-session.ts:~503-514`) and clears `pendingSends`. S003's per-send `rejected` lines need the CLI's id FIFO (F4). Say so, and say the consumer will see both lines for the same loss.

**F13. `session.sessionId` wording: "in use (caller-assigned or minted)" reads as the minted id, which is unknowable at that point for pi.** `[muse]` (rung 2)
Section: Message Formats / `session`.
For pi, `sessionMode.idFlag` is `null` (`src/knowledge/pi.ts:57-65`) and the minted id arrives only with the identity-probe response (`open-session.ts:331-339`, `:350-375`), after the `session` line is written. The field rule below the type already says the right thing (`session.sessionId` is the id hcn asked for). Align the type comment with it.

**F14. `closed.exitCode` on the SIGKILL path is `null`; the State Machine does not say so.** `[muse]` (rung 2)
Section: State Machine / CLOSING.
`finalize` maps `exitCode === null` to `killed`. State the pair (`cause: killed`, `exitCode: null`) so a consumer can gate on either.

**F15. ASKED -> OPEN accepts both `answer` and `send`; the difference is implied, not stated.** `[muse]` (rung 2)
Sections: State Machine, stdin commands.
The commands section says `answer` composes the preamble and `send` does not; the state machine lists both as valid from ASKED. Add one sentence: a plain `send` from ASKED is allowed and carries no preamble.

**F16. Terms used in type blocks without a Terminology entry.** `[both]` (rung 1)
Section: Terminology.
`HarnessName`, `ExitCause`, `FailureSummary`, `CapabilityResult`, and "escalation preamble" (Security Considerations; it is `composeEscalatedPrompt` in the runner) appear without definition. They are in Normative References; a one-line entry each closes it.

**F17. `turn.id` absent case has no producer.** `[both]` (rung 3)
Section: Message Formats, field rules.
`startTurn` is called only from `send` and from the queued drain in `endTurn`. The reservation is fine; say that a consumer MAY treat an absent `id` as a protocol error until a producer exists.

**F18. `session.hcn` example `0.6.0` is not a value any source defines today.** `[muse]` (rung 2)
Section: Message Formats / `session`. `package.json` is `0.5.3`; `src/cli/version.ts` is the source. Cosmetic.

## Cleared

Checked and found sound (rung in parentheses):

- `session` then `identity` ordering: pre-turn events are held in `preTurnEvents` and flushed at `startTurn` (`open-session.ts:~200-209`), so `identity` lands inside the first turn as stated. (3)
- Disposition vocabulary: `SessionSendResult.disposition` is `started | queued` (`open-session.ts:52-54`); `send` throws `SessionClosedError` when `dead || closing`. The RFC's `rejected` mapping matches, modulo F7. (2)
- Close grace: `close()` ends stdin, arms `CLOSE_GRACE_MS` (5000) then `escalate()` = SIGTERM then SIGKILL after `KILL_GRACE_MS` (5000, `stream-turn.ts:55`). Matches the CLOSING arm. (2)
- `preTurnEvents` cap and droppable-first eviction (`open-session.ts:~291-299`) match the README's `DROPPABLE_KINDS`. (2)
- `question` detection and the `awaiting-input` flip (`open-session.ts:~218-256`) match the RFC's description. (3)
- `capabilitiesOf` degradation to `source: unknown` for a model outside the vocabulary (`src/interpretation/capabilities.ts:33-45`) matches the `--capabilities` text. (2)
- The eleven `HarnessEvent` kinds in `src/execution/events.ts:32-63` match the RFC's list. (2)
- `--provider` and `--json` are already parsed by `parseCommonFlags` (`args.ts:160, 286, 309, 323, 435, 460`); the session branch can reuse the parser. (2)
- `HERDR_ENV` deletion for the child: `session.ts:96`. (2)
- Exit-code table matches `src/cli/exit-codes.ts` once `awaiting-input` is read as turn-scoped. (2)
- `hcn --version` prints `0.5.3`. (5)
- Scope delivery: every in-scope item in the Introduction has a section (`--json` stream, stdin commands, disposition, correlation, close, exit codes, `--capabilities`, `--stall`). The gaps are in what those sections claim about the runner (F1-F5), not in coverage. (2)
- Security Considerations: no secret crosses the pipe; `text` goes through `encodeSessionInput` as a JSON string value; the runner's boundary log records send lengths, not text (`open-session.ts:~508`). (2)

## Not reviewed

- Nothing was executed beyond `hcn --version` and the structural validator. Every other rung is 2 or 3. A rung-4 check of F4 (the write-failure drop) would be a fake-spawner test that closes the child's stdin between turns; not run.
- `src/interpretation/question.ts` (the `hcn-question` detector): the RFC does not change it.
- pi rpc session behaviour beyond `open-session.ts:331-403`: no pi fixture was run.
- Bun vs Node behaviour of a stdin line reader on a final unterminated line: read, not exercised.
- The README, `SESSION_HELP`, and hcn skill reference updates the RFC lists: not yet written, so not judged.
