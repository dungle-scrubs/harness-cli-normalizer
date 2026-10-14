# Cursor access presets

`--access read` selects Cursor's native ask mode:
`--mode ask --sandbox enabled`. `--access write` renders `--force`.
Write access grants commands and bypasses workspace trust; native explicit
denials still apply. It is unconfined, not a workspace sandbox.

The normalized `--sandbox` option remains unsupported. Rendering
`--force --sandbox enabled` for write would suggest a boundary that the
native CLI did not enforce in the probes below. No access preset is applied
unless the caller requests one. Fresh, named-resume, and resume-last runs
render an explicit preset identically.

## Native verification

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

These observations support native ask mode for read and `--force` for write.
They do not establish an OS-level read sandbox, guarantee behavior under
other native overrides, or qualify every capability of the newer build.
The descriptor's verification anchor remains 2026.10.01-e373342.

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
  [output formats](https://cursor.com/docs/cli/reference/output-format).

`test/knowledge/cursor-access-evidence.test.ts` checks the captured decoder
rows and the independent filesystem observations. Built-CLI stub tests
exercise the explicit presets on fresh and resumed runs under Node and Bun.
