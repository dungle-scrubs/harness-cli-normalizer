# T02 - Tracer bullet: hcn session --json happy path

Status: open
Blocked by: 01

## What to build

A program can drive one full turn of a persistent session over pipes. It
spawns `hcn session <harness> --json`, reads one JSON object per line on
stdout, and writes one JSON command per line on stdin. The first line names
the session. A send is answered with a disposition. The turn that opens
reports the send's id, then streams the harness's events, then a
turn-scoped done. Closing the session (a close command or end of input)
produces one final closed line, then exit 0.

Stdout carries JSON only in this mode: no prompt, no rendered prose. hcn
does not outrun a slow reader: it waits for each line to flush before it
writes the next.

## Acceptance criteria

- [ ] `--json` on the session command switches to the machine surface: a
      stdin command pump and a stdout event pump, no human prompt on stdout.
- [ ] The first stdout line is a session event carrying the id hcn asked
      for, the harness, the hcn version, and the resolved question-escalation
      value.
- [ ] A send with no turn open produces a disposition "started", then a turn
      line carrying that send's id, then the harness's turn events, then a
      turn-scoped done.
- [ ] A close command or end of stdin produces one closed line, then exit 0
      on a clean harness exit within the close grace.
- [ ] hcn waits for a stdout line to flush before writing the next.
- [ ] Proven end to end against a scripted fake harness with the exact
      stdout line sequence, plus one captured real run kept as a fixture.
