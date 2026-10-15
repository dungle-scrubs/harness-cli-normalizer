# Access presets

Read and write access express native harness controls, including their limitations.

## Sub-features

- `read`: Claude's read-only tool subset and Cursor ask mode with sandbox enabled.
- `write`: Claude acceptEdits plus strict native Bash sandbox settings; Cursor force permission without confinement.
- `composition`: Claude write and selected skills share one hcn-owned settings object. Caller settings and passthrough remain unchanged.
- `resume`: the explicit preset survives fresh, named-resume and resume-last launch paths.
- `autonomy`: explicit Claude write keeps its sandbox when autonomy changes native permission mode.

## How to get to it (user POV)

Run `hcn run claude --access write --skills <name> --prompt <text>` or `hcn run cursor --access read|write --prompt <text>`, optionally with `--resume <uuid>` or `--resume-last`. Use `hcn inspect <harness> --argv --access write --prompt probe` to preview resolved argv without a model turn. Access is a run option, not a session option.

## Driving it with CLI integration tests

Preconditions: current build, Node and Bun. Native enforcement claims also require version-specific captures or isolated probes.

- Run `pnpm exec vitest run test/cli/tool-results-usage.test.ts test/cli/plan-turn-cursor.test.ts test/knowledge/cursor-access-evidence.test.ts test/interpretation/access-preset.test.ts test/interpretation/access-resume.test.ts test/interpretation/skills-selection.test.ts test/interpretation/argv-passthrough-placement.test.ts` and repeat under `bun test --timeout=20000`.
- Built-CLI cases capture native argv across fresh, named-resume and resume-last. For Claude write, assert acceptEdits, no blanket Bash allowance or implicit autonomy, and one owned settings object with all five strict sandbox fields and the skill selection. JSON-looking prompt text remains literal. Supplemental public argv tests check literal caller inline JSON and settings-file paths, not their native precedence.
- For Cursor, assert read includes ask/sandbox and no force, while write includes exactly one force. Do not turn argv into a confinement claim.
- Read `docs/cursor-access.md` before Cursor enforcement claims. Read `docs/reference.md` and `skills/hcn/references/harness-notes.md` before Claude native-policy claims. A new installed-version claim needs a fresh task-owned probe; synthetic argv checks and older captures do not establish it.

## Gotchas

Claude's sandbox covers Bash, not file or web tools. Native tool permissions, Bash checks, trusted network and write policy and OS availability still govern. Strict mode can ignore project settings that loosen policy. hcn requests fail-closed startup but does not establish behavior on an untested platform. One merged settings object preserves skill-selection fields, not active skill loading in modes such as Claude safe mode. Later raw settings can replace owned settings under native precedence.

Cursor write is unconfined and bypasses workspace trust. Never execute a native write probe against a real project or outside task-owned paths. Permission denials are observations, not an hcn-owned turn-success policy.
