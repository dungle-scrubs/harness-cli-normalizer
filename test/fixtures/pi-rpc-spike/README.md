# pi `--mode rpc` session-semantics spike (live probe)

Truthfulness rule discharge for the pi descriptor's `sessionMode: null`:
the comment in `src/knowledge/pi.ts` records `--mode rpc` as unverified
against a live run. This spike is that live run. Probed on pi 0.84.2
(`glm-5.3` via zai), 2026-08-19, against the shipped `docs/rpc.md`.

`spike.py` is the probe; re-run it as
`python3 spike.py <outdir>`. `assertions.txt` is the captured result
(25 passed, 0 failed). `0*.ndjson` are the raw stdout transcripts.
Fixtures are evidence, not a test suite - they stay out of CI because
they need credentials and a live model.

## Findings

1. **Startup is identity-silent.** stdout at rest carries only
   `extension_ui_request` records (widget/status noise from
   extensions). No `{"type":"session","id":...}` announcement - unlike
   `--mode json`, where that v3 header IS the identity record. The id
   is available only via a `get_state` command/response round trip, or
   from the session file path on disk.
2. **Persistence timing.** `get_state` reports `sessionFile` before the
   file exists. The file is created after the first completed turn.
3. **Turn lifecycle.** `response:prompt` (success true) -> `agent_start`
   -> `turn_start` -> `message_start` -> `message_update`
   (thinking/text/toolcall deltas) -> `message_end` (full assistant
   message, same content-block shape the json-mode decoder reads) ->
   `turn_end` -> `agent_end` -> `agent_settled`. `agent_settled` is the
   "nothing queued, no retry pending" marker.
4. **stdin EOF exits rc=0 immediately.** No lingering, no escalation
   needed.
5. **Same-process multi-turn works.** Second `prompt` in one process:
   `sessionId` stable, session file now exists, model recalls the first
   turn's exact command. No respawn needed for follow-ups.
6. **Mid-run input is real.** `steer` queued DURING a tool-running turn
   was delivered before the next LLM call (content steered); `follow_up`
   queued during the same run was delivered only after the run settled,
   and caused a second agent cycle. `queue_update` events fire as the
   pending queues change.
7. **Error contract.** A `prompt` sent during streaming WITHOUT
   `streamingBehavior` returns `success: false` naming the remedy -
   no silent drop, no protocol break.
8. **Framing.** Strict JSONL, LF only. Node `readline` is
   non-compliant (splits on U+2028/U+2029, legal inside JSON strings)
   - a client must split on `\n` itself. Verified by the doc; the
   probe's reader splits on `\n` only.

## Implications for the live question channel

- pi supports a persistent bidirectional session: the exit/resume cycle
  the resume protocol pays is not required on pi any more than on
  claude.
- The answer path is natural: queue the answer as a `follow_up` (or
  `prompt` once settled) while the session holds the asking context.
- Identity authority stays caller-assigned (`--session <id>` re-enters
  the same id, verified earlier under /tmp/pi-rpc-probe: same id, prior
  memory recalled). But hcn cannot passively decode the id from the
  stream - a session-mode pi client must issue `get_state` at start and
  match the response. New decode path, not a matcher.
- pi's `extension_ui_request` sub-protocol (select/confirm/input) is a
  native question channel, but only EXTENSIONS can emit it today. A
  model-raised ask still rides the hcn-question block protocol.
