# T03 - Queued sends and turn correlation

Status: done
Blocked by: 02

## What to build

A program can send input while a turn is still running, and later tell which
turn consumed it. A send that arrives with a turn open is held and answered
with a disposition "queued". When the running turn ends, the held input
opens the next turn, and that turn line carries the held input's id. The
program never needs a second disposition to make the match.

## Acceptance criteria

- [ ] A send while a turn is open is answered with disposition "queued".
- [ ] Every send is answered with exactly one disposition, in the order the
      sends arrived.
- [ ] At the turn boundary the held input opens the next turn, and the turn
      line carries that input's id.
- [ ] The stdin pump keeps reading while a turn is open, so a queued
      disposition arrives without waiting for the turn to end.
- [ ] Proven with a two-turn fake-harness fixture: queued disposition, then
      the next turn line with the matching id.
