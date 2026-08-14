# harness-cli-normalizer

One stable interface to four coding-agent CLIs.

[![CI](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/harness-cli-normalizer.svg)](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- D-001 -->
harness-cli-normalizer describes Claude Code, Codex, pi, and Muse as pure data and normalizes their headless output to a single `HarnessEvent` stream. You build one consumer against that stream instead of a separate spawn-and-parse path per CLI - the execution layer spawns the harness and emits the events. Use it for multi-agent work like an orchestrator, observer, benchmark rig, or to swap agents. Descriptors are pinned to their verified CLI version and a weekly check flags when a harness has moved ahead (npm harnesses via registry; `muse` via local `muse --version`, skipped in CI where not installed - see Version-pinning and drift).

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

## Use it

One-shot headless turn, the simplest path:

```ts
import {
  claudeCode,
  nodeRunnerDeps,
  streamTurn,
} from "@dungle-scrubs/harness-cli-normalizer";

for await (const event of streamTurn(
  claudeCode,
  { prompt: "explain a monad in one sentence", cwd: process.cwd() },
  nodeRunnerDeps(),
)) {
  if (event.kind === "message") console.log(event.text);
  if (event.kind === "done") console.log(`exit: ${event.cause}`);
}
```

Swap `claudeCode` for `codexCli`, `piCli`, or `museCode` and the consumer code does not change for one-shot turns (`streamTurn`). The
three layers are also available as `@dungle-scrubs/harness-cli-normalizer/knowledge`,
`@dungle-scrubs/harness-cli-normalizer/interpretation`, and
`@dungle-scrubs/harness-cli-normalizer/execution` for narrower imports. Persistent multi-turn sessions (`openSession`, `sessionMode`) are Claude-only - the other three harnesses have `sessionMode: null` and `openSession`/`hcn session` refuse with `no-session-mode`.

To watch the normalized stream render live against a real harness:

```bash
bun run demo claude "explain a monad in one sentence"
bun run demo codex  "what is 2+2"
bun run demo pi     "name three primes"
bun run demo muse   "say hi"
bun run demo --chat claude            # interactive session (claude only)
```

For a persistent multi-turn session (Claude-only), `openSession` returns a handle whose `turns` you iterate and whose `send()` you call between turns. Other harnesses do not support this mode. See `scripts/demo.ts` for the working pattern.

## CLI

The package ships a `hcn` binary for shell and CI use. Install it with your package manager or run it ad-hoc with `npx`:

```bash
pnpm add @dungle-scrubs/harness-cli-normalizer
npx hcn --help
npm install -g @dungle-scrubs/harness-cli-normalizer  # global
```

One-shot turn:

```bash
hcn run claude "explain a monad in one sentence"
hcn run codex "what is 2+2" --model gpt-5.6-sol
hcn run pi "name three primes" --provider zai/glm-5.2
hcn run muse "say hi" --no-write
```

Piped JSON for programmatic use:

```bash
hcn run claude "say hi" --json | jq .
hcn run claude "hi" --json | head -n 5  # abandonment-safe, no hanging handles
```

Session (Claude-only):

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
| `--tools <a,b>` | `tools` | Claude only, comma-separated |
| `--autonomy` / `--no-autonomy` | `autonomy` | |
| `--write` / `--no-write` | `write` | Muse |
| `--shell` / `--no-shell` | `shell` | Muse |
| `--max-steps <n>` | `maxSteps` | Muse, 1-10000 |
| `--no-tools, --no-instruction-files, --no-extensions, --no-skills` | `discovery` | |
| `--cwd <path>` | `cwd` | Working directory |
| `--env KEY=VAL` | `env` | Repeatable; `KEY=` deletes |
| `--resume <uuid>` | `resume` | Resume session |
| `--json` | output mode | NDJSON `HarnessEvent` to stdout |

For development, `bun run demo claude "hi"` remains as a live-rendering alternative.

## Concepts

### Descriptors are data, not behavior

Each harness is a frozen record of facts: its binary, its argv shapes, its stream flags, its session and resume grammar, its capability claims, and the CLI version those facts were checked against. You read a descriptor; you do not configure or subclass it. Adding a fifth harness means writing a new data file, not editing branching logic.

### Three layers, one direction

```
knowledge (pure data) -> interpretation (pure functions) -> execution (child process)
```

`knowledge` and `interpretation` are 100% pure: no `node:` imports, no `process.env`, no clock, no randomness. Tests enforce this, not comments. Keep your own logic in the pure layers and reach `execution` only for actual process I/O. The execution layer never imports `child_process`; spawning, timing, and signalling arrive as injected primitives, so it runs the same on Node and Bun.

### Version-pinning and drift

Every descriptor carries a `verifiedAgainst` version, the anchor for all of its facts. A weekly CI job compares each harness's published version to its descriptor and opens a tracking issue when one has moved ahead. Trust a descriptor only at its pinned version, and bump `verifiedAgainst` only after re-running the capability checks locally (`bun run smoke:seven`) and re-capturing fixtures.

For the three npm harnesses (Claude Code, Codex, pi) the check queries the registry and is credential-free. Muse ships as an installed shell script (`versionSource: { kind: "installed" }`), so there is no registry to poll - `hcn check` falls back to `muse --version` locally and is skipped in CI where the binary is absent. A quarter of the matrix is therefore exempt from automated drift detection, and a stale Muse descriptor will not surface until a manual re-verification.

Four harnesses are hand-verified by one maintainer. Claude Code alone ships more often than the pin is bumped, and the weekly issue only tells you the descriptor is stale - it does not re-capture the fixtures. Treat `verifiedAgainst` bumps as manual work, and expect Claude + Codex to carry most of the usage while pi and Muse double the verification surface for a smaller slice of value.

## Turn options

Every `streamTurn` call can now shape the turn per-call without touching the descriptor:

```ts
await streamTurn(claudeCode, {
  prompt: "explain a monad",
  effort: "high",                 // --effort (claude), -c model_reasoning_effort (codex), --thinking (pi), --reasoning-effort (muse)
  provider: "zai/glm-5.2",        // --provider (pi only)
  discovery: { tools: false, instructionFiles: false, extensions: false, skills: false }, // -nt/-nc/-ne/-ns (pi) or --setting-sources project (claude)
  write: false,                   // --disable-write (muse)
  shell: false,                   // --disable-shell (muse)
  maxSteps: 50,                   // --max-model-steps (muse)
  sandbox: "read-only",           // --sandbox (codex, launch only)
}, deps);
```

Support matrix (anything not marked refuses with a typed `ArgvRefusalError` naming what the harness does support):

| Option | claude | codex | pi | muse |
| --- | --- | --- | --- | --- |
| `effort` | `--effort` | `-c model_reasoning_effort=` | `--thinking` | `--reasoning-effort` |
| `sandbox` | - | `--sandbox` (launch only) | - | - |
| `provider` | - | - | `--provider` | - |
| `discovery.tools` | - | - | `-nt` | - |
| `discovery.instructionFiles` | - | - | `-nc` | - |
| `discovery.extensions` | `--setting-sources project` | - | `-ne` | - |
| `discovery.skills` | `--setting-sources project` | - | `-ns` | - |
| `write` | - | - | - | `--disable-write` |
| `shell` | - | - | - | `--disable-shell` |
| `maxSteps` | - | - | - | `--max-model-steps` |
| `tools` | `--allowedTools` | - | - | - |

Per-call `env` is merged over the parent environment (`""` deletes) and never appears in logs:

```ts
streamTurn(harness, { prompt, env: { FOO: "bar", OLD: "" } }, deps);
```

## Failure taxonomy

Every failure - provider, work, transport, or refusal - arrives as a typed `failure` event and reduces to one self-sufficient summary on `done`:

```ts
type FailureClass = "rate-limit" | "usage-limit" | "quota" | "auth" | "budget" | "task" | "transport" | "rejected";
interface FailureSummary { class: FailureClass; retryable: boolean; message: string; code?: LimitCode; authKind?: AuthFailureKind; resetsAt?: number; issue?: RefusalIssue; option?: TurnOptionKey; facet?: DiscoveryFacet; supported?: readonly string[]; }
type HarnessEvent = ... | ({ kind: "failure" } & FailureSummary) | { kind: "done"; exitCode: number | null; cause: ExitCause; failure?: FailureSummary };
type ExitCause = "clean" | "limit" | "crash" | "stall" | "killed" | "failed";
```

The canonical consumer check, identical for a deterministic router and an agent:

```ts
if (done.failure) {
  if (done.failure.retryable) descendFallbackChain(done.failure);
  else pivot(done.failure); // rejected -> change options; budget -> raise cap; task -> surface
}
```

`retryable` is `false` for `task`, `budget`, `rejected` and `true` for the rest. `rejected` is non-retryable across the whole model chain because the remedy is different options or a different harness.

## Refusals

An unexpressible option throws `ArgvRefusalError` from the builders and is also delivered as `failure class=rejected` + `done cause=failed` from `streamTurn` (which never throws out of its first `next()`):

```ts
class ArgvRefusalError extends Error { issue: RefusalIssue; harness: HarnessName; option?: TurnOptionKey; facet?: DiscoveryFacet; supported: readonly string[]; }
type RefusalIssue = "unsupported-option" | "unsupported-option-facet" | "unsupported-on-resume" | "invalid-option-value" | "unknown-effort" | "unknown-model" | "invalid-env" | "invalid-tool-grant" | "prompt-flag-injection" | "no-autonomy-mode" | "no-session-mode";
```

Every refusal names an alternative in `supported` and `message`, not only a negation.

## Reference

- Descriptors live in `src/knowledge/` (`claude-code.ts`, `codex.ts`, `pi.ts`, `muse.ts`), with shared types in `descriptor.ts`.
- The normalized event surface is `HarnessEvent` in `src/execution/events.ts`: `identity`, `token`, `message`, `progress`, `tool`, `context`, `limit`, `error`, `failure`, `done` (with `done.failure`).
- Narrow or override a descriptor's facts with `parseOverrides` (`src/knowledge/overrides.ts`). An override a harness cannot satisfy throws `OverrideRefusalError` instead of producing a broken argv. `limitMatchers`/`authMatchers` are now serializable `{pattern, flags, code/kind}` objects so they can be overridden from JSON; bad patterns are refused at load with file and harness named.
- `DROPPABLE_KINDS` (`token`, `progress`, `context`) marks events safe to drop when you only need the full messages. `failure` is never droppable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: run `pnpm check` before pushing, so lint, typecheck, vitest, and the bun test lane all pass. Keep the layer purity and chat-seam invariants intact, and do not edit files under `test/fixtures/`. Commits follow Conventional Commits.

## Status

Pre-1.0. Four harnesses are described (Claude Code, Codex, pi, Muse). One-shot turns (`streamTurn`) are normalized across all four; persistent sessions (`openSession` / `sessionMode`) are Claude-only - other harnesses return `no-session-mode`. Drift detection runs weekly in CI for the three npm harnesses; Muse is `installed` and only checked locally via `muse --version`. Re-verifying a descriptor's capability claims against a new CLI version is a local, manual step (`bun run smoke:seven`) plus fixture re-capture, not CI. Authentication and usage-limit signals are parsed from each harness's stream, but this library never holds or ships credentials; each harness authenticates under the end user's own session.

## Prior art

The four harness CLIs this normalizes: [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), [Codex](https://www.npmjs.com/package/@openai/codex), [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), and Muse (installed from source, not on a registry).

## License

MIT. See [LICENSE](LICENSE).
