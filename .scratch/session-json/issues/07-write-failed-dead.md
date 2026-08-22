# T07 - write-failed disposition and session death

Status: open
Blocked by: 02, 03

## What to build

A program can tell a broken pipe apart from a closed session. When a send
cannot be written to the harness because its input pipe is gone, the send is
answered with disposition "rejected", reason write-failed, the runner
surfaces its own error, and the session dies with a closed line to follow. A
send to an already-closing or already-dead session still reports reason
closed. The two reasons carry different remedies, so they stay distinct.

## Acceptance criteria

- [ ] A stdin write failure to the harness yields disposition "rejected",
      reason write-failed, distinct from reason closed.
- [ ] The runner surfaces its own error for the failure and the session moves
      to dead, followed by a closed line.
- [ ] A send while closing or already dead still reports reason closed.
- [ ] Proven with a fake harness whose input pipe closes between turns:
      write-failed, then closed.
