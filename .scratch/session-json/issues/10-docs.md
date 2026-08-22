# T10 - Document the machine session surface

Status: done
Blocked by: 02, 05, 06, 08, 09

## What to build

The three places a reader learns the CLI describe the machine session
surface: the README CLI section, the session command's own help, and the
hcn skill reference. Between them they state the command and event schema,
the disposition rule, close and exit codes, `--stall`, `--provider`, and
`--capabilities`. The readiness audit named these surfaces as the ones that
say nothing about queueing today.

## Acceptance criteria

- [ ] The README CLI section documents `hcn session --json`: the stdin
      command shapes, the stdout event kinds, disposition, close, exit codes.
- [ ] The session command help documents `--json`, `--stall`, and
      `--provider`.
- [ ] The hcn skill reference (~/.agents/skills/hcn/references/reference.md)
      documents the session event schema and the disposition rule.
- [ ] `--capabilities` is documented on the inspect surface.
