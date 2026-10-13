# Native interactive resume

First run `hcn interactive --help` on the binary the caller will use. If the
operation is absent or the interface unavailable, keep the reconnect request
held. The help output owns current interface support and flags.

Use the exact native session ID and original folder supplied by the caller's
verified binding. Supply the caller's launch UUID v4 and a dedicated writable
control pipe (FIFO or socket, fd >= 3). An invalid control address produces no
control record and exits uncertain. Native stdin/stdout/stderr stay on the
terminal. This operation accepts strict resume only; fresh sessions, model switches,
forks and native argument passthrough are outside it. When help lists
`--startup-prompt <text>`, the caller may supply one nonempty UTF-8 instruction
of at most 8,192 bytes without NUL. It starts one native turn; omitting it leaves
idle resume. HCN passes leading hyphens and newlines as prompt data, refuses
invalid/duplicate startup before spawn, and never echoes it on the control pipe.
Unsupported interfaces refuse before spawn. A started record does not prove the
prompt was received or followed; use the caller integration to establish readiness.
Do not repeat startup after uncertain launch. A new, explicitly authorized attempt
after proven pre-start refusal remains separate from retrying an uncertain one. Integration environment overrides
use HCN's normal validation and empty-value removal rule.

Read the separate control NDJSON by version, operation and launch ID:

| Record | What it proves |
|---|---|
| `ready` | Preflight passed; process creation is not proved. |
| `refused` with `evidence: spawn-not-attempted` | No child was created. The typed reason explains why. |
| `started` | The named process was created with the requested session, folder and interface. Native history loading needs later integration proof. |
| `closed` | The process exited; inspect its exit status and owned cleanup result. |

A missing record, truncated pipe, missing process provenance, or disconnected
caller leaves launch uncertain. Keep it held for reconciliation. Exit code
alone cannot prove a pre-start refusal: native programs can use the same code.

The caller owns cross-process reservation, duplicate-session prevention and
verified attachment. HCN supervises only the process it creates. Validate the
caller's control-pipe creation and cleanup in its actual runtime; HCN's output
tests do not establish that a different parent runtime handles extra file
descriptors correctly.

## Passive native settings

Check `hcn inspect --help` and `hcn run --help` on the caller's binary first.
Missing settings flags leave the operation unsupported.

`hcn inspect codex --native-settings --resume ID --cwd ABSOLUTE_PATH --json`
reads the caller-identified native session without starting a process. It returns
the latest supported turn or native settings update's exact model and effort,
the latest recorded provider (initially the session header's provider),
and a source fingerprint. It never returns conversation text.

Builds whose help lists Pi also accept
`hcn inspect pi --native-settings --resume ID --cwd ABSOLUTE_PATH --json`.
Pi follows the saved leaf's parent chain for model/provider and thinking level;
it does not take settings from a different retained branch. Its session store
honors `PI_CODING_AGENT_SESSION_DIR` before `PI_CODING_AGENT_DIR`. Pi records no
restorable permission policy through this surface. The other harnesses return
unavailable with reason `unsupported-harness`.

One JSON object is written, with or without `--json`: `status: available` exits 0;
`status: unavailable` plus a reason exits 2. Only resume (or its session-id alias), cwd and json options are
accepted. Wrong identity or folder, ambiguous files, symlinks, special files,
missing settings, malformed or incomplete history, changing sources and bounded
read limits refuse. Limits: 16384 directory entries, 64 MiB per file, 1 MiB per line.
An invalid latest turn or settings update never falls back to earlier settings.

Newer producers also return `permissions` from that same latest native settings record.
`status: recorded` describes recognized read-only filesystem access, restricted
network access and an explicit `never` or `on-request` approval policy. It is an
observation, not a headless permission grant or restoration capability. Missing,
extended or unsupported metadata returns `status: unavailable` with a specific
reason while model settings can remain available. Omission by an older v1
producer means unknown. Never treat missing facts as the native default.

`permissions.approvalsReviewer`, when present, is `user`, `automatic`, or
`unknown`. Absence is unknown. A later turn can retain the last explicit native
reviewer when it omits or nulls that field. This never inherits an older permission
grant. An unknown explicit reviewer or a settings update missing its required
reviewer invalidates older reviewer authority. Named profiles, network overrides
and extra filesystem policy remain unavailable until fully supported.

Use `hcn run codex --resume ID --cwd ABSOLUTE_PATH --native-settings-fingerprint HASH --prompt TEXT`
to require these settings. Planning and the runner each re-read the source. A
matching source supplies exact model, effort and recorded provider before the
prompt. Competing model/effort/provider options, native passthrough, fresh launch
and unsupported harnesses refuse. In builds listing Pi, use the same command
with `pi` to restore its saved model, effort and provider. The same flag works
with inspect --argv or --runtime.
This flag restores model settings only; it does not restore recorded approval or
permission policies. Codex exec can change a recorded `on-request` approval
policy to `never`. Preserve the caller's native authority and hold any automatic
continuation whose permissions have not been independently verified.

`native-settings-changed` means the source fingerprint no longer matches;
`native-settings-unavailable` means the source cannot be read and verified.
Inspect the same native session again before retrying. Planning refusals exit 2;
the final runner refusal emits failure/done and exits 1. Exit status alone is not
proof that no process started.

The fingerprint grants no ownership or permissions. It does not snapshot provider
configuration contents or lock another process's writes. Callers still own
duplicate-session prevention, permissions, input delivery and cleanup. Ordinary
resume without this flag still follows native settings behavior.
