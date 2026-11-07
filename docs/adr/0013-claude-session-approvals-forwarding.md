# The native-approvals responder forwards Claude session requests

Status: accepted 2026-11-07. The maintainer asked for this widening in the
request itself ("1 do it", 2026-11-07, recorded in issues #454 and #455);
ADR 0008's freeze requires that ask, and this ADR records it.

## What changed

The native-approvals responder - the supervising part ADR 0008 names first
among its growth risks - gained a second lane. Until now it answered Codex
permission requests itself under `hcn run codex --json --native-approvals`:
hcn offered the choices, consumed decisions, and owned the answer.

The new lane is the opposite direction. Under
`hcn session claude --json --native-approvals` hcn arms Claude's native
permission channel (`--permission-prompt-tool stdio`, verified 2.1.319) and
FORWARDS each `can_use_tool` control request to the session host as an
`approval-request` event: ordinary tool calls (with the session-scoped native
suggestions Claude offers), AskUserQuestion, and ExitPlanMode plan approvals.
The host answers on stdin; hcn writes the reply back as the native
`control_response`, emits one `approval-disposition` per decision, and emits
`approval-cleared` when Claude cancels the request (`control_cancel_request`),
when its turn ends while it waits, or when the process exits. While any
request waits, the session's stall clock pauses for that turn.

## Why this is inside the boundary

ADR 0008 names two triggers that need the maintainer's ask: a new supervising
part, and "widening one that exists so it owns a new decision: another
approval category hcn answers". This is the second, and the maintainer asked.
The ask was given once for the whole design (four issues, one request), so
the settings op and `--setting-sources` from the same request need no ADR of
their own: the settings op is normalization onto a native mechanism both
supported harnesses already have (`set_model` / `apply_flag_settings` on
Claude, `set_model` / `set_thinking_level` on pi), and `--setting-sources` is
a flag rendering.

The lane also passes ADR 0007: it supervises one process hcn spawned, for as
long as it runs. The pending map is per process; nothing persists across
processes, and the caller owns durable choice records - the same ownership
line the Codex lane already draws.

## The boundary it keeps

Forward native requests, decide nothing, persist nothing:

- Claude resolves deny rules, hooks and the managed policy BEFORE it asks
  the host; hcn adds no rule of its own. A tool a project deny rule already
  refuses never reaches the host.
- The choices offered are exactly the native ones: allow once, one choice
  per session-scoped native suggestion, deny. Suggestions whose destination
  would write the user's settings files are not offered, and neither is an
  update whose behavior does not widen the session (`behavior: "deny"`):
  only setMode and `behavior: "allow"` updates are choices (review round 1,
  2026-11-07; the choice also carries the native suggestion object as
  `update` so the host can show exactly what it grants).
- Every decision is the host's; hcn validates only that the choice was
  offered and the payload fits it, consumes the decision before its write,
  and never retries.
- The stall pause is the existing stall clock's policy extended, not a new
  clock: a human deciding is not inactivity.

## Consequences

- `SessionControls` (descriptor data) gained an `approvals` channel
  declaration; `session.controls.approvals.supported` advertises the live
  support, `inspect --capabilities` the potential one.
- `ApprovalCategory` gained the session lane's categories (`tool`,
  `question`, `plan`), and `approval-request` can carry the native tool
  input, the normalized questions, and the plan text. The Codex run lane's
  emissions are unchanged.
- The one-shot run lane still refuses `--native-approvals` on Claude: a
  one-shot process has no host answering after the prompt, so the channel
  would strand the turn.

## Rejected alternative

Answer Claude session requests the way the Codex lane answers its own - hcn
picks from a fixed policy. Rejected: the feature exists precisely because a
session host (a chat pane) stands in for the user, and any hcn-side policy
would silently make permission decisions the user never saw. Forwarding is
the smaller supervising surface, not a larger one.
