# Agent Instructions - harness-cli-normalizer

Shared, harness-independent guidance for any agent working in this repo.

## What this is

A TypeScript library that normalizes the differences between AI coding-agent
CLIs (Claude Code, Codex, pi, Muse) into one stable surface. Each harness is
described as pure data; interpretation and execution layers consume those
descriptors. The package is published to npm as `@dungle-scrubs/harness-cli-normalizer`
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
  bump `verifiedAgainst` and `versionSource` together and re-capture fixtures.
  `verifiedAgainst` is the anchor for the harness-update pipeline; do not bump
  it without re-running the capability tripwires locally (`bun run smoke:seven`).
- Test fixtures under `test/fixtures/` are captured real harness output kept as
  evidence. They legitimately contain absolute paths and session metadata -
  do not scrub or "clean" them.
