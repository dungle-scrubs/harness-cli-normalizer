# Per-harness native behavior

Read this before relying on behavior that differs by harness: model choice,
provider selection, native approvals and input requests, Cursor trust and
effort, and Antigravity results. The flag table and support matrix are in
[reference.md](reference.md).

## Claude models

Before selecting a newer Claude model, check `hcn inspect claude --json`:
`vocabulary.models` lists explicit IDs, and `vocabulary.aliases` shows each
alias's current target. An alias can move between generations; use a listed
explicit ID to retain an older generation. Native CLI version and account
access still determine whether the provider accepts that model.

## Pi provider

Pi 1.0 requires a model when a provider is supplied: use
`--provider <provider> --model <model>`, or a provider/model selector.
A provider-only invocation remains a native failure.

## Native approvals and input requests

When a turn reports that a native approval, input, or control request
cannot be handled headlessly, report the failure and let the human decide
before retrying. Do not add `--autonomy` on your own and do not
automatically retry to clear it: `--autonomy` grants unattended approvals,
which is the human's call.

Builds with interaction detection stop Claude control requests and Pi RPC
dialogs; Muse uses its read-only pending-request API because exec can omit
requests from stdout. A muse approval whose command asked to run outside
the muse sandbox (a sandbox escalation) ends the turn on the first sample;
its failure names `-- --sandbox-network enabled` first - that passthrough
keeps approvals and the filesystem sandbox - before answering in muse or
`--autonomy`. Codex exec rejects unsupported requests itself, and
Pi print mode returns noninteractive dialog defaults. A completed tool
denial is not a pending approval. Only terminal native outcomes establish
turn failure; informational notices remain notices.

For permission-preserving headless continuation or answering a live native
approval, read [native approvals](native-approvals.md).

## Cursor

Cursor runs behind a workspace-trust gate: an untrusted directory fails
the turn with failure class `trust-refused` (retryable - route the work
elsewhere or to a trusted directory). Trust a directory by running
`agent` there once outside hcn; `--autonomy` renders `--force`, which
bypasses the gate per run without persisting trust. hcn never passes
`--trust`. Effort on cursor resolves into the
`--model` slug through per-family ladders (`--model gpt-5.2 --effort high`
runs `gpt-5.2-high`); a bare family stem without `--effort` refuses, and
only arg-tier `--effort` enforces. `--access read` selects native ask mode
(`--mode ask --sandbox enabled`). `--access write` renders `--force`,
which grants unconfined commands and bypasses workspace trust: use it only
with the human's authorization for that access. Even native
`--force --sandbox enabled` allowed writes outside the workspace in
qualification. The normalized `--sandbox` option therefore still refuses.
`--autonomy` independently adds `--force` even with `--access read`; precedence
against ask mode is unverified. Use `--no-autonomy` for the qualified read preset,
including when configuration enables autonomy.
Denied tool calls arrive as `tool-result` with `isError: true` and
non-terminal `error` events carrying
a structured `denial` field (`tool`, `reason`) with exit 0.

## Antigravity

Antigravity uses `agy --print <prompt> --output-format stream-json` and
maps `--sandbox workspace-write` to its boolean native `--sandbox` flag.
Its model vocabulary is extensible. The listed models were captured on a
free Individual plan and do not claim paid-plan eligibility. Native
non-success `result.status` values fail the turn even when the process
exits 0. Structured `tool_info.error` permission failures emit
non-terminal `error` events with `denial`; model prose never establishes
a denial. HCN caller cancellation outranks Antigravity's shutdown
`context canceled` result, and an HCN wall-clock timeout remains a timeout.
Quota error records remain unqualified because qualification did not
deliberately exhaust the free allowance.
