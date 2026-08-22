---
number: 01
title: "Machine session surface: hcn session --json"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-22
---

# RFC-01: Machine session surface: hcn session --json

> Revision 2. Answers the review
> `01_machine-session-surface-hcn-session-json.review-draft-2026-08-22.md`
> (validator pass; one cross-family reviewer, muse; one same-family pass).
> The review's five blocking findings all traced to one claim: the RFC
> promised the wire contract without changing `openSession` or the
> descriptors, and five features needed those changes. This revision widens
> Scope to the execution layer and specifies each change. The per-point log
> is at the end of this document, under "What changed in revision 2".

## Abstract

`hcn run --json` gives a program a persistent-session-free way to drive a
harness: NDJSON `HarnessEvent` lines out, one exit code back. `hcn session`
has no equivalent. It is a readline REPL for a human: a `you ›` prompt on
stdout, rendered text, and the input disposition written to stderr as prose.
A consumer that owns input timing (a chat host that queues, fences, and
replays input) cannot drive it. This RFC adds `--json` to `hcn session`: a
flat NDJSON stream on stdout that carries the existing `HarnessEvent`
vocabulary plus four session-scoped control events, and an NDJSON command
stream on stdin. It also adds a capability query to `hcn inspect`.
Delivering the contract needs named changes to the execution layer:
`openSession` learns a per-turn stall watchdog, carries the consumer's
input id, takes a provider, and surfaces a write failure. Those changes are
in scope and are specified in "Execution-layer changes". The reducer, the
store enforcement, and the `HarnessEvent` turn vocabulary do not change.

## Introduction

### Problem

The readiness audit (`docs/audits/2026-08-21-readiness/report.md`, the
finding at line 1575) records the gap: the `started`/`queued` disposition
exists only in the TypeScript type, and `hcn session` writes
`disposition: queued (turn in progress)` to stderr as prose. A program has
no structured way to learn whether its input started a turn or was held, no
way to correlate a held input with the turn that later consumes it, and no
way to learn that the session ended and why.

The first consumer is lucid-v2. Its headless host today imports
`openSession` and `streamTurn` from this package's `src/` tree. Decision
D-001 (README line 7) makes `hcn` the only supported surface, so that
import path is unsupported. `hcn run --json` already covers `streamTurn`.
Nothing covers `openSession`.

### Scope

In scope:

- `hcn session <harness> --json`: the stdout event stream, the stdin
  command stream, disposition, turn correlation, close, and exit codes.
- `hcn inspect <harness> --capabilities`: `CapabilityResult` as JSON for a
  model and mode.
- A per-turn inactivity budget on sessions (`--stall`).
- The execution-layer changes that the four items above require:
  a `stallMs` watchdog inside `openSession`, an id-carrying `send`, a
  `provider` field on the session options and `buildSessionArgv`, and a
  distinct write-failure signal. Each is specified in "Execution-layer
  changes".

Out of scope:

- Changing the `HarnessEvent` turn vocabulary. Existing kinds keep their
  shape. New kinds are additive, as the README promises.
- Changing the protocol reducer or the store enforcement. This RFC lives
  in the execution and CLI layers.
- A transcript decode command (`hcn decode`) for consumers that tail a
  harness's native transcript. Deferred; see Open Questions.
- Full session flag parity with `hcn run` beyond `--provider` (tools,
  skills, effort, access, env). Deferred; see Open Questions.

### Motivation

lucid-v2 is blocked on this surface. Its migration (lucid-v2
`docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md`) depends on this
RFC and nothing else in this package.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **hcn**: the CLI binary this package ships.
- **harness**: one of `claude`, `codex`, `pi`, `muse`.
- **HarnessName**: the string that names a harness, defined in
  `src/knowledge/descriptor.ts`.
- **session**: one harness process that serves many turns over its
  lifetime. Only harnesses whose descriptor declares a `sessionMode` (today
  `claude` and `pi`) have one.
- **turn**: one prompt in, one stream of events out, ending in a
  turn-scoped `done`.
- **HarnessEvent**: the turn vocabulary in `src/execution/events.ts`:
  `identity`, `token`, `message`, `progress`, `tool`, `context`, `limit`,
  `error`, `failure`, `question`, `done`.
- **ExitCause**: the closed union in `src/execution/events.ts` a `done` or
  `closed` carries: `clean`, `limit`, `crash`, `stall`, `killed`, `failed`,
  `awaiting-input`.
- **FailureSummary**: the reduced failure record in
  `src/execution/failure.ts`, carried on `done.failure` and `closed.failure`.
- **CapabilityResult**: the record `capabilitiesOf` returns
  (`src/interpretation/capabilities.ts`): `vision`, `images`, `streaming`,
  `session`, `source`, `confidence`.
- **control event**: a session-scoped event this RFC adds: `session`,
  `turn`, `disposition`, `closed`.
- **command**: one NDJSON line the consumer writes to hcn's stdin.
- **disposition**: what happened to a `send`: `started`, `queued`, or
  `rejected`.
- **escalation preamble**: the instruction text `composeEscalatedPrompt`
  adds to a send under `escalateQuestions`
  (`src/interpretation/session-input.ts` and its callers).
- **consumer**: the program that spawns `hcn session --json` and reads
  its stdout.

## Protocol Overview

```
consumer                                hcn session <h> --json             harness
   |                                           |                              |
   |  spawn                                    |  spawn (descriptor argv)     |
   |------------------------------------------>|----------------------------->|
   |  {"kind":"session",...}                   |                              |
   |<------------------------------------------|                              |
   |  {"op":"send","id":"a","text":"hi"}       |                              |
   |------------------------------------------>|  encodeSessionInput          |
   |  {"kind":"disposition","id":"a",          |----------------------------->|
   |   "disposition":"started"}                |                              |
   |<------------------------------------------|                              |
   |  {"kind":"turn","turnId":"..:turn-1",     |                              |
   |   "id":"a"}                               |                              |
   |<------------------------------------------|                              |
   |  {"kind":"identity",...}                  |   stream-json / rpc          |
   |  {"kind":"token",...} ...                 |<-----------------------------|
   |  {"kind":"message",...}                   |                              |
   |  {"kind":"done","exitCode":null,          |                              |
   |   "cause":"clean"}                        |                              |
   |<------------------------------------------|                              |
   |  {"op":"send","id":"b","text":"more"}     |   (turn 1 still open)        |
   |------------------------------------------>|                              |
   |  {"kind":"disposition","id":"b",          |                              |
   |   "disposition":"queued"}                 |                              |
   |<------------------------------------------|                              |
   |  ... turn 1 done ...                      |  boundary: deliver b         |
   |  {"kind":"turn","turnId":"..:turn-2",     |----------------------------->|
   |   "id":"b"}                               |                              |
   |<------------------------------------------|                              |
   |  {"op":"close"}  (or stdin EOF)           |  stdin end, SIGTERM grace    |
   |------------------------------------------>|----------------------------->|
   |  {"kind":"closed","exitCode":0,           |                              |
   |   "cause":"clean"}                        |                              |
   |<------------------------------------------|                              |
   |  exit 0                                   |                              |
```

Rules:

1. stdout carries NDJSON only: one JSON object per line, UTF-8, `\n`
   terminated. hcn MUST NOT write the `you ›` prompt, rendered text, or any
   prose to stdout in `--json` mode.
2. stderr keeps its current role: provenance lines, divergence reports, and
   boundary log lines. A consumer MAY ignore stderr.
3. The first stdout line MUST be a `session` event, or a `failure` +
   `closed` pair when hcn refuses before spawn (see Error Handling).
4. The last stdout line MUST be a `closed` event, except on SIGKILL of hcn
   itself. A consumer stdout that closes early (EPIPE) is handled by the
   State Machine, not by dropping `closed`.
5. Every `HarnessEvent` of a turn appears between that turn's `turn` event
   and its `done`. Turns do not interleave: at most one turn is open at a
   time, which `openSession` already guarantees.
6. Every `send` command MUST receive exactly one `disposition` event, in
   command order, before any later command's disposition.
7. A `queued` send is delivered at the next turn boundary. The `turn` event
   that consumes it carries the send's `id`, so the consumer correlates
   queued input to its turn without a second disposition. The id travels
   through the runner (see "Execution-layer changes"), not a CLI-side
   parallel queue.
8. Two backpressure hops, both hcn's responsibility: harness to hcn is the
   runner's channel (`activeTurn.push` blocks past the channel high-water
   mark, `src/execution/channel.ts`); hcn to consumer is the stdout write
   (hcn MUST check `write()`'s return and await `drain` before the next
   event). Neither may buffer without bound.

## Execution-layer changes

These are the changes to `src/execution/` and `src/interpretation/` that
the wire contract needs. Each is small, each keeps the runner's existing
tests green, and each is covered by a new test.

1. **Id-carrying send (findings F4, F12).** `SessionHandle.send` becomes
   `send(input: { id: string; text: string }): SessionSendResult`.
   `pendingSends` holds `{ id, text }` instead of `text`. `startTurn`
   records the id that opened the turn; the turn iterable the runner yields
   carries that id. `finalize`'s "queued send(s) died" path reports the
   dropped ids, not just a count. Rationale: the consumer's id is the only
   stable correlation key, and a CLI-side parallel FIFO desyncs on a write
   failure at a boundary. The id lives with the text it belongs to.

2. **Per-turn stall watchdog in `openSession` (finding F1).**
   `openSession` reads `deps.stallMs` and arms a per-turn inactivity timer
   that rearms on any stdout or stderr chunk, the way `streamTurn` does
   (`src/execution/stream-turn.ts:339-357`). On expiry it ends the open
   turn with `done cause=stall` and a `failureFromTransport("stalled: ...")`,
   then signals the process and lets the exit path close the session with
   `closed.cause: "stall"`. `finalize` gains a `stall` arm. Rationale: the
   session runner has no watchdog today; without this, `closed.cause:
   "stall"` has no producer.

3. **Provider on session options (finding F2).** `OpenSessionOptions`
   gains `provider?: string`. `SessionOptions` and `buildSessionArgv`
   (`src/interpretation/argv.ts:194`) gain `provider`, validated and
   rendered through the same descriptor selector `buildLaunchArgv` uses
   (`src/knowledge/pi.ts:124`). A provider on a harness that does not
   express one refuses with `ArgvRefusalError` carrying `supportedBy`, the
   same as `hcn run`. Rationale: pi against a local provider is the
   lucid-v2 live lane, and the flag cannot reach the argv otherwise.

4. **Distinct write-failure signal (findings F7).** `writeUser` failure
   stops being folded into `SessionClosedError`. `send` returns
   `{ disposition: "rejected", reason: "write-failed" }`, the runner stops
   accepting sends and signals the child, and the exit path finalizes as
   usual. It must NOT mark the session dead at that point: the dead flag
   suppresses the very signal that ends the child, so close would hang.
   `send` after that throws `SessionClosedError`, which the CLI maps to
   `reason: "closed"`. Rationale: a broken pipe and a closed session are
   different remedies; a consumer must tell them apart.

5. **`closed.cause` producers (finding F3).** With items 2 and 4 in place,
   `finalize` can produce `clean`, `limit`, `crash`, `killed`, and `stall`.
   `failed` is produced only by the CLI's pre-spawn synthesis (S001/S002).
   `awaiting-input` is turn-scoped and is never a `closed.cause`. This RFC
   states that set as closed and complete for `closed.cause`.

No change to the reducer, the store, `HarnessEvent`'s kinds, or the
one-shot `streamTurn` path.

## Message Formats

### stdout: events

The stream type is `SessionEvent = HarnessEvent | SessionControlEvent`.
`HarnessEvent` is unchanged. The control events:

```ts
type SessionControlEvent =
  | {
      kind: "session";
      sessionId: string;          // the id hcn asked for (opts.sessionId); NOT the minted id
      harness: HarnessName;
      hcn: string;                // hcn package version, from src/cli/version.ts
      escalateQuestions: boolean; // the resolved value (args > config > default)
    }
  | {
      kind: "turn";
      turnId: string;             // `${sessionId}:turn-${n}`, n from 1
      id?: string;                // the send's id that opened this turn
    }
  | {
      kind: "disposition";
      id: string;                 // echoes the command's id
      disposition: "started" | "queued" | "rejected";
      reason?: string;            // present when rejected
    }
  | {
      kind: "closed";
      exitCode: number | null;    // process exit code; null on signal death
      cause: "clean" | "limit" | "crash" | "stall" | "killed" | "failed";
      failure?: FailureSummary;   // present when cause is not clean
    };
```

Field rules:

- `turnId` MUST match the `turnId` the runner logs in its `turn_start`
  boundary line, so stderr evidence and stdout events correlate.
- `turn.id` is the id of the `send` that opened the turn. It is present for
  every turn a consumer send opened, which today is every turn. A turn
  opened by anything else (reserved; no producer exists) omits `id`; a
  consumer MAY treat an absent `id` as a protocol error until a producer is
  specified.
- The `identity` event keeps its place: it arrives inside the first turn,
  because the runner holds pre-turn events until a turn opens. The `session`
  event is NOT a substitute for `identity`. `session.sessionId` is the id
  hcn asked for; `identity.sessionId` is the id the harness confirmed. For
  pi, whose descriptor mints the id (`sessionMode.idFlag: null`), the minted
  id is not known when the `session` line is written, so `session.sessionId`
  is always the caller-side handle and `identity.sessionId` is the minted
  id.
- `done` ends a turn; `closed` ends the process. A turn ended by the
  harness's turn-end record keeps `exitCode: null`. A turn cut short by the
  harness dying carries the process exit code, equal to the following
  `closed.exitCode`. `hcn run --json` is unchanged: one turn is one process
  there, so its `done` is the last event and no `closed` is written.
- `closed.cause` is exactly one of the six values in the type. `clean` is
  a consumer close where the harness exited 0 within the grace. `limit`,
  `crash`, `stall`, `killed` come from the runner's `finalize`. `failed`
  comes only from the CLI's pre-spawn synthesis (S001/S002). `closed.exitCode`
  is `null` on signal death (`killed`).

### stdin: commands

```ts
type SessionCommand =
  | { op: "send"; id: string; text: string }
  | { op: "answer"; id: string; text: string }
  | { op: "close" };
```

- `send` delivers `text` as the next user turn. `id` is consumer-minted,
  non-empty, and MUST be unique within the session; hcn echoes it and does
  not interpret it.
- `answer` is a `send` whose text hcn composes with the question-answer
  preamble the REPL uses today (`The user answered the question: "<q>"
  with: <text>. Continue accordingly.`), where `<q>` is the most recent
  `question` event's text. hcn MUST reject an `answer` when no turn in this
  session ended `awaiting-input`, with `reason: "no-open-question"`. The
  preamble is normalizer knowledge; a consumer MUST NOT need to re-derive
  it.
- A plain `send` after an `awaiting-input` turn is allowed. It opens a turn
  with no preamble. The difference from `answer` is exactly the preamble;
  use `answer` to answer, `send` to change the subject.
- `close` ends the session. hcn ends the harness's stdin, waits up to the
  existing close grace (`CLOSE_GRACE_MS`), escalates SIGTERM then SIGKILL
  as `openSession.close` does today, writes `closed`, and exits.
- stdin EOF is equivalent to `close`.
- `text` is an opaque string. hcn MUST pass it to `encodeSessionInput`
  unchanged apart from the escalation preamble; it MUST NOT trim, split, or
  interpret it.
- **Malformed is decided first, in every state.** A line that is not valid
  JSON, not an object, has an unknown `op`, or is a `send`/`answer` with a
  missing or empty `id` or a non-string `text`, is malformed. hcn MUST
  write `{"kind":"error","message":"malformed command: <detail>"}` on
  stdout, MUST NOT emit a `disposition` for it, and MUST NOT end the
  session. This rule takes precedence over the CLOSING/DEAD rejection rule:
  a malformed line in any state produces the `error`, never a `disposition`.

### Disposition semantics

| disposition | meaning | what follows |
|---|---|---|
| `started` | no turn was open; the text was written to the harness and a turn opened | a `turn` event with this `id`, then the turn's events, then `done` |
| `queued` | a turn was open; the text is held | at the boundary, a `turn` event with this `id` |
| `rejected` | the text was not and will not be delivered | nothing more for this id; `reason` says why |

`rejected` reasons and what each means for the session:

- `closed`: the session is closing or the harness is already dead. The
  session is ending regardless; the rejection does not cause it.
- `no-open-question`: an `answer` arrived with no `awaiting-input` turn to
  answer. The session stays live.
- `write-failed`: the harness's stdin write failed. The session moves to
  dead and a `closed` follows; the rejection reports the input that was
  lost. This is the one rejection that coincides with the session ending,
  and it does not itself end the session: the write failure does.

### `hcn inspect <harness> --capabilities`

```
hcn inspect <harness> --capabilities [--model <id>] [--mode <headless-turn|headless-session|interactive>]
```

Prints one JSON object, the `CapabilityResult` from `capabilitiesOf`:

```json
{"vision":true,"images":true,"streaming":"token","session":true,"source":"curated","confidence":"medium"}
```

- `--capabilities` and `--mode` are new flags on `parseCommonFlags`
  (`src/cli/args.ts`). `--mode` takes one of the three `HarnessMode`
  strings; any other value refuses exit 2 naming the supported set.
- `--mode` defaults to `headless-turn`.
- `--model` absent means the harness default model (curated). A model
  outside the vocabulary degrades to `source: "unknown"`, as
  `capabilitiesOf` does today (`src/interpretation/capabilities.ts:33-45`).
- `--capabilities` is mutually exclusive with `--argv`; combining them
  refuses exit 2. `--capabilities` needs no prompt; `inspect` already gates
  the prompt-injection check on `--argv` only (`src/cli/inspect.ts:24`), so
  a bare `hcn inspect <h> --capabilities` reaches the capabilities path.
- No spawn. Pure read of the descriptor.

### `--stall <seconds>` on `hcn session`

An inactivity budget per turn, enforced by the `openSession` watchdog added
in "Execution-layer changes" item 2. When a turn produces no output for the
budget, the runner ends the turn `done cause=stall`, signals the process,
and the exit path writes `closed cause=stall`. `0` disables. No default. A
consumer that needs liveness detection sets it; one that does not leaves it
unset.

### Flags accepted

`hcn session <harness> --json` accepts every flag `hcn session` accepts
today (`--model`, `--session-id`, `--cwd`, `--escalate-questions` /
`--no-escalate-questions`) plus `--json`, `--stall`, and `--provider`.

`--provider <value>` follows the `hcn run` rule: pi only, validated the
same way, refused on any other harness with the same `supportedBy` fields.
It reaches the argv through the session-options change in "Execution-layer
changes" item 3. It exists so a session can run pi against a local provider
(LM Studio). Parity with the rest of `hcn run`'s flags (`--effort`,
`--tools`, `--skills`, `--access`, `--env`) is out of scope; see Open
Questions.

## State Machine

Session states, from the consumer's view of stdout:

```
OPENING   -> LIVE       (on: session event written)
OPENING   -> REFUSED    (on: refusal before spawn; failure + closed written; exit 2)
LIVE      -> LIVE       (on: send/answer -> disposition; turn ... done)
LIVE      -> CLOSING    (on: close command, stdin EOF, SIGINT, SIGTERM, consumer stdout EPIPE)
LIVE      -> DEAD       (on: harness exit, stall, crash, write-failed)
CLOSING   -> CLOSED     (on: harness exit within grace; closed cause=clean)
CLOSING   -> CLOSED     (on: grace elapsed; SIGKILL; closed cause=killed, exitCode null)
DEAD      -> CLOSED     (on: closed event written with the runner's cause)
```

Turn states inside LIVE:

```
IDLE      -> OPEN       (on: send when no turn is open -> disposition started, turn event)
OPEN      -> OPEN       (on: send -> disposition queued)
OPEN      -> IDLE       (on: done, pending queue empty)
OPEN      -> OPEN       (on: done, pending queue non-empty -> next turn event with the queued id)
OPEN      -> ASKED      (on: done cause=awaiting-input)
ASKED     -> OPEN       (on: answer -> preamble composed; or send -> no preamble; disposition started, turn event)
```

Invalid and edge transitions:

- A well-formed command received in CLOSING or DEAD gets `disposition:
  rejected, reason: closed`. A malformed line in any state gets an `error`
  instead (see "Malformed is decided first").
- A `close` received twice is idempotent; the second is ignored.
- **Consumer stdout closes early (EPIPE).** In `--json` mode hcn MUST treat
  a stdout EPIPE as a close: run `close()` (grace, SIGTERM, SIGKILL), then
  exit 1. It MUST NOT `process.exit(0)` the way the current top-level EPIPE
  guard does (`src/cli/index.ts:13`); the session's child must not be left
  to notice stdin EOF on its own.
- hcn MUST NOT open a new harness process for any reason. A dead session is
  reported and the consumer decides whether to spawn a new one.

Timeouts:

- Close grace: `CLOSE_GRACE_MS` (5000 ms) between stdin end and SIGTERM,
  then the runner's `KILL_GRACE_MS` (5000 ms) before SIGKILL. Unchanged.
- Stall: `--stall`, per turn, no default (Execution-layer changes item 2).

## Error Handling

hcn has one failure taxonomy; this RFC adds no new classes. Where a thing
can go wrong:

```
S001 - refusal before spawn (severity: critical)
       e.g. no-session-mode, unknown-model, unknown-provider, invalid flag,
       config error.
       The session --json branch synthesizes the terminal pair itself (the
       run --json path in src/cli/refuse.ts writes failure + done; the
       session path writes failure + closed instead):
         {"kind":"failure","class":"rejected",...}
         {"kind":"closed","exitCode":null,"cause":"failed","failure":{...}}
       process.exitCode is set to 2 only AFTER the closed line is flushed.

S002 - spawn failure (severity: critical)
       The harness binary is missing or could not start (SessionSpawnError).
       The session branch writes failure class=transport, then closed
       cause=failed, then sets exit 1 after the closed line is flushed.

S003 - harness died mid-session (severity: critical)
       Crash, limit, stall, or killed. The open turn (if any) gets its done
       with the runner's cause; then closed with the same cause and the
       reduced failure. Exit 1. Each queued send that died is rejected
       (reason: closed) with its id, from the runner's dropped-id report,
       before closed is written.

S004 - malformed command (severity: warning)
       Output: error event naming the line's problem. Session continues.
       No disposition. Decided before the state-based rejection rule.

S005 - well-formed send while closing or dead (severity: warning)
       Output: disposition rejected, reason: closed.

S006 - answer with no open question (severity: warning)
       Output: disposition rejected, reason: no-open-question. Session live.

S007 - stdin write to the harness failed (severity: critical)
       Output: disposition rejected, reason: write-failed (the runner's new
       signal, Execution-layer changes item 4); the session stops accepting
       sends, the child is signalled, and a closed follows.
       The disposition's reason IS the signal on the wire. The runner also
       raises an error event, but a write failure happens between turns and
       the runner holds between-turn events for the next turn - which a
       broken pipe means never comes - so that event is logged as dropped,
       not delivered. A consumer branches on the reason, never on the error.
```

Retry policy: hcn never retries. `closed.failure.retryable` tells the
consumer whether a fresh session is worth opening (`rate-limit`,
`usage-limit`, `quota`, `auth`, `transport`, `unavailable`) or not (`task`,
`budget`, `rejected`, `native`, `timeout`).

Exit codes:

| exit | when |
|---|---|
| 0 | `closed.cause` is `clean` |
| 1 | `closed.cause` is any other value, or a consumer stdout EPIPE |
| 2 | refusal before spawn (S001) |

The exit code is always set after the terminal stdout line is flushed, so a
consumer that reads to `closed` never loses the last line to hcn's exit.

## Security Considerations

- **Trust boundaries.** The consumer is trusted: it runs under the same
  user and already holds whatever the harness can reach. hcn adds no
  privilege. The harness's output is untrusted text; the `hcn-question`
  block detector is the one place hcn interprets it, unchanged by this RFC.
- **Input validation.** Commands are parsed with a strict shape check
  (`op`, `id`, `text` types) before any field is used, and a malformed line
  is rejected without touching the harness. `text` is never interpolated
  into argv or a shell; it goes through `encodeSessionInput` as a JSON
  string value. `id` is echoed as data and MUST NOT be used as a path, key,
  or log format string.
- **Permissions.** None beyond what `hcn session` needs today. The harness
  authenticates under the user's own session; hcn holds no credentials.
- **Blast radius.** A bug in the command parser can at worst reject input
  or end the session; it cannot start a second harness. A bug in the stall
  watchdog can only end a turn early, which the consumer sees as
  `cause: stall`.
- **Data sensitivity.** Prompt text flows through hcn's stdin and the
  harness's stdin only. hcn MUST NOT write `text` to stderr boundary logs;
  the runner logs send lengths and ids, not text
  (`src/execution/open-session.ts`, the `sends_dropped` log). The argv
  redaction stays in force. A consumer that carries secrets in its own
  records keeps them on its side of the pipe; nothing in this protocol asks
  for them.
- **Injection resistance.** The escalation preamble is composed by hcn, not
  by the consumer, so a consumer cannot be tricked into composing it
  wrongly; and a harness message cannot inject a command, because stdin and
  stdout are separate pipes and hcn never reads its own output.
- **Env.** `HERDR_ENV` is deleted for the child, as today, so a harness
  never believes it is in the user's Herdr pane.

## Versioning

- Event kinds are additive. A consumer MUST ignore a `kind` it does not
  recognize and keep reading until `closed`. This extends the README's
  existing rule from `done` to `closed` for sessions.
- `session.hcn` carries the package version (from `src/cli/version.ts`) so a
  consumer can refuse a version below its floor before sending anything.
- The four control kinds and the three command ops are the v1 surface of
  this protocol. Removing or renaming one is a breaking change under
  release-please (`feat!`).
- The `send` signature change (`send({id, text})`) and the new
  `OpenSessionOptions.provider` are internal API changes to the execution
  layer; they ship in the same release as the CLI surface.
- `hcn session` without `--json` is unchanged. The REPL keeps its prose
  stderr disposition; it is a human surface.

## Implementation Notes

Order the work as the execution layer first, then the CLI, so each layer's
tests exist before the layer above depends on it.

Execution layer (`src/execution/`, `src/interpretation/`):

- `send({id, text})`, `pendingSends: {id, text}[]`, id on the yielded turn,
  dropped-ids on `finalize`'s "queued send(s) died" path.
- `stallMs` watchdog in `openSession`, a `stall` arm in `finalize`.
- `provider` on `OpenSessionOptions`, `SessionOptions`, `buildSessionArgv`,
  with the pi selector and the refusal for other harnesses.
- `write-failed` as a distinct `send` result; the CLI maps
  `SessionClosedError` to `closed` and the new result to `write-failed`.
- Each change carries a runner test; the existing `openSession` tests stay
  green.

CLI layer (`src/cli/`):

- `src/cli/session.ts` grows a `--json` branch that replaces the readline
  loop with two pumps: stdin lines -> commands, runner turns -> stdout
  events. The stdin pump keeps reading while a turn is open, so `queued`
  dispositions are timely; it does not park on the turn iterable (the REPL's
  single-readline design does park, `session.ts:129-135`).
- The `session` event is written after `openSession` returns and before the
  stdin pump starts.
- `turn.id` correlation reads the id off the runner's yielded turn; there is
  no CLI-side parallel FIFO.
- S001/S002 synthesis lives in the session branch: it writes the
  `failure` + `closed` pair, then sets the exit code. Factor the pair-writer
  so `refuse.ts` and the session branch share it.
- `writeEventNdjson` (`src/cli/render.ts`) MUST check `write()`'s return and
  await `drain`; today it fires and forgets.
- The stdout EPIPE handler for `--json` sessions runs `close()` and exits 1,
  distinct from the process-wide EPIPE guard in `src/cli/index.ts`.
- `--capabilities` and `--mode` added to `parseCommonFlags`
  (`src/cli/args.ts`) and handled in `src/cli/inspect.ts`.
- Tests: drive `hcn session claude --json` in-process with the existing
  `fakeSpawner` feeding captured claude stream-json, assert the exact
  stdout line sequence, and capture one real run into `test/fixtures/` as
  evidence, under the same no-scrub rule. A write-failure test closes the
  child's stdin between turns and asserts `reason: write-failed`.
- Bun and Node both run the CLI; the stdin line reader must handle a final
  line without `\n`.
- Document the surface in README (CLI section), `SESSION_HELP`, and the hcn
  skill's reference (`~/.agents/skills/hcn/references/reference.md`), which
  the readiness audit named as the places that say nothing about queueing
  today.

## Open Questions

Decided 2026-08-22, recorded so the path is visible:

- **Scope of the runner change**: widened to the execution layer. The five
  blocking review findings each needed an `openSession` or descriptor
  change; the alternative (a frozen runner, stall and correlation owned by
  the CLI) was rejected for the fragile lock-step FIFO the review named.
- **`--provider` on `hcn session`**: added now, pi only, same validation as
  `hcn run`, reaching the argv through the session-options change.
- **Session end event**: `closed`. `done` stays turn-scoped. In `run` the
  two coincide and only `done` is written.

Still open:

1. **Full session flag parity with `hcn run`** (`--effort`, `--tools`,
   `--skills`, `--access`, `--env`) through the same
   `resolveEffectiveOptions` path `run` uses. Not in this RFC because it
   touches option resolution on resume (audit F-15). Decided by: the
   package owner, as its own RFC.
2. **`--stall` on `hcn run` too.** This RFC puts `--stall` on sessions
   only; `run` already has `--timeout` (a wall clock) and a per-turn stall
   there is a separate decision. Machine-made default: sessions only.
3. **Transcript decode for interactive consumers.** lucid-v2's interactive
   rung has a transcript tail that calls `contentEventsOf`. It has no
   production caller today and RFC-02 removes it. When a caller exists, the
   shape would be `hcn decode <harness>`: raw harness records on stdin,
   `ContentEvent` NDJSON on stdout. Deferred until then. No default needed.

## What changed in revision 2

One line per review finding; the review file holds the full text.

- F1 (blocking, stall watchdog): Execution-layer changes item 2; Scope now
  includes it; `--stall` section rewritten to name the watchdog.
- F2 (blocking, provider): Execution-layer changes item 3; Flags accepted
  points at it.
- F3 (blocking, closed.cause producers): Execution-layer changes item 5;
  `closed.cause` type narrowed to six values; field rule states the
  producer of each and excludes `awaiting-input`.
- F4 (blocking, turn.id FIFO): Execution-layer changes item 1; rule 7 and
  the `turn.id` field rule now read the id from the runner.
- F5 (blocking, pre-spawn JSON path): S001/S002 rewritten; Implementation
  Notes give the session branch the pair-writer; exit set after flush.
- F6 (major, stdout EPIPE): State Machine gains the EPIPE transition;
  Implementation Notes give it a handler distinct from `index.ts`.
- F7 (major, write-failed): Execution-layer changes item 4; Disposition
  semantics rewritten so `write-failed` is distinct and the "never ends the
  session" wording is fixed.
- F8 (major, backpressure hops): rule 8 now names both hops.
- F9 (major, malformed in CLOSING): "Malformed is decided first" rule added.
- F10 (major, done.exitCode on death): field rule states null except the
  death path.
- F11 (major, --mode/--capabilities parsing): `hcn inspect` section and
  Implementation Notes add them to `parseCommonFlags` with validation; the
  downgraded prompt-gating claim is noted as not holding.
- F12 (minor, per-send rejects on death): S003 and Execution-layer changes
  item 1 give the runner the dropped ids.
- F13 (minor, session.sessionId wording): field rule now says caller-side
  handle, with the pi minted-id case spelled out.
- F14 (minor, killed exitCode null): State Machine and `closed` field rule
  state the pair.
- F15 (minor, ASKED send vs answer): stdin commands and State Machine state
  the difference is the preamble.
- F16 (minor, undefined terms): Terminology gains `HarnessName`, `ExitCause`,
  `FailureSummary`, `CapabilityResult`, `escalation preamble`.
- F17 (minor, turn.id absent): field rule says a consumer MAY treat an
  absent id as a protocol error until a producer exists.
- F18 (minor, hcn version example): `session.hcn` now points at
  `src/cli/version.ts` as the source.

## References

### Normative

- `src/execution/open-session.ts` - `SessionHandle`, `send`, `pendingSends`,
  turn pump, `finalize`, close grace; the runner this RFC changes.
- `src/execution/stream-turn.ts` - the `stallMs` watchdog pattern item 2
  ports.
- `src/execution/events.ts` - `HarnessEvent`, `ExitCause`, `DROPPABLE_KINDS`.
- `src/execution/failure.ts` - `FailureSummary`, `FailureClass`,
  `failureFromTransport`.
- `src/interpretation/argv.ts` - `buildSessionArgv`, `SessionOptions`.
- `src/interpretation/capabilities.ts` - `capabilitiesOf`.
- `src/knowledge/descriptor.ts` - `HarnessMode`, `sessionMode`.
- `src/knowledge/pi.ts` - the provider selector and `sessionMode.idFlag: null`.
- `src/cli/run.ts`, `src/cli/render.ts`, `src/cli/refuse.ts`,
  `src/cli/exit-codes.ts`, `src/cli/args.ts`, `src/cli/inspect.ts`,
  `src/cli/index.ts` - the CLI surfaces this RFC changes.
- README, section "Failure taxonomy" and "Status" (D-001).

### Informative

- `docs/rfc/01_machine-session-surface-hcn-session-json.review-draft-2026-08-22.md`
  - the review this revision answers.
- `docs/audits/2026-08-21-readiness/report.md` - finding at line 1575
  (structured disposition gap) and F-15 (resume skips option resolution).
- lucid-v2 `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` - the
  first consumer.
- lucid-v2 `PLAN.md` Part 0 - the original runner contract this package
  grew from.
