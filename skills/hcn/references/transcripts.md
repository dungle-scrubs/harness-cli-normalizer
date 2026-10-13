# Passive native transcript reads

First check `hcn transcript --help` and `hcn inspect <harness> --transcript`.
Older installed binaries may lack this surface. Read the selected method's
capabilities, applicability, and evidence before exporting. Transcript reads
use no model, resume, instructions, extensions, or HCN run defaults.

```sh
hcn inspect pi --transcript
hcn transcript read pi --file /path/to/native.jsonl > transcript.jsonl
hcn transcript read pi --id NATIVE_ID --cwd /path/to/project --limit 100
hcn transcript read pi --file /path/to/native.jsonl --since OPAQUE_BOOKMARK --limit 100
hcn transcript ls --limit 20
hcn transcript ls --all-workspaces --harness claude,codex --headless --limit 50
hcn transcript ls --all-workspaces --since-time 2026-09-20T12:00:00Z
```

Use one native conversation ID or a native file. Relative files resolve against
`--cwd`, or the invocation directory. A nonempty `PI_CODING_AGENT_SESSION_DIR`
selects Pi's flat store for ID reads and listing in builds with that resolver.
Otherwise Pi ID lookup is workspace-scoped under `PI_CODING_AGENT_DIR/sessions`
or `~/.pi/agent/sessions`; use an explicit file for
custom native session directories. HCN creates no missing sources; `transcript
ls` lists saved sessions and keeps no index. External attachments and separate
conversations stay references.

Consume one `source`, zero or more `record` objects, then one `result` JSONL
object. Records stay provisional until `result.status` is `complete` and the
producer exits 0. Exit 1 is read, interruption, cleanup, or output failure;
exit 2 is invalid input or descriptor refusal. A missing result or a broken
pipe is unsuccessful. Preserve original wire text or use an exact-number JSON
parser when exporting originals; ordinary JavaScript `JSON.parse` can round
large native numbers.

## Listing saved sessions

`hcn transcript ls` lists saved native sessions, newest write first, and
computes the list on each call. No index, retention, search or state.

| Flag | Meaning |
|---|---|
| `--cwd <dir>` | Only sessions whose workspace is exactly this directory (default: the invocation directory) |
| `--all-workspaces` | Every workspace; not combinable with `--cwd` |
| `--headless` | Also return headless runs, which are omitted by default |
| `--harness <names>` | Comma-separated; the default is every harness with a listing method |
| `--limit <rows>` | Positive row limit; truncates the rows printed, not the walk |
| `--since-time <instant>` | Only sources written at or after this UTC instant, inclusive |

Output is JSONL: one `session-list-source` header, one `session` row per
session, one terminal `session-list-result`. Exit codes match `transcript
read`: 0 success, 1 failure, 2 invalid input.

A row carries `harness`, `id` (accepted by `transcript read --id`), `file`
(accepted by `--file`), `cwd`, `lastWriteAt`, `startedAt`, `sizeBytes`, `mode`,
`readable` and `blocked`. `mode` is `interactive`, `headless` or `unknown`
where the store carries no marker; treat `unknown` as interactive unless you
know otherwise. Claude reads `entrypoint` and Codex reads `session_meta`
`source`/`originator`; Pi, Muse, Cursor and Antigravity carry no observed
marker.

`lastWriteAt` is the filesystem mtime, so a copy, a checkout or a sync client
moves it without the conversation changing. `startedAt` is what the native
header itself says, normalized to `YYYY-MM-DDTHH:MM:SS.mmmZ`, or null where
the store records none. Rows still sort on `lastWriteAt`, because a store can
leave `startedAt` null. `sizeBytes` is the row's own source, which is what a
`transcript read` of it would have to get through; there is no record count.

`readable` and `blocked` answer different questions. `readable` says a
verified read method addresses that source shape: a row can list without being
readable. `blocked` is null, or `{ issue, reason }` naming a cheap
precondition the read would refuse on right now - a Cursor chat mid-turn lists
`readable: true` with `guarantee-unmet` because its `store.db-wal` holds
writes. Null is not a promise the read will succeed; it means nothing the
listing could check cheaply said otherwise.

The result's `harnesses` array reports each harness as `listed`, `divergent`
(no listing method) or `failed`, with its reason and store root, so a consumer
names its coverage gaps instead of guessing. `status` is `partial` when any
harness was divergent or failed, and `more` says rows existed beyond `--limit`.
There is no continuation token: to get the rest, re-run without `--limit` and
page the listing yourself. A harness's `matched` (named `rows` before 0.8.0)
is what it contributed after the workspace and headless filters and before
`--limit`; the result's
`rowsReturned` is what was printed, so the two differ whenever `--limit` bites.

`--limit` does not make the call cheaper: every store is still walked and every
row still built and sorted. `--since-time` does, and it is the only filter that
does: it is applied to the stat the walk already takes, so a source outside the
window is never opened and its prefix is never parsed. It takes
`YYYY-MM-DDTHH:MM:SS[.mmm]Z` and refuses an offset rather than reading it as
UTC. On a 5172-row store a narrow window takes 0.83s against 2.1s.

Child conversations are not rows: Claude sidechains, Codex spawned agent
threads, Muse `subagent/` sessions and Antigravity nested conversations. Codex
marks a child in the first `session_meta` record's `payload.source`: an object
`{"subagent": {...}}` whose `subagent` value is an object such as `thread_spawn`
(carrying `parent_thread_id` and `depth`) marks a child, while a string source
marks a top-level session (`cli`, `vscode`, `exec` observed).
`{"subagent": "review"}`, a string value naming no parent, lists as a row.
`originator` is inherited from the parent and does not tell them apart. Pi records
a parent in a session header's `parentSession`, which the listing does not read,
so that session lists as its own row. A session whose store names no workspace
reports `cwd: null` and appears only under `--all-workspaces`.

Retained history includes available branches and pre-compaction entries.
`historicalLoss` separately reports established data the harness omitted or
removed. A bounded batch does not reduce retained coverage. `--limit` counts
whole entries and does not bound bytes or internal validation work.

Save a returned bookmark only after a successful batch. Pass it unchanged to
`--since`; it validates native identity and all prior progress. Empty/EOF reads
can return same-boundary bookmarks. `fresh-read-required` means continuity was
not established; do not silently restart or commit provisional records. A
caller can supply a moved file, but HCN must verify its identity and prefix.
Positions are source coordinates, never invented permanent IDs.

`--accept-limits` takes explicit names: `history`, `branches`,
`original-records`, `embedded-content`. It permits only those coverage
reductions or unknowns. It never waives passivity, identity, corruption checks,
consistency, or requested paging/continuation. Unknown and unavailable support
are distinct. Follow a same-source hint only with the caller's coverage choice.

Current enabled methods cover Pi v3 files/IDs with batches/bookmarks and Codex
uncompressed legacy and paginated rollouts with batches/bookmarks, whatever
build wrote them. Each Codex source reports the `cli_version` its own header
names as its `writerBuild`; the reader gates on the rollout's structure, not on
that version. A spawned thread's rollout can inline its parent's prefix, including
the parent's `session_meta`; the reader admits that only when the child's header
declares it (`thread_source: subagent`, paginated history,
`subagent_history_start_ordinal`) and refuses any other additional `session_meta`.
The count of `session_meta` records does not tell a child from a top-level rollout.
Codex ID lookup scans active and archived stores under CODEX_HOME (default
~/.codex). Explicit history_base prefixes are contributing storage; only the
native byte/ordinal range is read. Other parent/child references are not followed.
Missing bases, invalid ranges, incomplete initialization and compressed sources
fail. An explicit --file can locate a renamed rollout; inherited bases still
use CODEX_HOME.

Claude main-file JSONL and Muse schema-1 session logs support ID/file reads,
batches and bookmarks. Claude ID lookup uses `CLAUDE_CONFIG_DIR/projects`
(default `~/.claude/projects`); Muse uses `XDG_DATA_HOME/muse/sessions`
(default `~/.local/share/muse/sessions`). Ambiguous matches fail. Separate
agent/child conversations stay separate; remote stores are outside these methods.

The Claude, Muse, Cursor and Antigravity readers require a passive filesystem
clone through HCN's packaged helper on macOS or Linux. The source and temporary
directory must support the same-filesystem clone operation. `TMPDIR` can select
a caller-owned private temporary location on the source filesystem. When the
skill's install check reports `blocked: snapshot checks`, these readers fail the
same way on that machine until `TMPDIR` names such a location. A failed
clone does not fall back to an ordinary copy or native resume. The helper has a
five-second acquisition deadline and one-second cleanup bound. A clone captures
a byte view that can fall between native writes; it does not prove a complete
native transaction. Unknown payloads remain original data. Claude can report an
explicit saved leaf; Muse branch selection remains unknown. None reconstructs
deleted data.

Cursor chat stores and Antigravity step logs also support ID/file reads,
batches and bookmarks through the same clone. Cursor ID lookup scans
`chats/*/<id>/store.db` under `CURSOR_CONFIG_DIR`, else `XDG_CONFIG_HOME/cursor`,
else `~/.cursor`. A Cursor chat whose `store.db-wal` holds writes (a turn still
running) fails with `guarantee-unmet`; read it after the turn ends. Cursor
records carry no timestamps, and redacted reasoning is retained but not included
as text. Antigravity ID lookup opens
`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`;
an explicit file must sit at that layout because steps carry no identity. Steps
must be contiguous from `step_index` 0. Antigravity steps have no native IDs and
tool calls have no call IDs, so tool-call links stay unknown. Both methods rest
on observed local stores, not vendor documentation.

Transcript evidence is separate from the harness's broader `verifiedAgainst`
pin. Inspect the installed build before use. Coverage opt-ins cannot waive
format, identity, integrity or snapshot prerequisites.

Customized Pi qualifies only when its writer preserves the declared v3 native
identity, one-file conversation, append/framing/order, and saved selection
semantics. Its version label alone is insufficient. Unknown fields and entry
kinds remain in originals. HCN does not offer runtime harness registration.

Consumers own indexing, retention, search, watching, and deduplication policy.
Keep private transcripts out of hosted-model context. When a task needs
private history, have a local model read it from file pointers, and never
paste transcript content into a hosted model's context.
