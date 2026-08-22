# T09 - hcn inspect --capabilities and --mode

Status: open
Blocked by: none

## What to build

A program can ask what a harness, model, and mode can do, without spawning
anything. `hcn inspect <harness> --capabilities` prints one JSON object of
the capability record. `--mode` picks the integration mode and defaults to
the one-shot turn mode; a bad mode is refused naming the valid set.
`--capabilities` needs no prompt and cannot be combined with the argv
preview.

## Acceptance criteria

- [ ] `hcn inspect <h> --capabilities` prints the capability record as one
      JSON object, no spawn.
- [ ] `--mode` accepts the three integration modes, defaults to the one-shot
      turn mode, and refuses any other value naming the valid set exit 2.
- [ ] An absent model reads as the harness default; a model outside the
      vocabulary degrades the record source to unknown.
- [ ] `--capabilities` with the argv preview is refused exit 2.
- [ ] `hcn inspect <h> --capabilities` with no prompt reaches the
      capabilities path (no prompt validation in the way).
