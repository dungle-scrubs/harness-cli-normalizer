# Per-harness native behavior

Read this before relying on behavior that differs by harness: model choice,
provider selection, live-session controls, Claude write sandbox limits, the
Claude configuration directory, native approvals and input requests, Cursor
SDK authentication, model and access behavior, Antigravity results, and
OpenCode's free tier and event stream. The flag table and support matrix are in
[reference.md](reference.md).

## Claude models

Before selecting a newer Claude model, check `hcn inspect claude --json`:
`vocabulary.models` lists explicit IDs, and `vocabulary.aliases` shows each
alias's current target. An alias can move between generations; use a listed
explicit ID to retain an older generation. Native CLI version and account
access still determine whether the provider accepts that model.

## Claude configuration directory

Claude's configuration directory defaults to `~/.claude`. Setting
`CLAUDE_CONFIG_DIR` selects the directory for settings, session history,
plugins and project transcripts. It also moves `.claude.json` from the home
directory into the selected directory and, on macOS, selects a Keychain
entry scoped to that directory. Even making the default path explicit can
select a different login context. See Claude's
[credential management](https://code.claude.com/docs/en/authentication#credential-management)
and [configuration directory](https://code.claude.com/docs/en/claude-directory)
documentation. hcn preserves an inherited empty value as a caller choice.

To persist that choice for automated callers, set `claudeConfigDir` in
`~/.config/hcn/config.json` to a non-empty absolute path (no shell
expansion). hcn then supplies the variable as a fallback on `hcn run
claude` and `hcn session claude`, fresh and resumed, and prints
`provenance: claudeConfigDir = "<path>" (user-config)` on stderr when it
applies. The same setting reaches argv/runtime previews and `inspect --context`.
A per-run `--env CLAUDE_CONFIG_DIR` entry (the empty delete
included) and an inherited variable (an inherited empty value included)
both outrank the setting; with no setting hcn adds no variable, other
harnesses never receive one, and the project config cannot set the key.
Sessions refuse `--env`; choose another session context through the inherited
variable. `hcn transcript` and `hcn interactive` still use the native environment
variable rather than this launch setting. Upgrade older hcn callers sharing this
user config before adding the key, which those versions reject.
hcn does no auth preflight and never reads, refreshes or stores credentials.
Claude owns everything under the directory.

## Claude write access

On builds advertising strict Claude write access in `hcn run --help`,
`hcn run claude --access write` renders `--permission-mode acceptEdits` and
one owned `--settings` object with these sandbox fields:

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "failIfUnavailable": true,
    "filesystem": { "disabled": false }
  }
}
```

Claude auto-approves sandboxed Bash, forbids unsandboxed retry and is asked to
fail startup if the sandbox is unavailable. Native tool permissions, Bash checks
and network policy still apply. The OS sandbox covers Bash, not file or web tools.
This is not a promise that every platform or command works unattended.

Unless managed policy overrides strict mode, Claude ignores project settings
that loosen sandbox restrictions, including project domain allowlists and extra
write paths. Trusted user, CLI or managed policy may be needed for installs or
tests. hcn adds no network allowlist and does not change native policy sources.
`--autonomy` changes native permission mode but retains this explicit write
sandbox. It can allow network hosts outside the allowlist unless `strictAllowlist`,
`allowManagedDomainsOnly`, or native denied-domain policy blocks them. Claude documents that
decision matrix for an interactive terminal session. hcn has not verified it in a headless run,
and the 2.1.296 qualification included no network-plus-autonomy probe. The matrix governs only
traffic that goes through Claude's own sandbox proxy. When native `httpProxyPort` or
`socksProxyPort` applies, that custom proxy filters the traffic sent to it, and Claude's
`allowedDomains`, `deniedDomains`, `strictAllowlist`, approval prompts and local-address check
stop applying to that traffic. Preserved filesystem isolation does not prove network
confinement. See Claude's
[network approval rules](https://code.claude.com/docs/en/sandboxing#hosts-outside-your-allowed-domains)
and [custom proxy configuration](https://code.claude.com/docs/en/sandboxing#custom-proxy-configuration).
Autonomy without explicit write access does not add the sandbox.

Selected skills share the same owned settings object. This preserves selection
fields, not a promise that skills load under every native mode: Claude safe mode
disables skills. Caller-provided settings and passthrough remain untouched.
On Claude 2.1.296, a later CLI `--settings` object replaces the earlier object.
hcn does not merge caller JSON or settings files. Inspect the intended argv and
native policy before relying on added settings.

## Pi provider

Pi 1.0 requires a model when a provider is supplied: use
`--provider <provider> --model <model>`, or a provider/model selector.
A provider-only invocation remains a native failure.

## Session tool limits

Claude and Pi session permission options use the run renderers at spawn. Repeat
the explicit controls on resume. Claude grants the selected tools and denies
the complement of its known built-ins. New native tools outside that inventory
can remain available; Claude 2.1.316 exposed `SendToProject` and
`SendToProjectContext` in the session probe. This is not a closed inventory
guarantee on newer versions. It also does not deny every configured MCP tool;
Claude's `--access read` preset explicitly denies `mcp__*` as well.

Pi 1.4.0's plain `--tools` list replaces built-in and extension declarations,
but does not remove registered MCP tools. They are undeclared unless selected,
and a granted proxy such as `codemode` or `tool_search` can reach them. A
canonical allowlist containing only ordinary built-ins grants neither proxy.
An extension can change tools or run code with the process's permissions;
these selections do not sandbox extension code, the OS, or the network.
`--no-autonomy` adds no native flag, so native saved permission settings still
apply. See Pi's [tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#tools)
and [MCP exposure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#control-tool-exposure).

## Live-session controls

Before choosing a delivery mode or interrupting, check the latest
`identity.capabilities.sessionControls`, or the session packet's `controls`
until the first `identity` arrives. Claude `queue` selects native priority `later`; `steer` selects
`next` and can merge into the current result. Omitted busy input can also merge.
A merged input creates no additional hcn turn, and native background output has
no caller id. Claude `interrupt` writes the native interrupt control request
once the process advertises `interrupt_receipt_v1`; until then, or when it
does not, the request is rejected `unsupported` with nothing written. The
native success response only acknowledges it: an `aborted_streaming` or
`aborted_tools` result confirms `interrupted`, and that turn ends clean.
The receipt belongs to the turn live when the request was written; a later
turn's result never settles it. Claude keeps its queued messages; hcn never cancels or resends them.

Pi `queue` and `steer` use the prompt's native `streamingBehavior`, so the
harness decides atomically whether to start or deliver into ongoing work.
Pi sends are written one at a time, each only after the previous send's
native response, so back-to-back sends cannot race inside the harness.
`interrupt` requests native abort and waits for an aborted settlement before
reporting `interrupted`. Pi keeps its queued messages through abort. Send any
replacement after the terminal interruption receipt; the same conversation
continues. A `handled` input does not start a model run. Pi has no native
background jobs and no native stop; `stop-background` rejects `unsupported`.

Claude's task records (a `run_in_background` Bash call, an Agent call,
inline or background) surface as `background` events, and a subagent's own
tool, tool-result and message events carry `parentCallId`. `backgrounded`
tells the agent forms apart: `false` is an inline (foreground) agent,
`true` a background job. hcn forwards a boolean `is_backgrounded` only on
the event whose own record carried it (`task_started` today); later
events for the job carry no flag - remember it by job id if you need it
on every event. The call's `run_in_background` input is unreliable
because Claude may background a call that omits it. A job's end can
arrive after `result`, between turns. When no published turn owns it,
it stands alone on the wire as a bare `background` line and opens no turn,
including while a send awaits acknowledgment. Stopping one is
`stop-background`, which writes claude's native `stop_task` control request:
the `background-stop` receipt says the request was accepted, and the job's
end arrives on the stream as its own `background` event.

Codex advertises `steer`: native `turn/start` while idle, `turn/steer` while
busy under `expectedTurnId`. Other modes remain unsupported. Cancellation is
best effort and does not undo actions or guarantee every tool process stops.
See the [receipt protocol](reference.md#delivery-and-interruption).

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

`hcn run cursor` and `hcn session cursor` execute the Cursor SDK (`@cursor/sdk`,
installed with hcn) in one Node worker process hcn owns. hcn never spawns the
native `agent` CLI headlessly. Historical native terminal operations and CLI version
inspection remain separate.

**Authentication is separate from the native CLI login.** The SDK needs
`CURSOR_API_KEY`, or a user API key stored by the SDK's browser login
(`Cursor.auth.login()`, stored at `~/.cursor/sdk/auth.json`, minted for 90 days
by default). A login to the `agent` CLI or the Cursor IDE does not satisfy it,
and hcn adds no `login` command - see Cursor's
[SDK authentication](https://cursor.com/docs/sdk/typescript#authentication).
SDK auth failures arrive as classified `auth` failures. User API keys bill to
the user's plan with the same pricing and request pools as IDE runs. Never
read, log, or paste a key or account identity.

Models: hcn slugs keep working - `grok-4.7-high`, or `--model grok-4.7
--effort high` - and the worker resolves them against the account's
`Cursor.models.list()` catalog into a base id plus parameters (effort values,
`fast`, context sizes), filling each other parameter with its default. A bare
SDK base id (an exact catalog id) and a bare family stem both run at the
catalog's defaults instead of refusing. Unknown ids pass through to the SDK
and fail natively. Parameter spelling varies by model: grok-4.7 uses
`reasoning_effort`, older models may use `effort` - never assume one spelling.

Resume: SDK conversation ids are `agent-<uuid>` and survive process restarts;
`--resume` reattaches through `Agent.resume`. A bare UUID names a CLI-chat
session in a different, incompatible store and refuses explicitly.
`--resume-last` refuses (the SDK backend has no most-recent-conversation
path), and a native passthrough tail after `--` refuses (the worker takes no
native CLI flags).

Access: `--access read` selects the SDK read toolset (`read`, `grep`, `glob`,
`ls`, `webFetch`, `webSearch`, with `task` and `mcp` disallowed so subagents
and custom tools cannot grow it back). That is tool selection, not a sandbox:
the web tools stay and `read` reads any path. `--access write`, and autonomy
without an explicit read, run the native toolset unconfined with the sandbox
explicitly off - use them only with the human's authorization for that access.
A bare run or bare session sets no hcn restriction: the SDK's own defaults own
the bare case - its standard toolset (shell, edit, write) runs without approval
and its sandbox ships disabled in the pinned build - so writable tools are
available and you must pass `--access read` explicitly when the work should
stay read-only. An explicit read stays read even with `--autonomy`. There is
no normalized Cursor `--sandbox` and no
`--tools`/`--exclude-tools` selectors. `hcn inspect cursor --runtime --json --prompt "preview only"`
prints the exact mapping in its `sdk` block.

Sessions: `send`, `answer`, `interrupt`, and `close` work, with hcn's question
escalation. A send while a run is active is rejected natively - the SDK allows
one active run and hcn keeps no queue; there are no explicit queue or steer
modes. `interrupt` maps to native `Run.cancel`: best effort, and it does not
undo completed actions. During SDK startup it cancels deferred inputs, reports
`interrupted`, and creates no turn. The session surface refuses every option
it cannot express - the permission options (`--access`, `--tools`,
`--exclude-tools`, `--no-tools`, `--autonomy`), `--skills`,
`--native-approvals` and `--setting-sources` - exit 2 before the worker
spawns, with the same refusal shape a harness with no session permission
dimension gives; a bare Cursor session runs at the SDK's native defaults
(writable tools, sandbox off). The SDK can raise a native `request` (approval or
input) that has no reply API; hcn reports it as an error event it cannot
answer - handle it through native hooks or hcn's question protocol, never by
adding `--autonomy` on your own.

SDK 1.0.38 gives built-in tool rejections and execution errors the same error
shape. Both arrive as `tool-result` with `isError: true` and the raw result,
including its reason text. hcn does not infer `error.denial` or
`done.denialCount` from that text. A clean turn can still contain tool errors.

Historical native CLI facts - the workspace-trust gate (`trust-refused`
failures, `--force` trust bypass), the locked-keychain line, and ask-mode
flags - describe the `agent` CLI hcn no longer runs. They remain in the
descriptor for the transcript reader and legacy stream decoding; a headless
run never hits the trust gate or that keychain path.

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

## OpenCode

OpenCode runs one-shot turns as `opencode run --format json` and writes one
JSON object per line: `step_start`, `tool_use`, `text`, `step_finish`,
`reasoning` (only with `--thinking`) and `error`. A `tool_use` line carries
the tool and its settled state together, so it is one tool event and one
tool result; a `text` line carries the whole text part, so the stream is
message-granular, not token-granular. Every line carries the harness-minted
`sessionID`, so the first line announces the session even when that line is
the failure.

The model vocabulary is open: OpenCode's free roster rotates, so hcn curates
no model list and `--model provider/model` passes through. A free model needs
no account and no API key. The data terms differ per free model (some retain
prompts or train on them); hcn does not choose the model.

`run` auto-rejects every permission request, so a turn that needs one is
denied by OpenCode itself. `--autonomy` renders the native
`--dangerously-skip-permissions` flag, which approves those requests once.
`run` takes a variadic positional message and joins trailing text into it,
so a passthrough tail after `--` refuses before spawn instead of rewriting
the prompt. An unknown session id is a refusal (exit 1, `Session not found`),
not a fresh session; an unknown model arrives as an opaque `UnknownError`.
The free tier's own wall names `FreeUsageLimitError` in the provider's
response body and the Go plan's names `GoUsageLimitError`; both classify as a
usage limit. OpenCode retries such a wall up to five times before it reports
it, waiting as long as the provider's `retry-after` asks, and prints nothing
while it waits, so a limited turn can go silent before it fails. Bound it
with `--timeout`.

For private code, pick a free model whose provider keeps no data, such as
`opencode/glm-5.3-flash-free` (OpenCode's Zen docs, 2026-11-10); `big-pickle`
and several others may retain prompts or train on them.

A prompt that starts with `-` reaches `opencode run` as a flag and fails
natively. hcn's default question preamble hides this; with `--questions none`,
start the prompt with another character.

Only the one-shot turn is supported. There is no persistent session mode, no
transcript reading (OpenCode files its sessions in a SQLite store under the
XDG data root), no context inspection, no compaction claim, no tool selection
and no access preset.
