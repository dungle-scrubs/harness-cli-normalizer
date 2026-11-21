# Cursor access presets

`hcn run cursor` and `hcn session cursor` execute the Cursor SDK (`@cursor/sdk`,
pinned 1.4.2 and installed as a dependency of the hcn package) in one Node
worker process that hcn owns and supervises. The worker runs under Node even
when hcn itself runs under Bun. The native `agent` CLI is not spawned for
headless turns or sessions. Historical native terminal operations and CLI version inspection
remain separate.

## SDK access mapping

The access preset selects the SDK toolset on the worker's open line, never an
agent flag. `hcn inspect cursor --runtime --json --prompt "preview only"` prints the exact mapping in
its `sdk` block (`workerArgv`, `resumeIdShape`, and the access map for bare,
read, write, and autonomy); `hcn inspect cursor --argv` previews the worker
marker `hcn-cursor-sdk-worker`, because model, access, and resume settings ride
the worker's stdin, not agent argv.

| Request | SDK restriction |
|---|---|
| `--access read` | `tools: [read, grep, glob, ls, webFetch, webSearch]` plus `disallowedTools: [task, mcp]` |
| `--access write` | native toolset, `sandboxOptions.enabled: false` stated explicitly |
| bare run, no autonomy | no restriction keys - native SDK defaults |
| bare run with `--autonomy` | the same unconfined toolset as `--access write` |
| bare `hcn session cursor` | no restriction keys - native SDK defaults |

`--access read` holds even when `--autonomy` is set. Bare runs and sessions
set no tool or sandbox restrictions. SDK 1.0.38 offers its standard toolset,
including shell, edit and write, without approval and with its sandbox off by
default. Use `hcn run cursor --access read` for the restricted toolset.
`hcn session cursor` refuses every access option with exit 2 before it spawns, so a
Cursor session always uses native defaults.
The SDK has no equivalent of the native CLI's workspace-trust refusal: an SDK
run can execute in a directory the CLI has not trusted. `--autonomy` does not
restore or persist that CLI trust decision.

The read preset is tool selection, not a sandbox. The read set keeps the two web
tools, the `read` tool reads any path, and nothing confines the network. The
`mcp` deny also removes custom tools and the `task` deny prevents subagents, so
neither can grow the allowlist back. Write runs the native toolset with the
sandbox disabled: it grants commands and edits, not a boundary. Loaded
file-based hooks can still reject tool calls.

On EOF or a termination signal, the worker attempts native cancellation and
agent disposal within hcn's existing cleanup grace. A hard kill, or SDK
cancellation that cannot settle before SIGKILL, can leave the conversation
busy in the native store. hcn never forces a takeover of that conversation.

The normalized `--sandbox` option still refuses on Cursor, and `--tools` and
`--exclude-tools` have no Cursor selectors. The SDK loads project and user
settings sources (rules and hooks from `.cursor/` and `~/.cursor/`); hooks are
file-based only, and hcn authors none.

SDK 1.0.38 exposes built-in tool rejections and execution errors in the same
error shape. hcn preserves the raw result and `tool-result.isError`; it does
not infer `error.denial` or `done.denialCount` from the reason text.

## Historical: native CLI verification (#373)

The probes below ran against the native `agent` CLI, which #440 removed from
headless duty. They remain the evidence for the descriptor's documented CLI
grammar (`--mode ask --sandbox enabled` for read, `--force` for write) and for
the conclusion that carried into the SDK mapping: write grants commands, not
confinement. `--force --sandbox enabled` still permitted writes outside the
workspace on both builds probed.

The probes used disposable git repositories, `gpt-5-mini`, print mode,
stream-json output, and native `--trust` to isolate access behavior from the
workspace-trust gate. Read was asked to read then modify a seed and create
another file. Write was asked to edit the seed and run a shell command that
writes both inside the workspace and to a task-owned sibling outside it.
File existence and contents were checked independently of model prose.

| Build | Native flags | Observed filesystem outcome |
|---|---|---|
| 2026.10.01-e373342 | none | Edit ran; shell was rejected. |
| 2026.10.01-e373342 | `--mode ask --sandbox enabled` | Read ran; seed unchanged; requested new file absent. |
| 2026.10.01-e373342 | `--force --sandbox enabled` | Edit and shell ran; shell created files inside and outside the workspace. |
| 2026.10.12-d47ca18 | `--force --sandbox enabled` | Same outside-workspace shell write succeeded. |

These observations supported native ask mode for read and `--force` for write
on the CLI. They did not establish an OS-level read sandbox, guarantee behavior
under other native overrides, or qualify every capability of the newer build.
These historical probes retain their CLI version. The current headless descriptor is qualified
against SDK 1.4.2 by its separate seven-scenario, question and compaction captures in
[`test/fixtures/cursor-sdk-1.4.2`](../test/fixtures/cursor-sdk-1.4.2).

Evidence:

- [Filesystem observations](../.evidence/address-open-tickets/cursor-access.json).
- [Pinned-build probe](../.evidence/address-open-tickets/probe-cursor.mjs) and
  [supplemental-build probe](../.evidence/address-open-tickets/probe-cursor-current.mjs).
  These are capture scripts, not offline tests; running them executes native
  model turns in task-owned directories.
- Raw captures: [read](../test/fixtures/cursor-2026.10.01-e373342/access-read.ndjson),
  [write](../test/fixtures/cursor-2026.10.01-e373342/access-write.ndjson), and
  [supplemental write](../test/fixtures/cursor-2026.10.12-d47ca18/access-write.ndjson).
  They retain native IDs, tool outputs, usage and paths; no operator agent
  configuration was found in these captures.
- Official Cursor documentation: [parameters](https://cursor.com/docs/cli/reference/parameters),
  [modes](https://cursor.com/docs/cli/using#modes), and
  [output formats](https://cursor.com/docs/cli/reference/output-format), plus
  the [TypeScript SDK](https://cursor.com/docs/sdk/typescript) for the toolset
  and sandbox options above.

`test/knowledge/cursor-access-evidence.test.ts` checks the captured decoder
rows and the independent filesystem observations.
`test/interpretation/access-preset.test.ts` asserts the SDK restriction
mapping, and the built-CLI tests assert the open line the worker receives on
fresh and resumed runs under Node and Bun.
