# Contributing

Thanks for your interest in `harness-cli-normalizer`. This CLI product (`hcn`) normalizes
the differences between AI coding-agent CLIs (Claude Code, Codex, pi, Muse)
into pure data descriptors plus interpretation and execution layers. The `hcn`
binary is the product; internal library layers are not an install surface.

## Setup

Requires Node >= 24, [Bun](https://bun.sh/), and
[pnpm](https://pnpm.io/) (the version is pinned via `packageManager`).

```bash
git clone https://github.com/dungle-scrubs/harness-cli-normalizer.git
cd harness-cli-normalizer
pnpm install
```

`pnpm install` runs the `prepare` script, which installs the lefthook hooks.

## Day-to-day commands

```bash
pnpm check       # the full gate: lint + typecheck + vitest + bun test
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm test:bun    # bun test
```

`pnpm check` is what CI runs. Run it locally before pushing; both test lanes
(vitest and bun) must pass.

## Architecture and invariants

The codebase has three layers with a one-way dependency:

```
knowledge (pure data) -> interpretation (pure functions) -> execution (impure)
```

Two invariants are **enforced by tests**, not by convention. Read them before
changing the layer boundaries:

- `test/interpretation/purity.test.ts` - `src/interpretation` and
  `src/knowledge` must be 100% pure: no `node:` imports, no `process.env`,
  no `Date.now`/`Math.random`/`Bun.spawn`.
- `test/no-chat-imports.test.ts` - nothing under `src/` may import consumer
  chat/protocol types. The dependency stays one-way.

The execution layer runs identically on Node and Bun and reaches the process
only through injected `{ spawn, clock, signal }` primitives - it never imports
`child_process` directly.

## Test fixtures

Files under `test/fixtures/` are captured real harness output, kept as
evidence. They contain absolute paths and session metadata on purpose. Do not
scrub them.

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add muse session-limit matcher
fix: correct codex resume token parsing
docs: clarify descriptor versionSource
```

release-please reads these prefixes to version releases and write
`CHANGELOG.md`. While pre-1.0, `feat:` bumps the patch version.

## Pull requests

- Branch from `main` and open a PR against `main`. Direct pushes are blocked.
- CI must pass (lint, typecheck, both test lanes).
- Keep the layer purity and chat-seam invariants intact.
- Reference any issue in the PR description (`Closes #123`).
