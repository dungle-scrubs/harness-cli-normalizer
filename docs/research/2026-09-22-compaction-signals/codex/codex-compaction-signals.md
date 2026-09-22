# Codex live compaction signals on `exec --json` (0.155.1)

> **Captures are not published.** This file was written beside a `captures/`
> directory of raw harness output, and its references to those paths do not
> resolve here. The captures are held on the machine that ran the probes, on a
> local `research/compaction-*` branch, because raw stdout from these harnesses
> echoes the operator's own agent configuration into the stream. See the
> [directory README](../README.md) for what that means and why. Every record a
> claim in this file rests on is quoted verbatim in the file itself.

Research ticket: [#231](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/231).
Probes run on `pro`, 2026-09-22, against the installed `codex-cli 0.155.1`.
Captures: `findings/captures/` beside this file.

## Answer

**The live stdout stream emits nothing for compaction.** Across three real
compaction crossings, `codex exec --json` printed no `item.started`, no
`item.completed`, no `compacted` record, and no token or occupancy number
while compaction ran. The only live cue is a silence: the stream stops
between two ordinary events and resumes after compaction finishes. This is
**observed** in three crossings and **documented** in the 0.155.1 source,
where the exec JSONL processor has no arm for the compaction item and drops
it.

The finding that reframes the design question in
[#236](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/236):
even the full live event that stdout drops carries no numbers.
`ContextCompactionItem` is `{ id: String }` and `ContextCompactedEvent` is a
unit struct. A consumer that gets the compaction item plumbed through would
learn *that* a compaction happened, never how full the window was or how
much it reclaimed. Occupancy on the Codex live path exists only in
`turn.completed.usage`, which arrives once, at the end of the turn, after
compaction has already changed the number's meaning.

## Method

### Versions

| Fact | Value | Standing |
|---|---|---|
| Installed CLI | `codex-cli 0.155.1` (`codex --version`) | observed |
| Binary | `/opt/homebrew/Caskroom/codex/0.155.1/bin/codex` | observed |
| Descriptor `verifiedAgainst` | `"0.155.1"` (`src/knowledge/codex.ts:22`) | observed |
| Difference | none; the installed CLI is the version the descriptor was verified against | observed |
| Model | `gpt-6-astra`, as in the 0.155.1 fixture capture | observed |
| Rollout store | `~/.codex/sessions/2026/09/22/`, the default root `transcriptStoreRoot` resolves for codex with `CODEX_HOME` unset (`src/cli/store-root.ts:34-36`) | observed |

### How compaction was forced

The recipe from `test/fixtures/codex-0.155.1/VERIFICATION.md` ("Native
compaction"), driven against the CLI directly rather than through `hcn`:
lower the auto-compact threshold with the config override
`-c model_auto_compact_token_limit=20000`, then keep turning the session.

A fresh `gpt-6-astra` turn already reports `input_tokens: 32048` before any
user content matters, so a 20000 limit puts the session over the threshold
from the first turn onward and every later turn compacts before it answers.
Prompts are synthetic marker strings (`HERON-231-KESTREL`,
`HERON-231-OSPREY`) and `seq` filler. No real user content was sent.

Working directory for every run: an empty scratch directory, with
`--skip-git-repo-check`.

### Commands

```sh
# turn 1, fresh session, establishes the marker
codex exec --json --skip-git-repo-check -m gpt-6-astra \
  -c model_auto_compact_token_limit=20000 \
  "Remember this marker exactly: HERON-231-KESTREL. Reply with just the marker and nothing else."

# turns 2 and 3, resume the thread; each one compacts before answering
codex exec resume 01a0c860-875c-74d1-8c7f-a41c4043f624 --json --skip-git-repo-check \
  -m gpt-6-astra -c model_auto_compact_token_limit=20000 \
  "What marker string did I ask you to remember? Reply with just the marker and nothing else."

# separate fresh session: tool calls inflate the context inside one turn,
# so the crossing lands mid-turn rather than at turn start
codex exec --json --skip-git-repo-check -m gpt-6-astra \
  -c model_auto_compact_token_limit=40000 \
  "First remember this marker exactly: HERON-231-OSPREY. Then run these shell commands one at a time, ..."
```

Each run was spawned by `run_probe.py` (copied to
`findings/captures/run_probe.py`), which writes the raw stdout bytes to
`<prefix>.ndjson`, raw stderr to `<prefix>.stderr.txt`, the argv and wall
clock to `<prefix>.cmd.txt`, and one timestamped line per stdout line to
`<prefix>.timeline.txt`. The timestamps are what make the silent window
measurable.

### Captures

| File | What it is |
|---|---|
| `01-establish.*` | fresh turn, no compaction, baseline event vocabulary |
| `02-recall.*` | crossing 1, compaction at turn start |
| `03-recall-second.*` | crossing 2, same session, second compaction |
| `04-midturn-attempt-capacity-error.*` | aborted attempt, `Selected model is at capacity`; kept because it shows the `error` / `turn.failed` shape |
| `05-midturn-tooling.*` | crossing 3, compaction inside a turn between tool calls |
| `06-legacy-history-mode-rejected.*` | `-c history_mode=legacy` refused by `--strict-config`; see Open questions |
| `07-rollout-vs-stdout.json` | rollout compaction records for both sessions, aligned against every captured stdout line |

## 1. Every event in the compaction window

`02-recall.ndjson`, the complete stdout of a turn that compacted, verbatim
and in full. Four lines, start to finish:

```json
{"type":"thread.started","thread_id":"01a0c860-875c-74d1-8c7f-a41c4043f624"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"HERON-231-KESTREL"}}
{"type":"turn.completed","usage":{"input_tokens":66886,"cached_input_tokens":13568,"cache_write_input_tokens":0,"output_tokens":24,"reasoning_output_tokens":0}}
```

The rollout for that same turn holds the compaction that stdout does not
show (`07-rollout-vs-stdout.json`, session `01a0c860`):

```json
{ "ordinal": 23, "timestamp": "2026-09-22T09:10:18.228Z", "type": "compacted",
  "window_number": 1, "replacement_history_items": 2, "message_len": 0 }
{ "ordinal": 26, "timestamp": "2026-09-22T09:10:18.230Z", "type": "event_msg",
  "payload_type": "item_completed", "item_type": "ContextCompaction",
  "item_keys": ["id", "type"] }
```

Aligning the two by wall clock, the compaction at `09:10:18.228Z` sits
inside the stdout silence that runs from `turn.started` at `09:09:56.124Z`
to the answer at `09:10:28.558Z`. Nothing was printed in between.

Answers to the question as posed, all **observed**, all three crossings
agreeing:

| Signal | On stdout |
|---|---|
| `item.started` for a `ContextCompaction` item | no |
| `item.completed` for a `ContextCompaction` item | no |
| `compacted` record | no |
| `context_compacted` event | no |
| any other new event type | no |
| anything on stderr | no; stderr carried only unrelated `rmcp::transport::worker` MCP connection errors |

Neither is it a case of stdout carrying a reordered or renamed version of
the event. The set of line types in a compacting turn is identical to the
set in a non-compacting turn (`01-establish.ndjson`): `thread.started`,
`turn.started`, `item.completed`, `turn.completed`.

`item.started` does reach stdout for other item kinds, so its absence here
is specific to compaction rather than a property of the stream. From
`05-midturn-tooling.timeline.txt`:

```
   10648 type=item.started item.type=command_execution keys=[item,type]
   10649 type=item.completed item.type=command_execution keys=[item,type]
```

## 2. Occupancy and token counts in the live records

**No live record carries an occupancy number, and none can.** Three layers
of evidence:

- **Observed**: the only number on stdout during a compacting turn is
  `turn.completed.usage`, printed after the turn is over. In `02-recall` it
  reads `input_tokens: 66886` against a threshold of 20000, because the
  usage is a session running total, not the post-compaction window
  occupancy. Taken as occupancy it is wrong by construction.
- **Documented**: the exec JSONL processor stores token usage and never
  prints it as its own event.
  `codex-rs/exec/src/event_processor_with_jsonl_output.rs:502-505` at tag
  `rust-v0.155.1`:

  ```rust
  ServerNotification::ThreadTokenUsageUpdated(notification) => {
      self.last_total_token_usage = Some(notification.token_usage);
      CodexStatus::Running
  }
  ```

  It surfaces only inside `turn.completed`, at
  `event_processor_with_jsonl_output.rs:526-528`:

  ```rust
  events.push(ThreadEvent::TurnCompleted(TurnCompletedEvent {
      usage: self.usage_from_last_total(),
  }));
  ```

- **Documented**: the compaction records upstream of stdout carry no
  occupancy either. `codex-rs/protocol/src/items.rs:473-476` defines the
  item as nothing but an id:

  ```rust
  #[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
  pub struct ContextCompactionItem {
      pub id: String,
  }
  ```

  and `codex-rs/protocol/src/protocol.rs:2145-2146` defines the compaction
  event as a unit struct:

  ```rust
  #[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
  pub struct ContextCompactedEvent;
  ```

The numbers do exist, but only in the rollout file. The `compacted` record
carries `latest_token_usage_record` with pre-compaction totals, and the
`token_count` event carries `model_context_window`. From the probe session's
rollout, records 23 and 25:

```json
"latest_token_usage_record": { "usage": { "input_tokens": 32078, "total_tokens": 32326 },
  "thread_token_usage": { "input_tokens": 64126, "total_tokens": 64386 } }
"info": { "total_token_usage": { "input_tokens": 32048, "total_tokens": 32060 },
  "model_context_window": 258400 }
```

Neither record reaches stdout. `token_count` has no arm in the exec JSONL
processor at all.

## 3. What the stream shows during the pause

A gap between two ordinary lines, and nothing else. Measured from the
capture timelines:

| Crossing | Capture | Silence | Between | Compaction at |
|---|---|---|---|---|
| 1 | `02-recall` | 32.4 s | `turn.started` and the answer's `item.completed` | `09:10:18.228Z` |
| 2 | `03-recall-second` | 32.5 s | `turn.started` and the answer's `item.completed` | `09:11:32.036Z` |
| 3 | `05-midturn-tooling` | 24.3 s | two `item.completed` lines, after a `command_execution` and before the next `agent_message` | `09:13:25.941Z` |

Crossing 3 is the mid-turn case. Compaction there does not interrupt the
turn, split it, or restart it. The turn's items keep arriving with the same
ids and shapes, and one inter-item gap is longer than the others.

The gap is not a usable signal on its own. In the same tool-heavy capture,
unrelated gaps of 9.4 s, 5.4 s and 6.0 s appear between items where no
compaction happened, and a model thinking for 30 s produces the same silence
as a compaction. Silence says only that the process has not printed, not
what it is doing.

The alignment carries about a second of slack: `run_probe.py` records the
process start with one-second resolution, so the UTC timestamps derived for
stdout lines in `07-rollout-vs-stdout.json` can be off by up to 1 s. The
gaps are 24 s and longer, so the conclusion does not turn on that slack.

## Why stdout is silent: the drop is in the exec processor

All source citations are `openai/codex` at tag `rust-v0.155.1`, the tag
matching the installed CLI.

1. The core emits the compaction item, both started and completed.
   `codex-rs/core/src/compact_remote_v2.rs:241-242` and `:361`:

   ```rust
   let compaction_item = TurnItem::ContextCompaction(context_compaction_item);
   sess.emit_turn_item_started(turn_context, &compaction_item)
   ...
   sess.emit_turn_item_completed(compaction_turn_context, compaction_item)
   ```

   The other implementation, `codex-rs/core/src/compact.rs:251-252` and
   `:405`, does the same.

2. The app-server protocol carries it.
   `codex-rs/app-server-protocol/src/protocol/v2/item.rs:412-416`:

   ```rust
   #[serde(rename_all = "camelCase")]
   #[ts(rename_all = "camelCase")]
   ContextCompaction {
       id: String,
   },
   ```

3. The exec JSONL processor drops it. Both item arms map through one
   function, and that function ends in a catch-all `None`.
   `event_processor_with_jsonl_output.rs:470-485`:

   ```rust
   ServerNotification::ItemStarted(notification) => {
       if let Some(item) = self.map_started_item(notification.item) {
           events.push(ThreadEvent::ItemStarted(ItemStartedEvent { item }));
       }
       CodexStatus::Running
   }
   ServerNotification::ItemCompleted(notification) => {
       if let Some(item) = self.map_completed_item_mut(notification.item) {
   ```

   `map_item_with_id`, which both call, handles nine item kinds and returns
   `None` for the rest (`:142`, `:316`):

   ```rust
   fn map_item_with_id(
       item: ThreadItem,
       make_id: impl FnOnce() -> String,
   ) -> Option<ExecThreadItem> {
       match item {
           ThreadItem::AgentMessage { text, .. } => Some(...),
           ...
           _ => None,
       }
   }
   ```

   `ThreadItem::ContextCompaction` falls into `_ => None`, so neither event
   is pushed and neither line is printed.

4. There is no wire shape for it even if an arm were added.
   `codex-rs/exec/src/exec_events.rs:107-...` lists the item kinds the exec
   stream can express:

   ```rust
   pub enum ThreadItemDetails {
       AgentMessage(AgentMessageItem),
       Reasoning(ReasoningItem),
       CommandExecution(CommandExecutionItem),
       FileChange(FileChangeItem),
       McpToolCall(McpToolCallItem),
       CollabToolCall(CollabToolCallItem),
       WebSearch(WebSearchItem),
       TodoList(TodoListItem),
       Error(ErrorItem),
   }
   ```

   The string `compact` does not appear anywhere in `exec_events.rs` or
   `event_processor_with_jsonl_output.rs`. The same holds on `main` as of
   this probe, so the gap is not specific to the pinned tag.

5. Anything the processor has no arm for is dropped silently
   (`event_processor_with_jsonl_output.rs:591`):

   ```rust
   _ => CodexStatus::Running,
   ```

## One compaction path does print a line, and it is only text

`codex-rs/core/src/compact.rs:407-410`, the non-remote implementation, sends
a warning right after the compaction item:

```rust
let warning = EventMsg::Warning(WarningEvent {
    message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.".to_string(),
});
sess.send_event(&turn_context, warning).await;
```

The exec processor does have an arm for `Warning`
(`event_processor_with_jsonl_output.rs:435-438`, `:402-412`), and it renders
it as an ordinary error item:

```rust
ServerNotification::Warning(notification) => {
    let warning = self.collect_warning(notification.message);
...
events: vec![ThreadEvent::ItemCompleted(ItemCompletedEvent {
    item: ExecThreadItem {
        id: self.next_item_id(),
        details: ThreadItemDetails::Error(ErrorItem { message }),
    },
})],
```

So on that path stdout would carry `{"type":"item.completed","item":{"id":...,"type":"error","message":"Heads up: Long threads ..."}}`
after the compaction. That shape is the same one 0.155.1 already uses for
the skill-budget notice captured in
`04-midturn-attempt-capacity-error.ndjson`.

Standing: **documented, not observed.** My runs never produced it. The
probe sessions ran with `history_mode: "paginated"` (rollout `session_meta`)
and took `compact_remote_v2`, which emits no warning, and neither rollout
contains a `warning` record. A consumer must not treat the text as a
reliable compaction signal: it is absent on the path that actually ran here,
it is prose subject to rewording, and it arrives typed as an error.

## Limits of the evidence

- One model (`gpt-6-astra`), one account, one machine, one CLI version. A
  different model or a legacy-history account may take the other compaction
  implementation and print the warning line above.
- Auto-compaction only. I did not probe a user-requested `/compact`, which
  `run_compact_task` handles on a separate path that emits its own
  `TurnStarted` event (`compact.rs:147-160`). Whether that path prints
  anything distinguishable on `exec --json` is **unverified**.
- Three crossings in two sessions. Enough to show the signal is absent, not
  enough to characterize rare variants.
- Alignment between the stdout timeline and the rollout is by wall clock
  with about 1 s of slack, as described above.
- The rollout records are read from the real store at `~/.codex`, so the
  probe sessions are interleaved with the user's own sessions there. The two
  thread ids are recorded above; nothing else in that store was read.

## Open questions

- **What selects the compaction implementation?** `history_mode:
  "paginated"` in the probe's `session_meta` lines up with the remote path,
  but I did not find the code that decides it. `history_mode` is not a
  config override: `-c history_mode=legacy` with `--strict-config` fails
  with `unknown configuration field 'history_mode' in -c/--config override`
  (`06-legacy-history-mode-rejected.stderr.txt`), so the legacy path could
  not be forced from the CLI and the warning line could not be observed.
- **Does the app-server/MCP surface expose what exec drops?** The
  `ContextCompaction` item exists in the v2 app-server protocol, so a
  consumer speaking that protocol instead of `exec --json` would see
  `item.started` and `item.completed` for it. Not probed; it is a different
  transport from the one this ticket asks about, and it would still carry no
  occupancy number.
- **Where does `EventMsg::ContextCompacted` fire?** The variant is defined
  (`protocol.rs:1405-1406`) but no `context_compacted` record appeared in
  either probe rollout. Absence in two sessions is a statement about these
  runs, not proof that it never fires.
