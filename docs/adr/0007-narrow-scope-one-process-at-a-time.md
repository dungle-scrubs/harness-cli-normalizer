# hcn supervises one process at a time, and nothing wider

hcn normalizes four harness interfaces and supervises the runs it starts. The
supervision is bounded deliberately: hcn watches a process while it runs, and
anything spanning more than one process belongs to the caller. This is the test
a proposed feature must pass before it is added.

## Why this exists

Without a stated scope there was no way to answer "does this belong in hcn?".
Features were judged one at a time, each reasonable alone, and the product drifted
toward supervising work rather than normalizing interfaces. `hcn session --json`
was built without the question being asked, and issue #49 (a correlation id
spanning several runs) sat open because nothing could settle it either way.

## The test

A feature belongs in hcn when it does one of two things:

1. **Normalizes** something the harnesses each do differently - expressing them
   in one vocabulary, deciding nothing.
2. **Supervises one process** hcn itself spawned, for as long as it runs.

A feature that tracks, correlates, or stores anything across process boundaries
does not belong. That is the caller's job, and the caller is the only party that
knows what a "unit of work" means.

## Consequences

- **Issue #49 is out of scope.** Correlating several runs into one job is not
  watching one process. hcn emits nothing to relate two invocations; a caller
  that wants that mints its own id and threads it through.
- **A store index mapping jobs to sessions is out**, for the same reason.
- **`hcn session` stays in.** claude (`-p --input-format stream-json`) and pi
  (`--mode rpc`) both have a native multi-turn headless channel, using two
  unrelated mechanisms. Expressing both as one shape is normalization, and codex
  and muse correctly refuse.
- **hcn's own send queue comes out.** claude queues mid-turn sends natively
  (`claude-code.ts:49`) and pi has `steer`/`follow_up` for it (`pi.ts:52`, which
  records that hcn declined them to queue itself). Holding the caller's input is
  state hcn does not need to own, on top of a capability both harnesses already
  have. With no hcn queue there are two outcomes rather than three: the write
  reached the harness, or the pipe was broken. `queued` goes with it; `rejected`
  stays for a closed session.

  Why it was there: `hcn session` began as a REPL for a human, printing
  `disposition: queued (turn in progress)` to stderr as prose. The `--json` work
  turned that prose into structured fields rather than asking whether hcn should
  be holding the input at all. The queue predates the machine surface and was
  carried forward unexamined.
- **The stall clock stays.** It watches one process for as long as that process
  runs, which is inside the boundary.

## Rejected alternative

The wide reading - hcn supervises a unit of work, however many processes that
takes - was considered. It makes #49 core rather than out of scope, and pulls in
a store index and cross-run state after it. Rejected because it makes hcn
responsible for a concept only the caller can define, and because every consumer
would then depend on hcn's model of what a job is.
