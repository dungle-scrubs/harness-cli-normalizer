# T08 - Terminal paths: refusal, spawn failure, EPIPE

Status: open
Blocked by: 02

## What to build

A program always sees a terminal line and the exit code always follows it.
Three cases:

- hcn refuses the invocation before spawning (no session mode, unknown
  model, unknown provider, a bad flag, a config error): the machine surface
  writes a failure line then a closed line reporting failed, and exits 2.
- The harness binary is missing or cannot start: a transport failure line,
  then a closed line reporting failed, exit 1.
- The program closes its own read end mid-session: hcn closes the session
  (grace, then signal) and exits 1, rather than exiting silently and leaving
  the harness to notice on its own.

In every case the exit code is set only after the terminal line has flushed,
so a program reading to the closed line never loses it.

## Acceptance criteria

- [ ] A pre-spawn refusal on the machine surface writes failure then closed
      (failed) and exits 2.
- [ ] A missing or unstartable harness writes a transport failure then closed
      (failed) and exits 1.
- [ ] A consumer that closes its stdout read end causes hcn to close the
      session and exit 1, having signalled the harness.
- [ ] The exit code is set after the terminal line is flushed.
- [ ] The failure-plus-closed writer is shared with the one-shot refusal
      path, not duplicated.
- [ ] Proven: a no-session-mode harness, a missing binary, and a
      read-end-closed consumer.
