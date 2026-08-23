# Agent Instructions - harness-cli-normalizer

Shared, harness-independent guidance for any agent working in this repo.

## What this is

A CLI product (`hcn`) that normalizes the differences between AI coding-agent
CLIs (Claude Code, Codex, pi, Muse) into one stable surface. Each harness is
described as pure data; interpretation and execution layers consume those
descriptors. The `hcn` binary is the product; internal library layers are not an
install surface. The package is published to npm as `@dungle-scrubs/harness-cli-normalizer`
(`publishConfig.access: public`) and is source-public.

## Architecture - three layers, one-way dependencies

```
knowledge        -> interpretation        -> execution
(pure data)         (pure functions)        (process lifecycle, impure)
```

- `src/knowledge/` - immutable harness **descriptors** as pure data. One file
  per harness (`claude-code.ts`, `codex.ts`, `pi.ts`, `muse.ts`) plus shared
  types in `descriptor.ts`. Descriptors are `deepFreeze`'d. Vocabularies that
  consumers branch on (`LimitCode`, `AuthFailureKind`, `HarnessMode`) are
  closed unions on purpose - a descriptor cannot invent a code a consumer has
  no arm for.
- `src/interpretation/` - pure functions that read descriptors and inputs and
  return values (argv shapes, store paths, resume parsing, identity, limits).
- `src/execution/` - owns process lifecycle (`openSession`, `streamTurn`) and
  emits `HarnessEvent` values. This is the only impure layer.

The dependency is one-way. The normalizer never imports chat/protocol types
from any consumer (e.g. lucid). A non-lucid consumer can use the runner
standalone.

## Scope - the test a new feature must pass

hcn does two jobs: it **normalizes** four harness interfaces, and it
**supervises** one process while that process runs. `CONTEXT.md` says which
existing code does which; ADR 0007 states the boundary.

Before adding functionality, apply this test. A feature belongs when it either:

1. **Normalizes** something the harnesses each do differently, expressing them in
   one vocabulary and deciding nothing; or
2. **Supervises one process** hcn itself spawned, for as long as it runs.

A feature that tracks, correlates, or stores anything **across process
boundaries** does not belong. That is the caller's job, because only the caller
knows what a unit of work is.

Two habits that follow:

- **Check whether the harness already does it.** hcn built its own send queue on
  top of two harnesses that both queue natively - claude mid-turn, pi via
  `steer`/`follow_up`. Duplicating a capability is not normalizing it. Forward
  the native mechanism, or write through and let the harness behave.
- **A feature that fails the test is not necessarily wrong** - it may belong in
  the caller. Say where it belongs rather than only that it does not belong here.

## Invariants - enforced by tests, not promised in comments

These gates exist because the layer boundaries are load-bearing. Do not weaken
them; if a change needs to, change the gate test deliberately.

- **Purity gate** (`test/interpretation/purity.test.ts`): no file under
  `src/interpretation` or `src/knowledge` may import `node:` builtins,
  `require`, `process.env`, `Date.now`, `Math.random`, or `Bun.spawn/spawn`.
  Both layers stay 100% pure.
- **Chat seam gate** (`test/no-chat-imports.test.ts`): no file under `src/`
  may import lucid, frames, chat-protocol, or reducer. The dependency stays
  one-way.
- **Dual-runtime** (`src/execution/`): the execution layer runs identically on
  Node and Bun. It never imports `child_process` and never calls
  `process.kill` outside the `node-deps` adapter. All process I/O and
  signalling flows through the injected `{ spawn, clock, signal }` primitives.

## Toolchain

- **Language/runtime**: TypeScript, Node >= 24, also runs on Bun.
- **Package manager**: pnpm (declared via `packageManager` + `pnpm-lock.yaml`).
  Bun is used only to run scripts/tests; `bunfig.toml` disables Bun's
  auto-install so it cannot build a parallel dependency tree.
- **Lint/format**: Biome (single quotes off - double quotes; semicolons
  always; 2-space; width 100).
- **Tests**: dual lane - `vitest run` (`test/**`) and `bun test`. Both must
  pass. The bun lane is scoped to `test/` via `bunfig.toml`.
- **Hooks**: lefthook. Pre-commit runs Biome `--write` + `tsc --noEmit`;
  pre-push runs TruffleHog on the repo.

## Commands

```bash
pnpm install                # install deps (frozen lockfile in CI)
pnpm check                  # lint + typecheck + vitest + bun test (the full gate)
pnpm lint                   # biome check .
pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run
pnpm test:bun               # bun test
bun run demo <harness> "<prompt>"   # drive a harness, watch the event stream
bun scripts/check-versions.ts       # compare descriptors to published versions
```

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:`).
  release-please reads these to cut releases and write `CHANGELOG.md`.
- When a harness descriptor's facts are re-verified against a new CLI version,
  bump `verifiedAgainst` and `versionSource` together, update `escalation.observedOn` from the probe output, and re-capture fixtures.
  `verifiedAgainst` is the anchor for the harness-update pipeline; do not bump
  it without re-running the capability tripwires locally (`bun run smoke:seven` and `bun run smoke:questions`) and transcribing their `observedOn` values into the descriptors.
- Test fixtures under `test/fixtures/` are captured real harness output kept as
  evidence. They legitimately contain absolute paths and session metadata -
  do not scrub or "clean" them.
