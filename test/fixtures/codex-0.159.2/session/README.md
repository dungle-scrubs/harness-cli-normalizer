# Codex app-server session protocol evidence (issue #330)

Captured 2026-09-30 against installed `codex-cli 0.159.2` (descriptor
`verifiedAgainst` 0.159.2), driving `codex app-server` (no subcommand) over
stdio with a Node client. Isolation: `CODEX_HOME=/tmp/codex-fixture-home`
holding only `model_provider = "ollama"` and `model = "qwen3:0.6b"`, so no
operator MCP servers, hooks, or skills load and nothing needed redaction.
Local model route on purpose: no OpenAI quota was spent on this capture.

`appserver-session.ndjson` - one fresh session, one turn, whole lifecycle
(probe framing: each harness stdout line is wrapped as
`{t:"+<ms>",kind:"a:recv",line:<parsed JSON>}`; `t` is client-side elapsed
time, not harness output):

1. `initialize` (clientInfo `{name:"hcn",version:"0.9.2"}`) responds with
   `{userAgent, codexHome, ...}`. Before it, every request fails with
   `-32600 "Not initialized"` (verified in a separate probe, not kept).
2. `thread/start` `{}` responds `result.thread{id, model, cwd, status}`;
   the thread id IS the rollout session id (`thread.sessionId ===
   thread.id`). A `thread/started` notification follows.
3. `turn/start` `{threadId, input:[{type:"text",text}]}` responds
   IMMEDIATELY (`result.turn{id, status:"inProgress"}`) - the response
   lands at turn START, not completion, so a send's settled disposition is
   fast. A `turn/started` notification follows with the same turn id.
4. Mid-turn `turn/steer` `{threadId, expectedTurnId, input}` responds
   `{turnId}` (the running turn). The steered text became a userMessage
   item INSIDE that turn, and the model's next answer in the SAME turn was
   exactly `BANJO` - one `turn/started`, one `turn/completed`, both with
   turn id `01a0f0ff-9d55`. Steer delivers into the running turn.
5. `turn/steer` with a wrong `expectedTurnId` fails with
   `-32600 "expected active turn id \`bogus-turn-id\` but found
   \`01a0f0ff-...\`"`; an idle steer (after `turn/completed`) fails with
   `-32600 "no active turn to steer"`. The rejected disposition maps to
   these, and only these - there is no queue arm (see below).
6. `turn/completed` `{threadId, turn{id, status:"completed", items, error}}`
   delimits the turn; `thread/status/changed` announces idle.
7. stdin EOF: the process exits 0.

`appserver-session-resume.ndjson` - a SECOND process runs `initialize` then
`thread/resume` `{threadId}` for the thread above; the response carries the
same thread with its history (`result.thread.turns`), proving persistence
and the resume response shape. `codexHome` in the initialize response shows
the isolated home.

Queue semantics (established live, this ticket): `codex queue --thread <id>
--message <text>` exits 0 and parks a message consumed at the START of the
next turn (observed: the queued text became a userMessage item at the head
of the next turn in a later process). It is an out-of-band CLI write - there
is no queue request in the client protocol (only a `thread/queue/changed`
notification) - so an app-server client cannot queue through the protocol.
hcn session send therefore maps to `turn/start` (idle) and `turn/steer`
(busy) only; the disposition vocabulary stays `started | rejected`.

Also observed on the same stream and NOT mapped (candidates, not claims):
`item/agentMessage/delta` exists in the protocol but never fired against
ollama on 0.159.2 (agentMessage items arrive whole via item/completed), so
session streaming stays `message`. `thread/compacted` /
`contextCompaction` item exist on the session surface while exec --json
reports nothing - compactionReporting stays null pending a mode-aware
shape. The `agentMessage.questions` field (native questions) is unmapped;
hcn's escalation preamble is the question mechanism. Secret scan at capture:
no token/key/email content; the only non-protocol identifiers are the
random installation id and hostname in the initialize response.
