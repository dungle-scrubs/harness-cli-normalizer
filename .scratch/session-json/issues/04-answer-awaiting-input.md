# T04 - answer op and awaiting-input turns

Status: done
Blocked by: 02

## What to build

When a turn ends by asking the caller a question, the program can answer it
over the same session. An answer command carries the caller's text; hcn
wraps it in the question-answer instruction the human REPL already uses, so
the program never composes that wrapper itself. A plain send after a
question is also allowed and carries no wrapper - it changes the subject
instead of answering. An answer sent when no question is open is refused,
and the session stays live.

## Acceptance criteria

- [ ] A turn that ends awaiting input is visible as such to the program.
- [ ] An answer command opens the next turn with the question-answer wrapper
      composed by hcn.
- [ ] A plain send after an awaiting-input turn opens a turn with no wrapper.
- [ ] An answer with no open question is answered with disposition
      "rejected", reason no-open-question, and the session stays live.
- [ ] Proven with an awaiting-input fixture: the answer turn, the plain-send
      turn, and the reject case.
