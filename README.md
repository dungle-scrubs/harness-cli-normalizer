# harness-cli-normalizer

One stable interface to four coding-agent CLIs.

[![CI](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/harness-cli-normalizer.svg)](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- D-001 / v1: CLI-only -->
harness-cli-normalizer is a CLI, `hcn`, that normalizes four coding-agent harnesses - Claude Code, Codex, pi, and Muse - into one surface: normalized flags, ratified behavior defaults, a single `HarnessEvent` NDJSON stream, and one exit-code contract. It normalizes the interface and the defaults, and reports divergence where a harness cannot express a dimension - it does not pretend parity. There is no library API; the `hcn` binary is the product. Descriptors are pinned to their verified CLI version and a weekly check flags when a harness has moved ahead (npm harnesses via registry; `muse` via local `muse --version`, skipped in CI where not installed - see Version-pinning and drift).

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
```

Piped JSON for programmatic use:

```bash
hcn run claude "say hi" --json | jq .
hcn run claude "hi" --json | head -n 5  # abandonment-safe, no hanging handles
```

Session (claude, pi):

```bash
hcn session claude
hcn session claude --model opus --session-id 550e8400-e29b-41d4-a716-446655440000
```

Inspection and drift (no spawn):

```bash
hcn ls
hcn inspect claude
hcn inspect claude --argv --prompt "hi" --effort high
hcn check
hcn check --json
```

Flag table (maps to `TurnOptions` / `TurnRunOptions`):

| CLI flag | TurnOptions field | Notes |
|---|---|---|
| `--prompt <text>` | `prompt` | Alternative to positional; mutual exclusion |
| `--prompt-file <path\|->` | `prompt` | Reads UTF-8 file or stdin (`-`) |
| `--model <id>` | `model` | Validated via `validateModel` |
| `--effort <value>` | `effort` | Validated via `validateEffort` |
| `--sandbox <value>` | `sandbox` | Codex only |
| `--provider <value>` | `provider` | pi only |
| `--tools <a,b>` | `tools` | Canonical names (read, write, edit, shell, grep, glob, list, web-fetch, web-search, subagent, skill); `native:<name>` passes a harness-native or extension tool through. Per-tool allowlist; claude and pi (pi strict, claude via grant + deny-complement). A bare name matching a configured toolset expands to it |
| `--exclude-tools <a,b>` | `excludeTools` | Canonical names (same vocabulary, `native:<name>` passthrough); complement over known tool names; mutually exclusive with `--tools` |
| `-- <harness args>` | `passthrough` | Verbatim harness tokens; failures surface as labeled native errors (hcn exit 1, native exit code as data) |
| `--autonomy` / `--no-autonomy` | `autonomy` | |
| `--write` / `--no-write` | `write` | Muse |
| `--shell` / `--no-shell` | `shell` | Muse |
| `--max-steps <n>` | `maxSteps` | Muse, 1-10000 |
| `--no-tools, --no-instruction-files, --no-extensions, --no-skills` | `discovery` | |
| `--cwd <path>` | `cwd` | Working directory |
| `--env KEY=VAL` | `env` | Repeatable; `KEY=` deletes |
| `--resume <uuid>` | `resume` | Resume session |
| `--session-id <uuid>` | `resume` | Alias for `--resume`; UUID of session to resume or re-enter |
| `--skills <a,b>` | `skills` | Skill allowlist; claude and pi (pi strict, claude via settings) |
| `--timeout <seconds>` | `timeoutSeconds` | Wall-clock budget for the run (hcn-enforced; 0 disables; no default) |
| `--escalate-questions` / `--no-escalate-questions` | `escalateQuestions` | Let worker ask when blocked (DEFAULT) / never ask, state assumption and continue |
| `--system-prompt <text>` | `systemPrompt` | Replace built-in system prompt (claude, pi; codex uses -c instructions; muse refuses) |
| `--append-system-prompt <text>` | `appendSystemPrompt` | Append to built-in prompt (claude, pi only) |
| `--access <read|write>` | `access` | Access preset - read = read, grep, glob, list, web-fetch, web-search (canonical); write = no restriction; claude/pi via --tools (toolMap aware), codex via --sandbox, muse via --disable-write/--disable-shell; mutually exclusive with --tools/--exclude-tools and with --sandbox on codex; no default |
| `--json` | output mode | NDJSON `HarnessEvent` to stdout |

For development, `bun run demo claude "hi"` remains as a live-rendering alternative.

## Defaults, config, provenance

Every launch resolves through one precedence chain:

```
args  >  .hcn/config.json (git root, auto-discovered)  >  ~/.config/hcn/config.json (XDG)  >  built-in profile  >  harness default
```

The built-in profile pins the ratified defaults: effort `medium` (the only
value in all four ladders), sandbox `workspace-write` (codex-only; reported
as divergence elsewhere), discovery fully on, autonomy off. A dimension a
harness cannot express is reported as divergence, never a silent skip and
never a refusal. Resume turns bypass turn-option resolution entirely - a
session keeps its own settings. Question escalation (below) is the
deliberate exception: it rides each turn's prompt, so it resolves on
launch AND resume.

User config (`~/.config/hcn/config.json`, `$XDG_CONFIG_HOME` respected):

```json
{ "version": 1, "effort": "high" }
```

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
type FailureClass = "rate-limit" | "usage-limit" | "quota" | "auth" | "budget" | "task" | "transport" | "rejected" | "native" | "timeout";
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

`retryable` is `false` for `task`, `budget`, `rejected`, `native`, `timeout` and `true` for the rest. `rejected` is non-retryable across the whole model chain because the remedy is different options or a different harness.

`resetsAt` is present only when the harness reports a reset time (today:
claude's `rate_limit_event`); a consumer treats its absence as unknown,
not as "retry now".

## Refusals

An unexpressible option throws `ArgvRefusalError` from the builders and is also delivered as `failure class=rejected` + `done cause=failed` from `streamTurn` (which never throws out of its first `next()`):

```ts
class ArgvRefusalError extends Error { issue: RefusalIssue; harness: HarnessName; option?: TurnOptionKey; facet?: DiscoveryFacet; supported: readonly string[]; }
type RefusalIssue = "unsupported-option" | "unsupported-option-facet" | "unsupported-on-resume" | "invalid-option-value" | "unknown-effort" | "unknown-model" | "invalid-env" | "invalid-tool-grant" | "prompt-flag-injection" | "no-autonomy-mode" | "no-session-mode";
```

Every refusal names an alternative in `supported` and `message`, not only a negation.

## Reference

- Descriptors live in `src/knowledge/` (`claude-code.ts`, `codex.ts`, `pi.ts`, `muse.ts`), with shared types in `descriptor.ts`.
- The normalized event surface is `HarnessEvent` in `src/execution/events.ts`: `identity`, `token`, `message`, `progress`, `tool`, `context` (reserved - emitted only when a harness exposes context-window usage on its stream; none does at this version), `limit`, `error`, `failure`, `question` (issue #41), `done` (with `done.failure`; `done.cause` includes `awaiting-input`). Event kinds and failure classes are additive across releases; a consumer ignores a kind or class it does not recognize and still waits for `done`.
- Narrow or override a descriptor's facts with `parseOverrides` (`src/knowledge/overrides.ts`). An override a harness cannot satisfy throws `OverrideRefusalError` instead of producing a broken argv. `limitMatchers`/`authMatchers` are now serializable `{pattern, flags, code/kind}` objects so they can be overridden from JSON; bad patterns are refused at load with file and harness named.
- `DROPPABLE_KINDS` (`token`, `progress`, `context`) marks events safe to drop when you only need the full messages. `failure` is never droppable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: run `pnpm check` before pushing, so lint, typecheck, vitest, and the bun test lane all pass. Keep the layer purity and chat-seam invariants intact, and do not edit files under `test/fixtures/`. Commits follow Conventional Commits.

## Status

1.0. CLI-only surface. Four harnesses are described (Claude Code, Codex,
pi, Muse); one-shot turns are normalized across all four with a ratified
defaults profile, user and project config tiers, tool selection
(include/exclude with floors and named toolsets), passthrough with native
error labeling, and provenance on every resolved setting. Persistent
sessions (`hcn session`) are available for claude and pi. Drift detection runs weekly
in CI for the three npm harnesses; Muse is `installed` and only checked
locally via `muse --version`. Re-verifying a descriptor's capability
claims against a new CLI version is a local, manual step
(`bun run smoke:seven`) plus fixture re-capture, not CI. Authentication
and usage-limit signals are parsed from each harness's stream, but hcn
never holds or ships credentials; each harness authenticates under the
end user's own session.


## Prior art

The four harness CLIs this normalizes: [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), [Codex](https://www.npmjs.com/package/@openai/codex), [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), and Muse (installed from source, not on a registry).

## License

MIT. See [LICENSE](LICENSE).
