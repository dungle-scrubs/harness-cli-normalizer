# CLI surface for harness normalization - Progress Report

> Auto-generated from implementation plan. This is the canonical source of truth for what is done and what remains. Update this file as features are implemented - never mark a milestone complete until every current-cutoff checkbox under it is checked.

> Current focus: Phase 4 - Tests, gates, and release polish (complete)

## Phase 1: CLI skeleton, packaging, and pure inspection (no spawn)

### M1: `src/cli` module and `bin` wiring
Source: `package.json`, `scripts/build.ts`, `tsconfig.build.json`, `src/cli/index.ts`

- [x] Feature: `src/cli/index.ts` exists with `#!/usr/bin/env node` and dispatches to subcommands
- [x] Feature: `src/cli/help.ts` provides per-command and top-level help
- [x] Feature: `src/cli/version.ts` prints `package.json` version
- [x] Feature: `src/cli/args.ts` wraps `node:util` `parseArgs` for the flag table
- [x] Feature: `scripts/build.ts` prepends shebang if stripped and `chmod 755 dist/cli.js`
- [x] Feature: `package.json` `bin: { "hcn": "./dist/cli.js" }` is present <!-- D-002 -->
- [x] Feature: `pnpm build && ./dist/cli.js --help` exits 0 and lists commands
- [x] Feature: `pnpm build && ./dist/cli.js --version` prints version
- [x] Feature: `npm pack --dry-run` includes `dist/cli.js` under `files`

### M2: `hcn ls` and `hcn inspect <harness>` (pure, no spawn)
Source: `src/cli/ls.ts`, `src/cli/inspect.ts`, `src/knowledge/*.ts`

- [x] Feature: `hcn ls` lists `claude@<verifiedAgainst>`, `codex@...`, `pi@...`, `muse@...` with `versionSource`
- [x] Feature: `hcn inspect claude` shows `bin`, `verifiedAgainst`, `launch.streamFlags`, `resume.flag`, `vocabulary.models`
- [x] Feature: `hcn inspect pi` shows its descriptor fields distinctly from claude
- [x] Feature: `hcn inspect unknown` exits 2 with `supported: [claude, codex, pi, muse]`
- [x] Feature: `resolveHarness(name)` helper returns `HarnessDescriptor` or typed refusal

### M3: `hcn inspect <harness> --argv` (argv preview + redaction)
Source: `src/cli/inspect.ts`, `src/interpretation/argv.ts`, `src/execution/stream-turn.ts` (redactArgv)

- [x] Feature: `hcn inspect claude --argv --prompt "hi" --effort high` previews argv with prompt redacted as `[prompt:2ch]` in display
- [x] Feature: Preview order follows `TURN_OPTION_KEYS` tuple order via `renderTurnOptions`
- [x] Feature: `hcn inspect pi --argv --prompt "hi" --sandbox read-only` refuses with supported list (pi has no sandbox)
- [x] Feature: Refusal from `ArgvRefusalError` prints `issue` + `supported` to stderr
- [x] Feature: `hcn inspect claude --argv --prompt "-bad"` refuses `prompt-flag-injection`
- [x] Feature: `--prompt "-bad"` explicit form bypasses flag-injection guard and succeeds
- [x] Feature: `--prompt` vs positional mutual exclusion errors when both given
- [x] Feature: `parseTurnOptions` is shared between `inspect --argv` and `run`

### M4: Help, version, and error polish
Source: `src/cli/help.ts`, `src/cli/version.ts`

- [x] Feature: `hcn --help` lists `run|session|inspect|ls|check`
- [x] Feature: `hcn inspect --help` lists its flags; `hcn run --help` lists flag table
- [x] Feature: `hcn --version` prints `package.json` version
- [x] Feature: Unknown flag exits 2 with usage hint

## Phase 2: `hcn run` (harness execution, human + JSON)

### M5: `hcn run <harness> <prompt>` - flag mapping, human rendering, exit codes
Source: `src/cli/run.ts`, `src/cli/render.ts`, `src/execution/stream-turn.ts`, `src/execution/node-deps.ts`

- [x] Feature: `hcn run claude "hi" --model <known>` builds same argv as `buildLaunchArgv(claudeCode, ...)` 
- [x] Feature: All flags map from RFC table (`--model`, `--effort`, `--sandbox`, `--provider`, `--tools`, `--autonomy`, `--write/--no-write`, `--shell`, `--max-steps`, discovery `--no-*`, `--cwd`, `--env`, `--resume`)
- [x] Feature: Unknown model/effort/sandbox validates via `validateModel`/`validateEffort` and refuses exit 2 with supported list before spawn
- [x] Feature: Human mode renders `identity` dim, `token` inline, `tool` cyan, `limit` yellow, `done` green/red matching `scripts/demo.ts:45-79`
- [x] Feature: Exit codes: clean 0, refusal 2, limit/transport/crash/stall 1 (locked table, `D-NNN`)
- [x] Feature: `HERDR_ENV` is deleted before spawn so child does not inherit Herdr state
- [x] Feature: `parseTurnOptions` helper extracted and reused

### M6: `hcn run --json` NDJSON and stdio contracts
Source: `src/cli/run.ts`, `src/execution/stream-turn.ts`

- [x] Feature: `hcn run claude "hi" --json` emits one `JSON.stringify(HarnessEvent)` per line to stdout, `done` last
- [x] Feature: Each stdout line parses as `HarnessEvent` via `JSON.parse`; no ANSI in JSON mode
- [x] Feature: Diagnostics (spawn argv redacted, stall) go to stderr only; stdout stays pure NDJSON
- [x] Feature: `hcn run claude "hi" --json | head -n 5` disposes pumps and signals child cleanly (no hang)
- [x] Feature: Human mode stdout is raw `token`/`message` text, not JSON

### M7: `--prompt`, `--prompt-file`, and interruption handling
Source: `src/cli/args.ts`, `src/cli/run.ts`

- [x] Feature: `--prompt-file <path>` reads UTF-8 prompt from file
- [x] Feature: `--prompt-file -` reads prompt from stdin until EOF
- [x] Feature: `--prompt-file` mutual exclusion with positional and `--prompt` (both given -> exit 2)
- [x] Feature: Positional prompt starting with `-` refuses; `--prompt "-bad"` succeeds
- [x] Feature: SIGINT during `run` forwards SIGTERM then SIGKILL after `KILL_GRACE_MS` and exits non-zero

## Phase 3: `hcn session`, `hcn check`, and README refresh

### M8: `hcn session claude` (interactive, Claude-only)
Source: `src/cli/session.ts`, `src/execution/open-session.ts`

- [x] Feature: `hcn session claude` creates `openSession` with `sessionId`/`model`/`cwd`
- [x] Feature: Readline loop: each stdin line is `send()`-ed as one turn, `turns` iterated with `render` per event
- [x] Feature: `Ctrl-D` calls `close()` with SIGTERM->SIGKILL escalation after `CLOSE_GRACE_MS`
- [x] Feature: `hcn session codex|pi|muse` exits 2 (Claude-only sessionMode)
- [x] Feature: Queued `send` during live turn logs `disposition: "queued"` diagnostic to stderr

### M9: `hcn check` (drift check, pure)
Source: `src/cli/check.ts`, `src/interpretation/versions.ts`, `scripts/check-versions.ts`

- [x] Feature: `hcn check` prints each harness `verifiedAgainst` plus published version
- [x] Feature: Exits 0 when no drift, non-zero when drift found (CI-gateable)
- [x] Feature: Reuses `src/interpretation/versions.ts` + `versionSource`; does not duplicate version logic
- [x] Feature: Network failure prints warning and exits 1 with partial results

### M10: README simplification and CLI docs <!-- D-001 -->
Source: `README.md`, `package.json`, `src/cli/*.ts`

- [x] Feature: `README.md:3` tagline is `One stable interface to four coding-agent CLIs.` (no "that survives their updates")
- [x] Feature: `package.json` description matches new tagline (no "that survives their updates")
- [x] Feature: `README.md:5-10` intro replaced with 4-sentence simplified paragraph (with `<!-- D-001 -->`)
- [x] Feature: New `## CLI` section after `## Use it` documents `hcn run|session|inspect|ls|check`, `--json` piping, flag table excerpt, and `bun run demo` as dev alternative
- [x] Feature: `grep -rn "survives their updates" README.md package.json` fails (no matches)
- [x] Feature: README examples match `hcn --help` output (copy-paste verified)

## Phase 4: Tests, gates, and release polish

### M11: CLI tests and package contract
Source: `test/cli/`, `test/interpretation/purity.test.ts`, `test/no-chat-imports.test.ts`, `scripts/check-package.ts`

- [x] Feature: `test/cli/` vitest+bun suite covers: argv->TurnOptions mapping, refusal exits, harness-name validation, `--json` NDJSON contract, `--prompt-file` exclusion, exit-code table snapshot, help/version output
- [x] Feature: `test/interpretation/purity.test.ts` allows `node:` in `src/cli/` (or documents boundary) but still forbids `node:` in `src/knowledge`+`src/interpretation`
- [x] Feature: `test/no-chat-imports.test.ts` asserts no chat imports in `src/cli/`
- [x] Feature: `scripts/check-package.ts` asserts `dist/cli.js` exists and `bin.hcn` points at it
- [x] Feature: `pnpm check` is green (lint + typecheck + vitest + bun test + build + check:package)

### M12: Release notes and landing
Source: git, `CHANGELOG.md`, `pnpm exec hcn`

- [x] Feature: Commits use `feat:` Conventional Commits; `CHANGELOG.md` not hand-edited
- [x] Feature: Manual verification: `pnpm exec hcn run claude "say hi" --json | jq .` streams
- [x] Feature: Manual verification: `pnpm exec hcn inspect codex --argv --prompt "hi"` previews
- [x] Feature: Manual verification: `pnpm exec hcn ls` and `pnpm exec hcn check` print drift state

## Summary

- Total features: 67
- Completed: 67
- Remaining: 0
- Current cutoff blockers: 0
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0
