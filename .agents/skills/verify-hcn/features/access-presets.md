# Access presets

Read and write access express native harness controls, including their limitations.

## Sub-features

- `read`: Cursor ask mode with sandbox enabled.
- `write`: Cursor force permission; no confinement promise.
- `resume`: the explicit preset survives fresh, named-resume and resume-last launch paths.

## How to get to it (user POV)

Run `hcn run cursor --access read|write --prompt <text>`, optionally with `--resume <uuid>` or `--resume-last`. `hcn inspect cursor` describes native support; add `--argv --access read --prompt probe` to preview resolved argv without a model turn.

## Driving it with CLI integration tests

Preconditions: current build, Node and Bun; native permission claims also require the captures/probes in `docs/cursor-access.md`.

- Run `pnpm exec vitest run test/cli/tool-results-usage.test.ts test/cli/plan-turn-cursor.test.ts test/knowledge/cursor-access-evidence.test.ts test/interpretation/access-preset.test.ts` and repeat under `bun test --timeout=20000`.
- The built-CLI tests record native argv for each access and resume entry point. Assert read includes ask/sandbox and no force, write includes exactly one force and makes no sandbox assertion of containment.
- Read `docs/cursor-access.md` and committed probe evidence before making native enforcement claims. A new installed-version claim needs a fresh isolated probe, not only argv or old fixtures.

## Gotchas

Cursor write is unconfined and bypasses workspace trust. Never execute a native write probe against a real project or outside task-owned paths. Permission denials are observations, not an hcn-owned turn-success policy.
