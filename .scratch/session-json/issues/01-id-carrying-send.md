# T01 - Prefactor: id-carrying send in the session runner

Status: open
Blocked by: none

## What to build

The persistent session runner carries the consumer's input id alongside the
input text, from the moment a send arrives to the turn that consumes it and,
if the session dies, to the report of what was lost. Today the runner keeps
input text only, so nothing downstream can say which turn a given input
opened. After this ticket a caller that hands the runner an id gets that id
back on the turn the input opened, and on the loss report if the input died
queued.

This is a prefactor: it makes the `--json` surface's turn/​input correlation
a lookup instead of a fragile parallel bookkeeping on the CLI side. The
existing human REPL keeps working, updated to pass a minted id.

## Acceptance criteria

- [ ] A send takes an id and text together; the runner stores both while the
      input waits.
- [ ] The turn a send opens reports that send's id.
- [ ] When the session dies with inputs still queued, the loss report names
      the id of each lost input, not just a count.
- [ ] The existing interactive REPL still drives a session (it passes a
      minted id).
- [ ] The existing session runner tests pass; a new test proves a turn
      reports its opening send's id and the loss report lists ids.
