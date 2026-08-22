# T05 - Stall watchdog and --stall

Status: done
Blocked by: 02

## What to build

A program can bound how long a session turn may go silent. With `--stall
<seconds>` set, a turn that produces no output for that long is ended by the
runner, the harness process is stopped, and the session closes reporting a
stall. Without the flag there is no inactivity limit. The one-shot run
surface is unaffected.

## Acceptance criteria

- [ ] The session runner enforces a per-turn inactivity budget when one is
      set, rearming on any output.
- [ ] On expiry the open turn ends reporting a stall, the process is stopped,
      and the session closes reporting a stall, exit 1.
- [ ] `--stall 0` and an absent flag both mean no limit.
- [ ] Proven with a fake harness that goes silent plus a controlled clock:
      the turn and the session both report a stall.
- [ ] The existing session and run behaviour with no stall set is unchanged.
