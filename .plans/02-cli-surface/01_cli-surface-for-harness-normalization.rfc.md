---
number: 01
title: "CLI surface for harness normalization"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-08-13
---

# RFC-01: CLI surface for harness normalization

## Abstract

This RFC adds a shipped CLI to `harness-cli-normalizer` so that harness normalization is usable from the shell, not only from TypeScript. The library today normalizes four coding-agent CLIs as pure data (`knowledge`) and execution (`streamTurn`/`openSession`) but ships no `bin` and no documented shell entry point (`scripts/demo.ts` is dev-only). The CLI MUST reuse the same descriptors, `TurnOptions`, and `HarnessEvent` stream through the existing `execution` layer, MUST NOT weaken the purity or chat-seam gates, and MUST include a README refresh that simplifies the intro paragraph and removes the "that survives their updates" tagline from `README.md:3` and `package.json` description.

## Introduction

### Problem statement

The package name promises CLI normalization, but the runtime surface is TS-only. A shell or CI consumer cannot `npx @dungle-scrubs/harness-cli-normalizer run ...` to get a normalized turn - they must write TypeScript and call `streamTurn`. `scripts/demo.ts` demonstrates the pattern live but is not built, not published, and not documented as a user-facing CLI. That defeats the "one stable interface to four CLIs" claim for non-TS consumers.

### Scope

**In:**

- A shipped `bin` that exposes harness execution and inspection from the shell.
- Mapping of existing `TurnOptions`/`TurnRunOptions` fields to stable CLI flags and one prompt positional.
- Two output modes: human (pretty, same rendering as `demo.ts`) and JSON (NDJSON `HarnessEvent` for pipes).
- README update: simplified intro paragraph and removal of "that survives their updates" from the tagline and `package.json` description.
- `package.json`/`scripts/build.ts` changes to emit `dist/cli.js` with a shebang and `chmod +x`.

**Out:**

- No new harness descriptors and no descriptor schema change.
- No new `TurnOptions` fields and no new harness capabilities.
- No change to `HarnessEvent` shape or decode logic.
- No chat/seam or `lucid` integration.
- No persistent multi-turn session support for Codex/pi/Muse beyond what `execution` already offers (interactive session remains Claude-only, as today).
- No shell completion generation in this RFC (MAY follow as a later addition).

### Motivation

- Teams hold four CLIs together with bespoke spawn-and-parse per agent and redo it on each harness release. The library solves this for TS; the CLI extends the same guarantee to shell, CI yaml, and polyglot orchestrators.
- `demo.ts` is 80% of the needed CLI already; formalizing it as a built `bin` costs ~150-200 lines and zero new dependencies (`node:util` `parseArgs` on Node >= 24).
- README accuracy: the current tagline "that survives their updates" overpromises (descriptors are pinned and can drift) and repeats verbatim in `package.json`. Weekly drift checks are the actual guarantee; wording should reflect that.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Harness / HarnessName** - One of `claude`, `codex`, `pi`, `muse` (`src/knowledge/descriptor.ts:HARNESS_NAMES`).
- **Descriptor** - Frozen pure data record for a harness (bin, argv shapes, stream flags, resume grammar, `verifiedAgainst`). Lives in `src/knowledge/`.
- **TurnOptions / TurnRunOptions** - Per-turn inputs (`prompt`, `model`, `effort`, `sandbox`, `provider`, `discovery`, `write`, `shell`, `maxSteps`, plus `cwd`/`env`/`resume` for `streamTurn`). Lives in `src/interpretation/argv.ts`.
- **HarnessEvent** - Normalized output vocabulary (`identity`, `token`, `message`, `tool`, `progress`, `context`, `limit`, `error`, `failure`, `done`). Lives in `src/execution/events.ts`.
- **Execution layer** - `src/execution/` (`streamTurn`, `openSession`, `nodeRunnerDeps`). The only impure layer; dual-runtime (Node+Bun) via injected `{spawn, clock, signal}`.
- **Bin** - A `package.json` `bin` entry that maps a command name to `dist/cli.js`.
- **Human mode** - Pretty terminal rendering of `HarnessEvent` (tokens stream inline, tool/context colored, as in `scripts/demo.ts:45-79`).
- **JSON mode** - NDJSON `HarnessEvent` per line to stdout, suitable for `| jq`.

## Motivation

Detailed in Introduction. The key driver is symmetry: if the library's value is "one surface for four CLIs," that surface MUST be reachable from the shell with the same stability guarantees as from TypeScript, using the same underlying `knowledge -> interpretation -> execution` pipeline.

## Design

### Bin naming and packaging

- The package SHALL ship `dist/cli.js` with `#!/usr/bin/env node` and executable bit (set in `scripts/build.ts` after `tsc`).
- `package.json` MUST declare `bin` mapping `hcn` to `./dist/cli.js`. It MAY also map `harness` if the name is uncontested at publish time; `hcn` is the primary name because `harness` is high-collision on npm/global. The decision on the second alias SHALL be made before `READY` and recorded as `D-NNN`.
- `files` MUST include `dist` (already) and the built CLI MUST live under `dist/` so `prepack`/`publishConfig` include it. `src/cli` source is not required in `files`.
- Build output SHALL be produced by `tsconfig.build.json` (`rootDir: src`, `outDir: dist`) with `src/cli/**/*.ts` added to `include`. `scripts/build.ts` MUST `chmod +x dist/cli.js` after `spawnSync` succeeds.
- No new runtime dependencies. CLI argument parsing MUST use `node:util` `parseArgs` (available on Node 24). No `commander`/`yargs`/`citty`.

### CLI surface

```
hcn <command> [options] [prompt]

Commands:
  run <harness> <prompt>     One-shot headless turn (streamTurn)
  session <harness>          Interactive session (openSession, Claude-only today)
  inspect <harness>          Descriptor / argv / capability inspection (no spawn)
  ls                         List harnesses with verifiedAgainst versions
  check                      Drift check (published version vs verifiedAgainst)
  --help / -h, --version / -V  Help and version
```

- `<harness>` MUST be `claude|codex|pi|muse`. Unknown harness MUST fail (exit 2) with `supported: [claude, codex, pi, muse]`.
- `<prompt>` for `run` is a positional string. It MUST refuse (exit 2) if it starts with `-` (`prompt-flag-injection` guard in `argv.ts:19-27`), same as the library. Callers needing a leading `-` MUST use `--prompt "..."` or `--prompt-file -`.
- `session` SHALL be Claude-only until other harnesses gain a stable session mode. Invoking `session codex|pi|muse` MUST fail with `ArgvRefusalError`/`SessionInputRefusal` semantics (exit 2).
- All commands MUST support `--help` and `--version`. `--version` prints `package.json` version.

### Flag mapping (flags -> TurnOptions/TurnRunOptions)

The CLI MUST expose one flag per `TurnOptions` field with stable long names, matching the library's vocabulary spelling:

| CLI flag | TurnOptions field | Notes |
|---|---|---|
| `--prompt <text>` | `prompt` | Alternative to positional; required if positional omitted. If both given, MUST error. |
| `--prompt-file <path\|->` | `prompt` (via file) | Reads UTF-8 file or stdin (`-`). Needed for prompts starting with `-` or multi-line. |
| `--model <id>` | `model` | Validated via `validateModel`; unknown model MUST exit 2 with supported list. |
| `--effort <value>` | `effort` | Validated via `validateEffort`; bogus value MUST refuse (not warn-and-run). |
| `--sandbox <value>` | `sandbox` | Codex launch-only; on resume/other harness MUST refuse. |
| `--provider <value>` | `provider` | pi only. |
| `--tools <a,b>` | `tools` | Claude only; comma-separated list. |
| `--autonomy` / `--no-autonomy` | `autonomy` | |
| `--write` / `--no-write` | `write` | Muse `--disable-write` mapping. |
| `--shell` / `--no-shell` | `shell` | Muse `--disable-shell`. |
| `--max-steps <n>` | `maxSteps` | Muse, integer. |
| `--no-tools, --no-instruction-files, --no-extensions, --no-skills` | `discovery` | Booleans; omitted=true are no-ops, false disables (matches `DiscoveryOptions`). |
| `--cwd <path>` | `cwd` | Working directory for spawn. |
| `--env KEY=VAL` (repeatable) | `env` | Merged over parent; `--env KEY=` deletes. Values MUST NOT be logged. |
| `--resume <uuid>` | `resume` | Resume grammar; invalid UUID shape MUST exit 2. |
| `--json` | output mode | NDJSON `HarnessEvent` to stdout. Default is human mode. |
| `--cwd` defaults to `process.cwd()` same as `demo.ts`. |

Flag rendering order MUST be descriptor-declared order (`TURN_OPTION_KEYS` tuple order) via `renderTurnOptions`, so argv is deterministic regardless of CLI flag order.

### Output

- **Human mode (default):** Render `HarnessEvent` inline: `identity` as dim session line, `token` streaming, `message` when no tokens (granularity `none`), `tool` cyan, `progress` droppable, `context` dim, `limit` yellow, `error` red, `done` green/red with exit cause. Matches `scripts/demo.ts:45-79` and `scripts/demo.ts:80-...` behavior. Stderr is for diagnostics only; events go to stdout only in JSON mode.
- **JSON mode (`--json`):** Each `HarnessEvent` is one JSON line to stdout (NDJSON), no color, no pretty prefix. `done` is always last. Suitable for `| jq`. Human diagnostics (spawn/exit redacted argv previews, stall warnings) go to stderr.
- Exit code MUST mirror harness outcome: `0` for `done.cause === "clean"`, `2` for `ArgvRefusalError`/validation failures, `3` for harness-reported `limit`/`auth`/`failure`? No - this RFC fixes the mapping: `0` clean, `2` usage/refusal, `3` limit/auth (`limit`/`expired` etc.) is also a failure but exit 2 conflates it with bad argv; instead CLI MUST exit `0` only on clean and non-zero otherwise, with `1` for transport/crash/stall/killed and `2` for validation/refusal, plus a machine-readable `failure` event preceding `done` in JSON mode. The exact exit-code table SHALL be locked before `READY` and recorded as `D-NNN`.

### Session command

- `hcn session claude [--model ...] [--session-id <uuid>]` opens `openSession` and enters a readline loop: each stdin line is `send()`-ed as one turn. `done` delimits turns. `Ctrl-C` / `Ctrl-D` triggers `close()` with SIGTERM->SIGKILL escalation (`CLOSE_GRACE_MS`). Queued sends during a live turn queue to next boundary (same as `open-session.ts`).

### Inspect / ls / check (no spawn)

- `hcn inspect <harness>` prints descriptor `verifiedAgainst`, `bin`, `launch`/`resume` summary, and `vocabulary.models`. Must not spawn.
- `hcn inspect <harness> --argv --prompt "hi" [--effort high ...]` prints the exact argv `buildLaunchArgv` would exec (with prompt redacted as `[prompt:Nch]` per `redactArgv`) and whether it would refuse + why. Useful for CI argv auditing.
- `hcn ls` prints `HARNESS_NAMES` with `verifiedAgainst` and `versionSource`.
- `hcn check` runs `scripts/check-versions.ts` logic (published npm version vs `verifiedAgainst`) and prints drift state. Exit non-zero if any harness drift is found (for CI gating). This command MUST reuse `interpretation/versions.ts` and `knowledge` - no duplicate version logic.

### Architecture and boundaries

```
src/knowledge  -> src/interpretation -> src/execution
                                        ^
                                        |
                                     src/cli (thin consumer)
docs/rfc  scripts  .plans  README.md
```

- `src/cli` MUST be a thin consumer of `execution`/`interpretation`/`knowledge` only. It MUST NOT import `lucid`, chat-protocol, or test fixtures.
- `src/cli` lives outside the purity gates. `test/interpretation/purity.test.ts` continues to assert no `node:` imports in `src/knowledge` / `src/interpretation`. A separate assertion MAY be added that `src/cli` is allowed to import `node:`.
- Dual-runtime invariant: `src/execution` continues to run on Node+Bun via injected primitives. The CLI is Node-only (`nodeRunnerDeps`); it SHOULD NOT attempt Bun-specific `spawn` paths.
- No `child_process` import outside `src/execution/node-deps.ts`. CLI spawns only via `nodeRunnerDeps()` + `streamTurn`/`openSession`.

### Build and distribution

- `tsconfig.build.json` `include` expands from `["src"]` to include `src/cli`.
- `scripts/build.ts` after `tsc` success MUST write `#!/usr/bin/env node` at top of `dist/cli.js` if not already emitted by `tsc` (tsc strips shebang) - either by prepending or by having `src/cli/index.ts` contain `#!/usr/bin/env node` and ensuring the build preserves it, plus `chmod 755 dist/cli.js`.
- `pnpm build` remains the publish build. `lefthook` pre-commit `tsc --noEmit` continues to typecheck `src/cli`.
- Tests: dual lane `pnpm test` (vitest) + `pnpm test:bun` - CLI gets its own `test/cli/` coverage but vitest/bun lanes are scoped to `test/` via `bunfig.toml` so CLI tests live under `test/cli/`.

### README refresh

As part of this feature the README MUST be updated in the same PR/release:

- Line 3 tagline `One stable interface to four coding-agent CLIs that survives their updates.` MUST become `One stable interface to four coding-agent CLIs.` (and the same string in `package.json` description, line 4).
- The two-paragraph intro (lines 5-10) MUST be replaced with the simplified paragraph recorded as decision `D-` below:

> `harness-cli-normalizer` describes Claude Code, Codex, pi, and Muse as pure data and normalizes their headless output to a single `HarnessEvent` stream. You build one consumer against that stream instead of a separate spawn-and-parse path per CLI - the execution layer spawns the harness and emits the events. Use it for multi-agent work like an orchestrator, observer, benchmark rig, or to swap agents. Descriptors are pinned to their verified CLI version and a weekly check flags when a harness has moved ahead.

- A new `## CLI` section MUST be added after `## Use it` and before `## Concepts`, documenting installation (`pnpm add`, `npx hcn`, global), `hcn run|session|inspect|ls|check` examples, `--json` piping, and the flag table. `bun run demo` remains as a dev alternative but is not the primary documented path.

## State Machine

No new state machine. `streamTurn` lifecycle (spawn -> pump stdout/stderr -> decode -> limit/auth detection -> `done`) and `openSession` queueing are unchanged. CLI `run` is one `streamTurn`; `session` is one `openSession` with a readline loop.

## Error Handling

Error taxonomy reuses `src/interpretation/refusal.ts` and `src/execution/failure.ts` directly:

| Code | Source | CLI exit | Behavior |
|---|---|---|---|
| `prompt-flag-injection` | `argv.ts:assertCleanPrompt` | 2 | Print `ArgvRefusalError` with `supported` + harness, to stderr. |
| `unknown-model`, `unknown-effort`, `unknown-sandbox`, etc. | `vocabulary.ts` / `turn-options.ts` | 2 | Print supported list, no spawn. |
| `unsupported-discovery-facet`, `no-autonomy-mode`, `sandbox-only-on-launch` | `turn-options.ts` | 2 | Print what the harness supports. |
| `invalid-session-id` | `session-id.ts` | 2 | Refuse before spawn. |
| Spawn failure (bin not found, ENOENT) | `stream-turn.ts` pump failure | 1 | Emit `failure` + `done` (cause `failed`), print to stderr, JSON mode emits `failure`/`done` as NDJSON. |
| Harness-reported limit/auth (`limit`/`error` events) | `limits.ts` detectors + `decode.ts` | 1 | Stream events as normal; `done.cause` is `limit` or `failed`; CLI exits 1 (not 2) to distinguish from bad argv. |
| Stall (no output within watchdog) | `stream-turn.ts` stall event | 1 | Emit `error` + `done` cause `stall`. |
| Consumer break (piped `| head`) | `AsyncChannel` close | 0 or 1 | Dispose pumps/child cleanly per `stream-turn.ts` abandonment path. |

Structured `failure` events precede terminal `done` so JSON consumers can branch on `failure.code` without parsing stderr.

## Security Considerations

- **Prompt redaction** - `redactArgv` MUST be used for any argv preview logged to stderr or printed by `inspect --argv`. Prompt content MUST NOT reach logs; it is replaced by `[prompt:Nch]` per `stream-turn.ts:redactArgv`. Other argv tokens are kept unless `SECRETISH` matched, then `[redacted]`.
- **`env` handling** - `TurnRunOptions.env` values MUST NOT be logged. CLI `--env KEY=VAL` values are secret-adjacent and MUST be omitted from argv previews and from stderr. `""` deletes a key from the parent env (existing semantics).
- **Shell injection** - `spawn` uses argv array, not shell string. CLI MUST NOT set `shell: true`. Prompt and flag values are passed as argv slots, never interpolated.
- **Flag injection** - The `prompt-flag-injection` guard forbids prompts starting with `-`. CLI MUST enforce the same guard before building argv; `--prompt` and `--prompt-file` bypass it by explicit opt-in.
- **Signal handling** - `Ctrl-C` during `run`/`session` MUST forward SIGTERM then SIGKILL after `KILL_GRACE_MS` via the injected `signal` primitive (same as `stream-turn.ts`), never `process.kill` directly.
- **Permissions** - CLI inherits the user's env and cwd. No elevation. `HERDR_ENV` is deleted before spawn (as `demo.ts:27` does) so a child harness cannot inherit Herdr pane state.
- **Supply chain** - No new dependencies; `bin` points to built JS in `dist/`, not to TS source.

## Alternatives Considered

- **Keep TS-only** - Rejected. Fulfills the descriptor work but leaves shell/CI consumers without a normalized path; forces every non-TS consumer to re-implement spawn-and-parse.
- **Publish a separate `harness-cli` package** - Rejected. Splits versioning from descriptors; drift checks would need to coordinate two packages. A `bin` in the same package keeps `verifiedAgainst` as the single anchor.
- **Use `commander`/`yargs`** - Rejected. Extra dependency and heavier parsing for a ~5-command CLI; `node:util` `parseArgs` is sufficient on Node 24 and keeps the install lean.
- **Replace `demo.ts` with CLI entirely** - Rejected for now. `demo.ts` stays as a dev-focused `bun run demo` path; CLI is the shipped `hcn` for end users. `demo.ts` MAY delegate to `src/cli` rendering later but not in this RFC.

## Implementation Plan

Deferred to the Implementation Plan document (planner DECOMPOSE stage). High-level phases are anticipated as:

- Phase 1: `src/cli` skeleton + `bin` wiring + `hcn --help|--version|ls|inspect` (no spawn, pure).
- Phase 2: `hcn run` (streamTurn, human+JSON, flag mapping, refusal exits).
- Phase 3: `hcn session` + `hcn check` + README/package.json refresh.
- Phase 4: Tests, docs polish, release notes.

## Open Questions

- **Q1: Second bin alias?** Ship `harness` alongside `hcn` or `hcn` only? Decision impacts global install ergonomics vs npm name collision. Owner: author (before READY).
- **Q2: Exit-code table - should limit/auth be exit 1 or 2?** Current design says 2=bad argv, 1=limit/auth/transport. Confirm with downstream `lucid`/router consumers. Owner: author + consumer liaison.
- **Q3: `--prompt-file -` (stdin prompt) scope?** Include in v1 or defer? Useful for piped prompts but adds stdin multiplexing complexity with harness stdin. Owner: author.
- **Q4: `hcn session` persistence file?** Should `session` emit a session-id file for later `run --resume`? Or keep `openSession` in-memory only? Owner: author.

## References

### Normative

- `AGENTS.md` - Three-layer architecture and one-way dependency, purity/chat-seam/dual-runtime invariants.
- `src/knowledge/descriptor.ts`, `src/knowledge/{claude-code,codex,pi,muse}.ts` - Descriptor schema and per-harness facts.
- `src/interpretation/argv.ts`, `src/interpretation/turn-options.ts`, `src/interpretation/vocabulary.ts` - Flag rendering order, refusals, model/effort validation.
- `src/execution/stream-turn.ts`, `src/execution/open-session.ts`, `src/execution/node-deps.ts`, `src/execution/events.ts` - Process lifecycle, injected primitives, event vocabulary.
- `scripts/demo.ts` - Existing live-rendering pattern to reuse.
- `scripts/build.ts`, `tsconfig.build.json`, `package.json`, `README.md` - Build/publish/readme anchors.
- `test/interpretation/purity.test.ts`, `test/no-chat-imports.test.ts` - Gate invariants.

### Informative

- `docs/adr/` (if any) and `.plans/01-router-execution-options-and-failure-taxonomy/implementation.md` - Context for `TurnOptions` evolution and failure taxonomy.
- `scripts/check-versions.ts` - Drift-check logic to reuse for `hcn check`.
