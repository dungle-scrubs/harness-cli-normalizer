# harness-cli-normalizer

One stable interface to six coding-agent CLIs.

[![CI](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/harness-cli-normalizer.svg)](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- D-001 / v1: CLI-only -->
harness-cli-normalizer is a CLI, `hcn`, that normalizes six coding-agent harnesses - Claude Code, Codex, pi, Muse, Cursor CLI (binary `agent`), and Antigravity CLI (binary `agy`) - into one surface: normalized flags, ratified behavior defaults, a single `HarnessEvent` NDJSON stream, and one exit-code contract. It normalizes the interface and the defaults, and reports divergence where a harness cannot express a dimension - it does not pretend parity. There is no library API; the `hcn` binary is the product. Descriptors are pinned to their verified CLI version and a weekly check flags when a harness has moved ahead (npm harnesses via registry; `muse`, Cursor CLI, and Antigravity CLI via their local version probes, skipped in CI where not installed - see Version-pinning and drift).

```bash
pnpm add @dungle-scrubs/harness-cli-normalizer
```

## Install

Requires Node 24 or newer. Install the public package from npm with your package manager:

```bash
pnpm add @dungle-scrubs/harness-cli-normalizer
```

The repository uses pnpm and Bun for development and its dual-runtime test lane. Consumers do not
need either one unless their application runs on Bun.

## CLI

The package ships a `hcn` binary for shell and CI use. This is the primary interface - use it for one-off turns, sessions, and inspection without writing TypeScript. Install it with your package manager or run it ad-hoc with `npx`:

```bash
pnpm add @dungle-scrubs/harness-cli-normalizer
npx hcn --help
npm install -g @dungle-scrubs/harness-cli-normalizer  # global
```

One-shot turn:

```bash
hcn run claude "explain a monad in one sentence"
hcn run codex "what is 2+2" --model gpt-5.6-sol
hcn run pi "name three primes" --model zai/glm-5.2
hcn run muse "say hi" --no-write
hcn run antigravity "summarize this repository"
```

Piped JSON for programmatic use:

```bash
hcn run claude "say hi" --json | jq .
hcn run claude "hi" --json | head -n 5  # abandonment-safe, no hanging handles
```

Session (claude, pi, Antigravity):

```bash
hcn session claude
hcn session claude --model opus --session-id 550e8400-e29b-41d4-a716-446655440000
hcn session pi --effort high
hcn session antigravity --effort medium
```

Sessions resolve the memory dimension at spawn - default off, same as
runs (`--memory` / `--no-memory`, config `memory` in both tiers;
claude spawns with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, pi has no
built-in memory).

### Saved native transcripts

Inspect and export retained messages and tool results without resuming a model:

```sh
hcn inspect pi --transcript
hcn transcript read pi --file /path/to/native.jsonl > transcript.jsonl
hcn transcript ls --limit 20
```

`hcn transcript ls` lists the saved native sessions of every harness for one
workspace, newest first, computed from the native stores on each call.

Pi v3 supports full reads, batches, and caller-held bookmarks. Codex 0.147.0
legacy and paginated rollouts support full reads, ID lookup, batches, and
bookmarks, including verified inherited ranges. Compressed sources are
unsupported. Claude main-file history and Muse schema-1 session logs support
ID/file reads, batches and bookmarks through a passive filesystem clone on
supported macOS/Linux filesystems. Cursor chat stores and Antigravity step logs
use the same clone. A Cursor chat refuses while a turn is still writing it and
reads normally once the turn ends. See [native transcripts](docs/transcripts.md)
for the listing contract, capability checks, failure handling, custom Pi
conditions, and consumer rules.

### Native terminal resume (`hcn interactive`)

This operation resumes an exact native session with inherited terminal I/O.
The caller supplies a separate writable pipe with `--control-fd <fd>` (fd 3 or
higher), a UUID v4 `--launch-id`, `--interface`, `--resume`, and absolute `--cwd`.
`--env KEY=VALUE` uses the existing environment rules, including removal by empty
value. Optional `--startup-prompt <text>` starts one native turn on resume.
The text must be nonempty, valid UTF-8, at most 8,192 bytes and contain no NUL.
It is passed once as prompt data, including leading hyphens and newlines. Duplicate
startup options or invalid text refuse before spawn. Omitting it keeps idle resume.
No model switch, fork, fresh fallback, or native argv is accepted. The control
pipe never includes prompt text or claims prompt receipt or model adherence.

Each control line carries `v: 1`, `operation: "interactive"`, and `launchId`:

- `ready`: preflight passed. No process creation is proved yet.
- `refused`: `evidence: "spawn-not-attempted"` and a reason from
  `unsupported-interface`, `resume-unavailable`, `cwd-refused`, `invalid-request`,
  `executable-unavailable`, or `spawn-rejected`. Only this evidence proves no child.
- `started`: the exact `sessionId`, `cwd`, `interface`, and native `owner`
  (`pid`, kernel `startedAt`, `executable`). This proves creation, not history loading.
- `closed`: native `exitCode` (null for signal exit) and `cleanupComplete`.

A lost or truncated control stream is uncertain. Exit code 2 alone is not
no-child evidence because a native process can also exit with that code.
HCN supervises only its own child; the caller owns reconnect reservations and
the later proof that the native session attached.

The current implementation supports the Codex native executable on macOS/Linux,
checking an exact saved UUID and folder. Wrapper launchers, Claude, Pi, Muse,
and Codex desktop currently return unavailable. They require separate native
launch validation. This operation does not yet establish full consumer handoff
acceptance. Run `hcn interactive --help` for the command contract.

### Native approvals during one response

`hcn run codex --json --native-approvals --resume ID --cwd ABSOLUTE --native-settings-fingerprint HASH --prompt TEXT` resumes one response through Codex app-server. Obtain `HASH` from passive native settings inspection below. HCN verifies the saved source again, restores its supported settings, and compares the effective settings before sending the prompt. This is an opt-in alternative to ordinary `exec resume`.

The current lane preserves recorded read-only filesystem, restricted network, user reviewer, and `on-request` or `never` approval policy. Unsupported settings refuse before a prompt. Fresh sessions, native passthrough, explicit `--memory` or `--no-memory`, and competing model, effort, provider or permission options are refused. Memory overrides remain available on ordinary resume; this lane accepts only its verified native settings. Use `--prompt-file PATH` for a file-backed prompt; stdin is reserved for decisions, so `--prompt-file -` is refused.

After the native resume response confirms the exact session and effective settings,
HCN reports an `identity` event with `authority: "harness-minted"` before submitting
the prompt. This confirms the resumed native identity; it does not mean a new
session was created or that the response completed.

The JSON stream adds three version-1 events:

- `approval-request`: opaque `requestId`, exact `sessionId` and native `turnId`, `category`, complete plain-text `details`, and `choices` with `id`, `label`, `scope`.
- `approval-disposition`: decision `id`, `requestId`, `status` (`sent` or `rejected`), and a rejection `reason` when applicable. Malformed IDs are null.
- `approval-cleared`: `requestId` and `reason` (`native-resolved`, `turn-ended`, `process-ended`, `channel-failed`). Clearing says that the request stopped waiting; it does not prove tool success.

Send one UTF-8 NDJSON line on the same live process's stdin:

```json
{"v":1,"op":"approval","id":"<new decision UUID>","requestId":"<offered request UUID>","choiceId":"<offered choice ID>"}
```

Choices alone define authority. Supported command choices include once, native session, deny, cancel, and an explicitly offered persistent command-prefix rule. File choices show the complete patch; their session grant covers future changes to those same files. Permission requests support exact absolute-path entries and an explicit network toggle, with response or session duration and an empty denial. Native payloads remain private. Symbolic/glob/legacy permission scopes, grouped network command requests, non-local environments and file `grantRoot` currently terminate as unsupported. Native model questions and MCP elicitation are also unsupported by this responder.

A repeated decision ID with identical content returns its recorded disposition without another native write. Conflicting content is rejected. A decision is consumed before its write, so uncertain delivery is never retried. A cleared request loses its answer right. Native request IDs cannot be reused within the process because a late clear could otherwise affect a different action. HCN stores no approval state across processes; the caller owns durable choice and write-intent records.

Bounds: 4 KiB per decision including newline, 64 KiB UTF-8 details, 16 choices, 32 pending requests or buffered pre-ack requests, and 4096 request identities and recorded decisions during one process. Invalid UTF-8, framing overflow or an unsupported request ends the channel and cleans up the child. Details are never truncated into an approvable action.

Human approval waits pause inactivity detection. An explicit `--timeout` still runs. Initialize, resume and turn acknowledgement each have a 30-second protocol deadline. Closing decision stdin ends the response, including when no request is pending. HCN completes child cleanup before `done`. Existing HCN question blocks retain `awaiting-input`; native interruption reports `killed`.

Failures carry `nativeApproval` evidence: `phase` (`preflight`, `initialize`, `resume`, `turn-start`, `running`), `process` (`not-attempted`, `not-started`, `started`, `unknown`), `prompt` (`not-submitted`, `submission-unknown`, `acknowledged`), and `reason`. A prompt write without native acknowledgement is unknown delivery. Exit codes and elapsed time do not prove that a prompt was absent. This evidence never authorizes automatic replay.

### Passive native settings (`hcn inspect codex --native-settings`)

```bash
hcn inspect codex --native-settings --resume <native-session-id> --cwd <absolute-path> --json
```

This reads Codex's saved session without starting a native process. It returns the
latest supported turn or native settings update's exact model and effort, the
most recently recorded provider (initially the session header's provider),
and a SHA-256 source fingerprint. It does not resolve model aliases or apply
HCN profiles or browser preferences. A custom model selector can be inspected
even when ordinary `hcn run --model` does not accept it.

The result is one JSON object, with or without `--json`. `status: "available"`
exits 0; `status: "unavailable"` and a `reason` exit 2. Other harnesses return
`unsupported-harness`. The operation accepts only `--resume` (or `--session-id`), `--cwd`, and
`--json`; other inspection modes, turn options and native passthrough are refused.

The lookup requires one matching native session file, its matching header ID,
and matching saved folders. Symlinks, special files, incomplete or malformed
records, missing settings, and changed sources refuse. The scan is bounded at
16384 directory entries, 64 MiB per file and 1 MiB per line. An invalid latest
turn or settings update never falls back to earlier settings. Conversation text is never returned.

The `permissions` field reports recorded local-command limits separately from
model settings. The currently recognized native profile is read-only filesystem
access with restricted network access and an explicit `never` or `on-request`
approval policy. These values carry `status: "recorded"`. Missing, extended,
contradictory or unsupported permission metadata carries `status: "unavailable"`
and a permission-specific reason; model inspection can still succeed. An older
v1 producer may omit this field, which means unknown. The latest turn or
settings update supplies both facets; permission grants never fall back to an
earlier record. Named-profile provenance, network overrides and extra filesystem
policy are unavailable until their full restoration semantics are supported.

When recorded, `permissions.approvalsReviewer` identifies `user`, `automatic`, or
`unknown`. An omitted reviewer is also unknown. Codex retains its last explicit
reviewer when a later turn omits or nulls that field; inspection follows this
native rule without inheriting older permission grants. An unrecognized explicit
reviewer replaces older authority with unknown. A settings update without its
required reviewer also yields unknown. The fingerprint includes this facet.

Recorded permissions are observations, not a promise that headless resume can
preserve them. In Codex 0.154.0, a disposable native probe changed `on-request`
to `never` during `exec resume`, with the read-only sandbox unchanged. The
verified settings flag below restores model, effort and provider only. It does
not restore the recorded approval policy or native permission profile.

The fingerprint identifies this read, including file identity and metadata. Use
it to require the same source when resuming:

```bash
hcn run codex --resume <native-session-id> --cwd <absolute-path> --native-settings-fingerprint <fingerprint> --prompt "continue"
```

Planning and the runner each read the native source again. A matching read
renders the saved model, effort and recorded provider before the prompt. Competing
`--model`, `--effort`, `--provider`, native passthrough, fresh launch and other
harnesses refuse. `inspect --argv` and `inspect --runtime` support the same flag.
Ordinary resume without this flag still follows native settings behavior.

`native-settings-changed` means the fingerprint no longer matches;
`native-settings-unavailable` means the source cannot be read and verified.
Inspect the same native session again before retrying. A planning refusal exits
2; a refusal found at the final runner read uses the failure/done stream and
exits 1. Exit status alone does not prove whether a process started.

These operations grant no ownership or permissions. The fingerprint does not
capture provider configuration contents or freeze another process's writes.
Callers still own duplicate-session prevention, permissions, input delivery and
process cleanup. This is not completed consumer handoff support.

### Machine session (`hcn session <harness> --json`)

`--json` is the same session for a program instead of a human: NDJSON events
on stdout, NDJSON commands on stdin, for a consumer that owns its own input
timing (queue, fence, replay). Without `--json` the human REPL is unchanged.

stdout is NDJSON only - no prompt, no rendered text. The first line is a
`session` event, the last is one `closed` line. Each turn between them is a
`turn` line, the harness's own `HarnessEvent` lines (the same kinds as
`hcn run --json`; see "Reference"), and a turn-scoped `done` (`exitCode`
null; a turn cut short by the harness dying carries the process exit code,
equal to `closed.exitCode`). The four control events that frame the stream:

```jsonl
{"kind":"session","sessionId":"..","harness":"claude","hcn":"0.5.3","escalateQuestions":true,"origin":"fresh"}
{"kind":"turn","turnId":"<sessionId>:turn-1","id":"in-1"}
{"kind":"disposition","id":"in-1","disposition":"started"}
{"kind":"closed","exitCode":0,"cause":"clean"}
```

- `session.sessionId` is the caller-side handle (the `--session-id` value,
  or a random UUID). The `identity` event inside the first turn carries the
  id the harness confirmed; on pi that is the harness-minted id.
- `session.origin` is `fresh` for a new conversation or `resumed` when `--resume` (or its `--session-id` alias) continued a conversation that already exists in the harness store. A refused unknown-id resume emits no `session` event at all.
- `turn.id` is the id of the `send` that opened the turn.
- `closed.cause` is one of `clean`, `limit`, `crash`, `stall`, `killed`.
  `closed.failure` carries the reduced `FailureSummary` when the cause is
  not clean and a failure was seen. `awaiting-input` ends a turn, never a
  session.

stdin carries one command per line (blank lines are ignored):

```jsonl
{"op":"send","id":"in-1","text":"explain a monad in one sentence"}
{"op":"answer","id":"in-2","text":"prod"}
{"op":"close"}
```

- Every well-formed `send`/`answer` gets exactly one `disposition` event,
  in command order. `started`: the text was written to the harness. When
  no turn was open, a turn opened; when one was, the harness holds the
  text natively and the next turn consumes it (hcn keeps no queue of its
  own - ADR 0007). `rejected`: the text was not delivered and will not be.
  Rejected reasons: `closed` (session closing or harness dead),
  `no-open-question` (`answer` with no `awaiting-input` turn to answer),
  `write-failed` (the harness's stdin pipe broke; a `closed` follows).
- A send's id rides to the turn it opens: correlate by reading `turn.id`,
  not by counting turns.
- `answer` composes hcn's question-answer preamble
  (`The user answered the question: "<q>" with: <text>. Continue accordingly.`)
  around the text, so the consumer never re-derives it. A plain `send` after
  a question opens a turn with no preamble: `answer` to answer, `send` to
  change the subject.
- End of stdin means `close`. A malformed line (not JSON, unknown `op`,
  missing or empty `id`, non-string `text`) produces an `error` event, no
disposition, and the session continues.

Exit codes: 0 when `closed.cause` is `clean`; 1 otherwise; 2 for a refusal
before the stream opens (invalid flag, no-session-mode harness, unknown
model, unknown effort, provider off pi, bad `--stall`). A refusal still owes the stream its
terminal pair: the prose goes to stderr, and stdout carries
`{"kind":"failure",...}` then `{"kind":"closed","cause":"failed"}`. A spawn
failure (harness binary missing) writes a `transport` failure and the same
`closed`, exit 1. The exit code is always set after the terminal line is
flushed, so a consumer reading to `closed` never loses it. If the consumer
stops reading and stdout breaks (EPIPE), hcn closes the session - grace,
then signal - and exits 1, rather than leaving the harness child running.

Session flags on `--json`: `--stall <seconds>` is a per-turn inactivity
budget - a turn that produces no output for the budget ends `done` with
`cause: "stall"` and the session closes with `cause: "stall"`. `0`
disables it; there is no default. `--provider` is pi only, validated the
same way as on `hcn run` and refused elsewhere with exit 2. `--effort <v>`
sets the effort for the session spawn, validated against the ladder that
applies to the picked `--model` exactly as on `hcn run` (claude `--effort`,
pi `--thinking`); a session without it runs at the harness's own default
- no profile effort is pinned onto sessions. The other
session flags (`--model`, `--session-id`, `--cwd`, `--escalate-questions` /
`--no-escalate-questions`) behave as in the REPL.

One send, then close (stdin EOF after the send lets the turn finish, then
closes the session):

```bash
printf '%s\n' '{"op":"send","id":"in-1","text":"say hi"}' \
  | hcn session claude --json | jq -c '{kind, disposition, cause}'
```

Driving it from a process that keeps the session open:

```js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("hcn", ["session", "claude", "--json"], {
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.write(`${JSON.stringify({ op: "send", id: "in-1", text: "say hi" })}\n`);

const rl = createInterface({ input: child.stdout });
for await (const line of rl) {
  const ev = JSON.parse(line);
  if (ev.kind === "message") console.log(ev.text);
  if (ev.kind === "disposition") console.error(`in=${ev.id} ${ev.disposition}`);
  if (ev.kind === "closed") console.error(`closed cause=${ev.cause} exit=${ev.exitCode}`);
}
```

Inspection and drift (no spawn):

```bash
hcn ls
hcn inspect claude
hcn inspect claude --argv --prompt "hi" --effort high
hcn inspect claude --capabilities
hcn inspect pi --capabilities --mode headless-session --model zai/glm-5.2
hcn check
hcn check --json
```

`--capabilities` prints the capability record (`vision`, `images`,
`streaming`, `session`, `source`, `confidence`) as one JSON line for the
given `--mode` (`headless-turn` | `headless-session` | `interactive`;
default `headless-turn`) and `--model` (absent = the harness default model;
a model outside the vocabulary degrades to `source: "unknown"`). It is
mutually exclusive with `--argv` and `--runtime`.

`hcn inspect claude --context --model opus --prompt-file request.txt --json`
reports a native estimate of the full staged request, including native history
when `--resume ID` is given. The result includes the resolved executable,
version, observed model, used tokens, and supported input limit. Callers own
their extra reserve and dispatch policy. The probe forks resumed sessions with
persistence disabled and stages the prompt with `shouldQuery:false`; it never
asks the assistant to execute it. Native startup hooks can still run. The
Claude headless-turn adapter supports this operation, including fresh
`--isolation tool-free` requests. It validates the native operation independently
of version metadata. Other adapters report unavailable.
Persistent-process accounting is not established by this command. It refuses
native passthrough and other inspection modes, bounds serialized prompts to
8 MiB, and defaults to a 30-second deadline followed by bounded process cleanup.
A positive `--timeout` or configured timeout changes that deadline; zero keeps
the bounded default. Interruption aborts and cleans up before exiting 1.
Invalid requests exit 2 with the standard failure/done pair under `--json`.
An ordinary inspection returns one version-1 JSON object. `accounting.status`
is `available` or `unavailable`; an available result carries
`method: "native-context-estimate"`, `model`, `totalTokens`,
`contextWindowTokens`, and `inputLimitTokens`. The input limit is the smaller
of the native window and its enabled automatic-compaction threshold.
Unavailable reasons distinguish unsupported adapters,
auth or limit failures, native exits, transport bounds/errors, invalid native
protocol, timeout, cancellation, and cleanup failure. Neither an unavailable
result nor a total window alone is permission to dispatch. Usage remains
provisional until output and cleanup settle. Query activity, unknown frame
categories, malformed usage, or incomplete output invalidate the count.
Known startup hooks, command lifecycle, nonblocking rate notices, and successful
zero-turn results are permitted, including nonzero aggregate usage.
`transport` with `executable.path: null` means the executable could not be
resolved; `resume.reason` supplies that safe explanation. Otherwise transport
denotes a failure to open or use the process channel.

Descriptor inspection separately exposes `nativeContextManagement`. Codex,
Muse and Cursor CLI declare `{ kind: "auto-compaction", modes: ["headless-turn"] }`,
Antigravity CLI declares the same kind for `["headless-session"]`, and Pi
declares it for both headless modes. Claude declares
`{ kind: "native-session-auto-compaction", modes: ["headless-turn"] }`.
Only the mode a live probe observed is claimed, so a null or a missing mode is
unknown support, never a denial. This covers native session growth; callers
must still prepare imported history.
Fresh mandatory content can exceed the native request limit, and compaction
does not promise lossless recall.
These declarations describe native handling, not a count or a
successful budget check. Callers decide whether to delegate context management
after verifying the selected executable and mode. Codex and Muse preflight accounting
continue to return `unsupported-adapter`. A declaration is a curated descriptor
fact; it does not detect whether native compaction is currently enabled.

`hcn inspect <harness> --runtime --prompt "validation"` reports version-1
JSON containing redacted argv, the resolved executable path and version,
the adapter's verified version, and native-resume compatibility. This runs
only a version probe. The argv is a diagnostic preview, not a command to
execute. All six harnesses use invocation-based resume admission, including
supported persistent sessions. A resolved executable and a supported invocation
are required; missing or different version metadata does not reject them.
The native operation can still fail on changed flags, protocol, or session state.
No admission result proves session existence or
recall. Pass the same working folder and options as the intended turn.

For persistent resume use `--mode headless-session --resume <session-id>`.
That preview needs no prompt and accepts model, effort, provider, and cwd.
It refuses other process options that persistent startup cannot apply,
including tool grants, environment overrides, and native passthrough.

Flag table (maps to `TurnOptions` / `TurnRunOptions`):

Claude prompts larger than 65,536 UTF-8 bytes use native print-mode stdin,
with an empty prompt argument. This applies to fresh and resumed turns and
keeps large requests out of the operating system's argument limit. The
descriptor reports this alternate transport as `launch.stdinPrompt`.
The same composed prompt is written once and stdin is closed. A broken pipe
is a transport failure and terminates that child; a late pipe error after
the child exits preserves its native failure classification. Ordinary prompts retain
their existing argv shape. This uses Claude's documented
[piped input](https://code.claude.com/docs/en/headless#pipe-data-through-claude)
support; its native 10MB input cap still applies.

| CLI flag | TurnOptions field | Notes |
|---|---|---|
| `--prompt <text>` | `prompt` | Alternative to positional; mutual exclusion |
| `--prompt-file <path\|->` | `prompt` | Reads UTF-8 file or stdin (`-`) |
| `--isolation <tool-free>` | `isolation` | Fresh Claude run only; no tools or native discovery; invocation-only |
| `--model <id>` | `model` | Validated via `validateModel` |
| `--effort <value>` | `effort` | Validated via `validateEffort` |
| `--sandbox <value>` | `sandbox` | Codex; Antigravity accepts normalized `workspace-write` and renders its boolean `--sandbox` flag |
| `--context-window <tokens>` | `contextWindow` | Codex, integer 1-272000; launch default 272000 |
| `--provider <value>` | `provider` | pi only |
| `--tools <a,b>` | `tools` | Canonical names (read, write, edit, shell, grep, glob, list, web-fetch, web-search, subagent, skill); `native:<name>` passes a harness-native or extension tool through. Per-tool allowlist; claude and pi (pi strict, claude via grant + deny-complement). A bare name matching a configured toolset expands to it |
| `--exclude-tools <a,b>` | `excludeTools` | Canonical names (same vocabulary, `native:<name>` passthrough); complement over known tool names; mutually exclusive with `--tools` |
| `-- <harness args>` | `passthrough` | Verbatim harness tokens rendered at the harness's descriptor placement with no separator (ADR 0003); failures surface as labeled native errors (hcn exit 1, native exit code as data). A harness that declares `prompt-joins` refuses a non-empty tail before spawn instead of rewriting the prompt (none do today) |
| `--autonomy` / `--no-autonomy` | `autonomy` | |
| `--write` / `--no-write` | `write` | Muse |
| `--shell` / `--no-shell` | `shell` | Muse |
| `--memory` / `--no-memory` | `memory` | Persistent cross-session memory, default OFF (profile). claude renders the `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` spawn env var (shown as an `env:` line in `inspect --argv`, never an argv token); codex renders `--disable memories`; pi has no built-in memory (renders nothing - already off); muse cannot turn memory off (explicit values refuse with a hint; the profile default reports divergence and muse's memory tools stay on). `--memory` removes HCN's disable override and uses native settings; it does not force memory on. Config key `memory` in both tiers |
| `--max-steps <n>` | `maxSteps` | Muse, 1-10000 |
| `--no-tools, --no-instruction-files, --no-extensions, --no-skills` | `discovery` | |
| `--cwd <path>` | `cwd` | Working directory |
| `--env KEY=VAL` | `env` | Repeatable; `KEY=` deletes |
| `--resume <uuid>` | `resume` | Resume session |
| `--session-id <uuid>` | `resume` | Alias for `--resume`; UUID of session to resume or re-enter |
| `--resume-last` | `resumeLast` | Resume the harness's most recent session in the spawn cwd, without naming an id (claude, codex, pi, cursor, antigravity; muse refuses). Mutually exclusive with `--resume`/`--session-id`; refused on `hcn session`, with `--native-approvals`, and with `--native-settings-fingerprint` |
| `--skills <a,b>` | `skills` | Skill allowlist; claude, pi and codex (pi strict via --skill, claude via --settings skillOverrides, codex via -c skills.config) |
| `--timeout <seconds>` | `timeoutSeconds` | Wall-clock budget for the run (hcn-enforced; 0 disables; no default) |
| `--escalate-questions` / `--no-escalate-questions` | `escalateQuestions` | Let worker ask when blocked (DEFAULT) / never ask, state assumption and continue |
| `--system-prompt <text>` | `systemPrompt` | Replace built-in system prompt (claude, pi; codex uses -c instructions; muse refuses) |
| `--append-system-prompt <text>` | `appendSystemPrompt` | Append to built-in prompt (claude, pi only) |
| `--access <read|write>` | `access` | Access preset - read = read, grep, glob, list, web-fetch, web-search (canonical); write = no restriction; claude/pi via --tools (toolMap aware), codex via --sandbox, muse via --disable-write/--disable-shell; mutually exclusive with --tools/--exclude-tools and with --sandbox on codex; no default |
| `--json` | output mode | NDJSON `HarnessEvent` to stdout |

For development, `bun run demo claude "hi"` remains as a live-rendering alternative.

### Tool-free turns

`hcn run claude --isolation tool-free --model opus --effort high --timeout 60 "Name this quoted prompt"`
starts a separate turn with built-in tools and MCP tools disabled. It also
skips native instruction, hook, skill, and extension discovery. This option
is invocation-only. Other harnesses refuse it. Resume, sessions, native
passthrough, and explicit tool, skill, access, autonomy, or discovery overrides
refuse. Config defaults for these dimensions yield to tool-free isolation;
model and effort defaults still apply.

Claude uses bare mode, which requires authentication that works in that mode;
OAuth-only installations may fail. A caller doing optional naming must keep
its fallback on failure. See the [native CLI reference](https://code.claude.com/docs/en/cli-reference).

### Resume-last

`hcn run <harness> --resume-last "prompt"` resumes the harness's most
recent session in the exact spawn cwd through each harness's own
most-recent grammar (claude `--continue --fork-session`, codex
`exec resume --last`, pi `--continue`, cursor `--continue`, Antigravity
`--continue`; muse refuses with
`unsupported-option`). Most-recent resolution stays inside the harness;
hcn only renders. A resume-last turn is resume-semantics: no defaults
profile runs, so a silently created session runs with native defaults.

Every resume-last turn emits one fixed pre-spawn warning event plus a
`store root <root> for scope <cwd>` diagnostic event before any harness
output, and, where a per-cwd directory exists (claude, pi, cursor),
warns (never refuses) when the per-cwd store directory is
absent. The `identity` event carries `resumeLast: true`:
the announced id was picked by the harness as most-recent, never
requested by the caller, and MAY be a fresh session or a stranger
session (another run's session, including a killed, failed, or unrelated
run's). On claude the announced id is the fork id, never the source id.
Callers that need strict continuation store ids and use `--resume`.

## Defaults, config, provenance

Every launch resolves through one precedence chain:

```
args  >  .hcn/config.json (git root, auto-discovered)  >  ~/.config/hcn/config.json (XDG)  >  built-in profile  >  harness default
```

The built-in profile pins the ratified defaults: effort `medium` (the only
value in all five uniform ladders; profile-tier effort reports divergence on
cursor, whose ladders are per-family), sandbox `workspace-write` (codex and
Antigravity; reported as divergence elsewhere), context window `272000` (codex-only; divergence
elsewhere), discovery fully on, autonomy off, memory off. A dimension a
harness cannot express is reported as divergence, never a silent skip and
never a refusal. Resume turns bypass turn-option resolution and pass explicit
turn options. Omitted settings follow the native harness's resume behavior;
Codex can use current configuration instead of the saved model and effort.
Do not infer settings preservation from session-ID continuity. Question escalation (below) is the
deliberate exception: it rides each turn's prompt, so it resolves on
launch AND resume.

User config (`~/.config/hcn/config.json`, `$XDG_CONFIG_HOME` respected):

```json
{ "version": 1, "effort": "high" }
```

`memory: true` in either config tier removes HCN's disable override for
that machine or repo. Native memory settings still apply:

```json
{ "version": 1, "memory": true }
```

Codex callers can set `"contextWindow": 100000` in either config file or
pass `--context-window 100000`. The range is 1-272000 tokens. hcn renders
the numeric Codex override `-c model_context_window=272000` for a bare
launch. Resume applies only an explicit flag, without profile or config
defaults. Codex owns automatic compaction; this setting is not a hard
per-request token or billing limit. A large prompt or tool result can
exceed the configured window before compaction. Native arguments after
`--` can also override it. See the [Codex config reference](https://developers.openai.com/codex/config-reference).

Project config (`.hcn/config.json` at the git root, code-reviewed with the
repo) also carries tool floors and named toolsets:

```json
{
  "version": 1,
  "effort": "low",
  "tools": ["read", "grep", "glob", "list"],
  "toolsets": { "review": ["read", "grep"] }
}
```

The project `tools` key is both the default grant and the FLOOR: a `--tools`
arg exceeding it refuses with exit 2 naming both sets - never a silent
clamp. An empty floor refuses every grant (the turn-everything-off
workflow). Config parsing is hard-fail: unknown keys, malformed JSON, or a
version mismatch exit 2 naming the offender.

### Tool names

`--tools` and `--exclude-tools` accept canonical names only. Bare native names are not accepted; use `native:<name>` to pass a harness-native or extension tool through. The live table is printed by `hcn inspect <harness>` (`toolVocabulary`).

| canonical | claude | pi | codex | muse |
|---|---|---|---|---|
| read | Read | read | - | - |
| write | Write | write | - | category write |
| edit | Edit | edit | - | category write |
| shell | Bash | bash | - | category shell |
| grep | Grep | grep | - | - |
| glob | Glob | find | - | - |
| list | - | ls | - | - |
| web-fetch | WebFetch | - | - | category web |
| web-search | WebSearch | - | - | category web |
| subagent | Task | - | - | - |
| skill | Skill | - | - | - |

`toolMap` extends the vocabulary per harness via config (`toolMap.<harness>.<canonical> = "<native>"`):

```json
{ "version": 1, "toolMap": { "pi": { "web-search": "web_search" }, "muse": { "write": "write_file" } } }
```

Precedence is `project > user`; a category-only harness (muse) refuses a `toolMap` key whose canonical is not in its categories, naming the key (e.g. `toolMap.muse.read`). A canonical name with no counterpart on the current harness refuses with `unsupported-option` and the hint `add toolMap.<harness>.<name> to ~/.config/hcn/config.json or pass native:<name>`. hcn cannot verify that a declared native name exists at run time; a wrong name reaches the harness as an unknown tool.

On pi, `--tools` is a strict allowlist: any rendered list - an explicit
grant or `--access read` - drops the extension and MCP tools pi registered
at run time (`web_search`, `background_task`, tool-proxy). A bare pi run
therefore renders no list (the profile's all-known marker emits nothing on
a strict-allowlist harness; pi's dormant `grep`, `find`, `ls` stay off
unless granted). A pi grant that needs an extension tool names it through
`toolMap` or `native:<name>`.

`--access` is a preset allowlist: `read` = `read, grep, glob, list, web-fetch, web-search` (canonical), `write` = no restriction.

Rendering per harness:

| harness | `read` renders | `write` renders |
|---|---|---|
| claude | `--allowedTools Read,Grep,Glob,WebFetch,WebSearch` + deny complement (toolMap aware) | nothing (harness default) |
| pi | `--tools read,grep,find,ls` (+ web-search via toolMap) | nothing |
| codex | `--sandbox read-only` | `--sandbox workspace-write` |
| muse | `--disable-write --disable-shell` | nothing |

`--access` together with `--tools` or `--exclude-tools` in the same run refuses `mutually-exclusive-options` (access is a preset allowlist, not a filter over one). `--access` together with an explicit `--sandbox` on codex refuses the same way.

## Question escalation (issue #41)

A headless worker can ask the CALLER's user when a genuine decision blocks
progress, and the answer flows back via resume. `escalateQuestions`
defaults ON (`--escalate-questions` / `--no-escalate-questions`, config
key `escalateQuestions` in both tiers; precedence arg > project > user >
default). It is a behavior instruction, not a turn option: no flag ever
reaches the harness - the transport is a short protocol contract hcn
prepends to the prompt. It is independent of autonomy by ratified design:
autonomy covers interrupts the HARNESS raises (permission gates),
escalateQuestions covers interrupts the MODEL raises (judgment gaps) -
`--autonomy --escalate-questions` is "tools free, judgment supervised."

Protocol: a worker that must ask ends its turn with a fenced `hcn-question`
block (`{"question","options":[..],"recommended":..}`) as the last content
of its final message. hcn detects it and emits a typed `question` event
(structured-first: the fields ARE the question; prose renders from them);
`done` carries cause `awaiting-input` with process exit 0 - asking is a
successful turn. The caller escalates through its own question tool, then
resumes with the answer: `hcn run <harness> --resume <id> --prompt "<answer>"`.
Id continuity per harness: claude stable, pi/muse caller-assigned, codex
minted (the identity event carries the id). With `--no-escalate-questions`
the worker is instructed never to ask - it states the assumption it
proceeded under and continues.

A turn that ends `awaiting-input` arms no answer timer: the process has
exited, and the session id stays resumable for as long as the harness
keeps the session. `hcn session` keeps the process alive while it waits
and applies no idle budget of its own, so the caller owns any timeout.

Every resolved setting prints its provenance to stderr:

```
provenance: effort = "high" (user-config)
provenance: discovery = {"tools":true,...} (profile)
divergence: profile "sandbox" not expressible on pi; harness default applies
```

## Concepts

Three layers, one direction: `knowledge` (frozen descriptors - facts about
each CLI, stamped to `verifiedAgainst`) feeds `interpretation` (pure
functions - argv construction, validation, refusals, option resolution)
feeds `execution` (process lifecycle - the only impure layer, through an
injected `{ spawn, clock, signal }` adapter). The source is public and the
layers are real, but they are internal structure, not an install surface:
from 1.0 the `hcn` CLI is the only supported interface.

A harness that cannot express an option REFUSES rather than guessing -
refusals carry structured fields (`supportedBy`: which harnesses express
it, with native spellings; `hint`: the nearest alternative on your current
harness). A native flag typed before `--` is recognized and redirected to
its normalized spelling.


## Failure taxonomy

Every failure - provider, work, transport, or refusal - arrives as a typed `failure` event and reduces to one self-sufficient summary on `done`:

```ts
type FailureClass = "rate-limit" | "usage-limit" | "quota" | "auth" | "budget" | "task" | "transport" | "unavailable" | "rejected" | "native" | "timeout" | "trust-refused";
interface FailureSummary { class: FailureClass; retryable: boolean; message: string; code?: LimitCode; authKind?: AuthFailureKind; resetsAt?: number; issue?: RefusalIssue; option?: TurnOptionKey; facet?: DiscoveryFacet; supported?: readonly string[]; supportedBy?: ReadonlyArray<{ harness: string; spelling: string }>; hint?: string; nativeExitCode?: number; }
type HarnessEvent = ... | ({ kind: "failure" } & FailureSummary) | { kind: "done"; exitCode: number | null; cause: ExitCause; failure?: FailureSummary };
type ExitCause = "clean" | "limit" | "crash" | "stall" | "killed" | "failed" | "awaiting-input";
```

The canonical consumer check, identical for a deterministic router and an agent:

```ts
if (done.failure) {
  if (done.failure.retryable) descendFallbackChain(done.failure);
  else pivot(done.failure); // rejected -> change options; budget -> raise cap; task -> surface
}
```

`retryable` is `false` for `task`, `budget`, `rejected`, `native`, `timeout` and `true` for the rest. `unavailable` is a provider that cannot serve the requested model or route (model not found, not loaded); retryable, route elsewhere. `rejected` is non-retryable across the whole model chain because the remedy is different options or a different harness.

`resetsAt` is present only when the harness reports a reset time (today:
claude's `rate_limit_event`); a consumer treats its absence as unknown,
not as "retry now".

### Muse pending native approvals (issue #179)

`muse exec` omits pending approvals from stdout, so a headless turn blocked
on one would hang with no event until `--timeout` (`hcn run` arms no stall
clock; `--stall` is session-only). While a muse turn runs, hcn polls the
read-only MSP `approval/listPending` operation through a helper `muse serve`
process owned by that turn and reaped with it. The helper never loads the
session, never decides anything, and carries only the blocked subject
(approval vs input), the approval's subject kind, and whether the approval
is a sandbox escalation - never request payloads.

A single non-empty sample stops nothing: judge-decided approvals for
ordinary tool calls appear briefly, then clear. The turn ends only when the
same request identity persists across 30 consecutive polls (about 30
seconds), or at once when an approval is judge-escalated (a human was
asked, and a headless run has none) or asks to run outside the muse
sandbox (`sandbox_permissions: require_escalated` in the tool args - muse
never sends that class to its approval judge, so no wait can resolve it).
A request that resolves itself (`autoResolutionMs`) is never reported
before its deadline plus a margin. Either way the turn emits an `error`
naming the blocked subject, then `failure class=task` (`retryable: false` -
a sandbox escalation names `-- --sandbox-network enabled` first: it keeps
approvals and the filesystem sandbox and fits a command that needs network
or a local listening socket; otherwise answer it in muse, or rerun with
`--autonomy` only if unattended approvals are acceptable; never auto-route)
and `done cause=failed` with exit 1. When the pending set itself cannot be
read (the helper is slow to start, crashes, or answers unreadably three
polls in a row), the turn fails closed with `failure class=transport`
(`retryable: true` - hcn could not watch the pending set, so the run was
stopped rather than risking a silent hang).

## Refusals

An unexpressible option throws `ArgvRefusalError` from the builders and is also delivered as `failure class=rejected` + `done cause=failed` from `streamTurn` (which never throws out of its first `next()`):

```ts
class ArgvRefusalError extends Error { issue: RefusalIssue; harness: HarnessName; option?: TurnOptionKey; facet?: DiscoveryFacet; supported: readonly string[]; }
type RefusalIssue = "unsupported-option" | "unsupported-option-facet" | "unsupported-on-resume" | "invalid-option-value" | "unknown-effort" | "unknown-model" | "invalid-env" | "invalid-tool-grant" | "prompt-flag-injection" | "no-autonomy-mode" | "no-session-mode";
```

Every refusal names an alternative in `supported` and `message`, not only a negation.

## Reference

- Descriptors live in `src/knowledge/` (`claude-code.ts`, `codex.ts`, `pi.ts`, `muse.ts`, `cursor.ts`, `antigravity.ts`), with shared types in `descriptor.ts`.
- The normalized event surface is `HarnessEvent` in `src/execution/events.ts`: `identity`, `token`, `message`, `progress`, `tool`, `compaction`, `limit`, `error`, `failure`, `question` (issue #41), `done` (with `done.failure`; `done.cause` includes `awaiting-input`). Event kinds and failure classes are additive across releases; a consumer ignores a kind or class it does not recognize and still waits for `done`. Additive optional fields (such as `resumeLast: true` on `identity`) never break that rule: branch on presence, never on prose.
- Narrow or override a descriptor's facts with `parseOverrides` (`src/knowledge/overrides.ts`). An override a harness cannot satisfy throws `OverrideRefusalError` instead of producing a broken argv. `limitMatchers`/`authMatchers` are now serializable `{pattern, flags, code/kind}` objects so they can be overridden from JSON; bad patterns are refused at load with file and harness named.
- `DROPPABLE_KINDS` (`token`, `progress`) marks events safe to drop when you only need the full messages. `failure` is never droppable, and neither is `compaction`.
- `compaction` reports that the harness compacted its own context (ADR 0009). It carries `state`, a closed union of `started`, `compacted`, `noop`, `failed` and `aborted`, so a consumer branches with no default arm. `trigger` (`auto`, `manual`, `overflow`), `tokensBefore`, `tokensAfter` and `durationMs` are present only where the harness itself reported them; hcn derives none of them, and no harness pushes a context-occupancy percentage on a live signal. `detail` carries the harness's own reason or error text, so branch on `state` and never on it. Claude emits `started` and `compacted`, with `failed` on a failed compaction. Pi emits `started` and `compacted` with `trigger` on both, and `aborted` or `failed` when its end record carries no result; pi's own `threshold` reason normalizes to `auto`. The remaining harnesses arrive in later releases, and a harness with no live signal reports none at all. Silence is not evidence that no compaction happened. **Count `compacted`, not `started`:** hcn reports each record the harness sends, and claude has been observed sending two `compacting` status records for one compaction, so a start can repeat. A compaction can also arrive **between** turns - pi checks its threshold before a new prompt, so the event may reach a session caller on the next turn rather than the one that triggered it.
- **Compaction pauses the stream.** A harness goes quiet while it compacts: measured 25 to 47 s on claude, 24 to 33 s on codex, 25 to 39 s on cursor, 4.5 to 18 s on antigravity, 7 to 10 s on pi and about 7 s on muse (`docs/research/2026-09-22-compaction-signals/`). Set `--stall` above those, or a healthy run is killed mid-compaction. `--stall` is opt-in and unset by default.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: run `pnpm check` before pushing, so lint, typecheck, vitest, and the bun test lane all pass. Keep the layer purity and chat-seam invariants intact, and do not edit files under `test/fixtures/`. Commits follow Conventional Commits.

## Status

1.0. CLI-only surface. Six harnesses are described (Claude Code, Codex,
pi, Muse, Cursor CLI, Antigravity CLI); one-shot turns are normalized across all six with a ratified
defaults profile, user and project config tiers, tool selection
(include/exclude with floors and named toolsets), passthrough with native
error labeling, and provenance on every resolved setting. Persistent
sessions (`hcn session`) are available for claude, pi, and Antigravity. Antigravity's
authenticated contract is verified against `1.2.8`; its account model list stays
extensible because plan eligibility and configured custom models can differ. Drift detection runs weekly
in CI for the three npm harnesses; Muse, Cursor CLI, and Antigravity CLI are `installed`
and only checked locally via their native version commands. Re-verifying a descriptor's capability
claims against a new CLI version follows the [harness update procedure](docs/harness-updates.md):
local behavioral probes and fixture capture. CI tests version-independent
admission and the recorded contracts; a version difference alone never disables
an invocation. Authentication
and usage-limit signals are parsed from each harness's stream, but hcn
never holds or ships credentials; each harness authenticates under the
end user's own session.


## Prior art

The six harness CLIs this normalizes: [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), [Codex](https://www.npmjs.com/package/@openai/codex), [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Muse (installed from source, not on a registry), Cursor CLI (installed via script, binary `agent`, not on a registry), and [Antigravity CLI](https://antigravity.google/docs/cli/).

## License

MIT. See [LICENSE](LICENSE).
