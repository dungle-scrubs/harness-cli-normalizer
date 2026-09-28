# The run lifecycle observer is a record stream, not a reflection client

Status: accepted 2026-09-28.

`hcn run` can stream its own lifecycle - one `started` record, each run
event, the terminal outcome - to a command named by the `HCN_OBSERVER`
environment variable, as `hcn-observer/1` NDJSON on the observer's stdin.
The harness child receives the invocation id as `HCN_INVOCATION_ID`. The
design decision is what hcn does NOT do: hcn has no knowledge of
envelopes, outboxes, authorities, gates or reflection. It writes records
to a command it does not interpret, and nothing under `src/execution`
changes.

## Why this exists

Slice 11 of RFC-03 needs every standalone headless `hcn run` to appear as
one review item keyed by its invocation
([#287](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/287)).
Two shapes were considered for the hcn half.

Option C made hcn spawn the reflection intake's `capture` command and
build observation envelopes for it. It shipped in 0.8.0. It coupled hcn
to the intake's envelope vocabulary and delivery mechanics: hcn minted
authority-scoped event ids, rendered evidence packages, and carried
enablement policy for a pipeline it does not run. Every intake-side
contract change would have reached into hcn.

The observer shape (Kevin, D75) keeps each repository on its own side of
the seam. hcn owns only what it already knows: its invocation id, its
events, its exit cause. The record stream is hcn's own vocabulary
(`hcn-observer/1`), not the intake's. The envelope adapter, the outbox
commit, the gate check and the authority handling live in the
reflect-intake repository (`src/producers/hcn/`, merged as reflect-intake
PR 28), which already owns that schema. A third consumer - a debugger, an
audit log, another intake - can read the same stream without hcn
changing.

## Shape

- `HCN_OBSERVER` holds an absolute path. Unset or relative means no
  observer and no behavior change; there is no flag and no config key.
  hcn does no filesystem work on the enablement path: a path that cannot
  spawn fails asynchronously, and observation ends silently.
- On the launch spawn hcn mints the invocation id, exports it to the
  harness child as `HCN_INVOCATION_ID`, spawns the observer detached and
  unref'd, and writes the records fire-and-forget. Later spawns (the
  approval helper) carry none of this.
- Records: one `started`, one per non-droppable run event, one terminal
  `done`. No transcript text except inside `event` records, which carry
  the run's own output.
- The observer can never fail or slow the run: spawn and write errors end
  observation silently, a stalled reader is cut off at 8 MiB, and no exit
  code or log line changes because of it. The observer's exit status is
  never read - the intake's gate refusing (exit 7) is a normal outcome
  that leaves the run untouched.

## Consequences

- Enablement is per machine and per deployment: the variable is set only
  where an observer is installed and the intake's backup gate has passed.
  The intake side refuses automatic capture until then regardless
  (reflect-intake PR 26), so the two layers fail safe independently.
- The record contract is versioned in the stream itself
  (`"schema":"hcn-observer/1"`); a future `hcn-observer/2` can coexist by
  the observer's own negotiation, with no hcn release.
- `hcn session` and `hcn interactive` are out of scope here; directly
  launched interactive sessions are captured by native harness hooks
  (RFC-03 slices 12 and 15). A follow-up ticket covers `hcn session` if
  the program needs it.
