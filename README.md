# harness-cli-normalizer

One stable interface to four coding-agent CLIs that survives their updates.

[![CI](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/harness-cli-normalizer.svg)](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

harness-cli-normalizer describes each of four coding-agent CLIs (Claude Code, Codex, pi, and Muse) as pure data and normalizes their headless output into a single `HarnessEvent` stream. You write one consumer against that surface instead of a bespoke spawn-and-parse path for each agent. A separate execution layer drives any of them as a child process and emits the events. Today most teams hold these agents together by hand, one parser per CLI, and redo the work whenever an agent ships a new version.

You reach for this when you are building on top of more than one coding agent: an orchestrator, an observer, a benchmark rig, or a way to switch which agent does a job. Each descriptor is pinned to the CLI version its facts were verified against, and a weekly check flags when a harness has shipped ahead of its descriptor. You learn drift is possible from a check, not from a crash.

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

Swap `claudeCode` for `codexCli`, `piCli`, or `museCode` and the consumer code does not change. The
three layers are also available as `@dungle-scrubs/harness-cli-normalizer/knowledge`,
`@dungle-scrubs/harness-cli-normalizer/interpretation`, and
`@dungle-scrubs/harness-cli-normalizer/execution` for narrower imports.

To watch the normalized stream render live against a real harness:

```bash
bun run demo claude "explain a monad in one sentence"
bun run demo codex  "what is 2+2"
bun run demo pi     "name three primes"
bun run demo muse   "say hi"
bun run demo --chat claude            # interactive session (claude only)
```

For a multi-turn session you drive yourself, `openSession` returns a handle whose `turns` you iterate and whose `send()` you call between turns. See `scripts/demo.ts` for the working pattern.

## Concepts

### Descriptors are data, not behavior

Each harness is a frozen record of facts: its binary, its argv shapes, its stream flags, its session and resume grammar, its capability claims, and the CLI version those facts were checked against. You read a descriptor; you do not configure or subclass it. Adding a fifth harness means writing a new data file, not editing branching logic.

### Three layers, one direction

```
knowledge (pure data) -> interpretation (pure functions) -> execution (child process)
```

`knowledge` and `interpretation` are 100% pure: no `node:` imports, no `process.env`, no clock, no randomness. Tests enforce this, not comments. Keep your own logic in the pure layers and reach `execution` only for actual process I/O. The execution layer never imports `child_process`; spawning, timing, and signalling arrive as injected primitives, so it runs the same on Node and Bun.

### Version-pinning and drift

Every descriptor carries a `verifiedAgainst` version, the anchor for all of its facts. A weekly CI job compares each harness's published version to its descriptor and opens a tracking issue when one has moved ahead. Trust a descriptor only at its pinned version, and bump `verifiedAgainst` only after re-running the capability checks locally.

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

Pre-1.0. Four harnesses are described (Claude Code, Codex, pi, Muse). Drift detection runs weekly in CI; re-verifying a descriptor's capability claims against a new CLI version is a local, manual step (`bun run smoke:seven`), not CI. Authentication and usage-limit signals are parsed from each harness's stream, but this library never holds or ships credentials; each harness authenticates under the end user's own session.

## Prior art

The four harness CLIs this normalizes: [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), [Codex](https://www.npmjs.com/package/@openai/codex), [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), and Muse (installed from source, not on a registry).

## License

MIT. See [LICENSE](LICENSE).
