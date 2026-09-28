# The run lifecycle observer contract

ADR 0011. `hcn run` streams its own lifecycle to the command named by
`HCN_OBSERVER` as `hcn-observer/1` NDJSON on the observer's stdin. hcn has
no knowledge of what the command does with the stream; the reflection
intake ships one such observer (`bin/hcn-observer.mjs`, whose adapter
commits the records to the local outbox as observation envelopes).

## Enablement

- `HCN_OBSERVER` holds an absolute path.
- Unset, empty, or relative means no observer: no records, no
  `HCN_INVOCATION_ID` export, and the run behaves byte for byte as
  today. There is no flag and no config-file key.
- Enablement is decided from the string alone; hcn does no filesystem
  work on this path. hcn attempts to spawn the command and never reads
  its exit code. A path that cannot spawn (missing file, directory,
  not executable - ENOENT, EACCES) produces an asynchronous error that
  hcn absorbs, and observation ends silently.
- The observer's exit code (whatever it means to its owner) is never
  read by hcn. Exit 7 (the intake's gate not passed) is a normal
  outcome.

## Stream

One JSON object per line, in this order.

1. Exactly one `started` record, written when the harness child spawns:

   ```json
   {"record":"started","schema":"hcn-observer/1","invocationId":"0f0e0d0c-1111-4222-8333-444455556666","at":"2026-09-28T03:00:00.000Z","command":"run","harness":"claude","cwd":"/workspace","hcnVersion":"0.8.0"}
   ```

   - `invocationId` is minted before the harness spawn; the harness child
     receives the same value as `HCN_INVOCATION_ID` (hcn's value wins over
     a caller's `--env`).
   - `at` is taken at the same moment, ISO date-time with zone.
   - `cwd` is absolute: the run's `--cwd`, else the invocation directory.

2. Zero or more `event` records, one per run event hcn emits, except the
   droppable kinds (`token`, `progress`). The `event` member is the event
   exactly as `--json` prints it, so records carry no transcript text
   except inside `event` records, which are the run's own output:

   ```json
   {"record":"event","at":"2026-09-28T03:00:02.500Z","event":{"kind":"identity","sessionId":"eb04301d-8756-4a8b-ae3e-aac0e71f7265","authority":"harness-minted","capabilities":{}}}
   ```

   The synthetic `failure` and `done` of a transport failure are sent here
   too, whatever `--json` says; the synthetic `done` carries no
   `escalation` record, matching hcn's stdout bytes on that path.

   A single record whose serialized form exceeds 1 MiB is replaced by a
   short skip marker:

   ```json
   {"record":"skipped","at":"2026-09-28T03:00:02.500Z","reason":"oversize"}
   ```

   Consumers count skips as a coverage gap; the run's own `done` still
   decides the outcome.

3. Exactly one terminal `done` event record (the run's `done`, carrying
   `exitCode` and hcn's own `cause`; a killed run reports
   `cause: "killed"` and no separate interruption field). After it, hcn
   closes the stream. EOF without a `done` means the run itself ended
   without reaching one (hcn was killed harder than it could observe, or
   the machine lost power): consumers treat that as an interrupted run.

## Delivery rules

- The observer command runs detached, with hcn's own environment
  unchanged. That is how a parent's `REFLECT_INTAKE_WORK_PARENT` reaches
  the reflection adapter; an inherited `HCN_INVOCATION_ID` is ignored, an
  hcn run started inside another hcn run is its own invocation.
- Writes are fire-and-forget. If the observer stops draining past 8 MiB
  of queued records, the pipe is destroyed and observation ends silently.
- A write or spawn error ends observation silently.
- hcn never logs, retries, waits for a flush, or changes an exit code
  because of the observer. The observer's own exit status is never read.

## Records never contain

- Transcript text, tool output, or prompt text - except inside `event`
  records, whose `event` member is the run's own output exactly as
  `--json` would have printed it.
- Anything about envelopes, outboxes, authorities, gates or reflection.
  hcn does not know these exist.
