# CLI surface for harness normalization - Implementation Plan

> Status: Draft | Plan: `02-cli-surface` | RFC: `.plans/02-cli-surface/01_cli-surface-for-harness-normalization.rfc.md`

## ⚠️ Execution Protocol

A progress report exists at `.plans/02-cli-surface/progress-report.md`. It lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `npx tsx /Users/kevin/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "02-cli-surface"` and read its section in the progress report - those current-cutoff checkboxes are your spec
2. Check each box as you complete the feature, not at the end
3. A milestone is NOT done until every current-cutoff checkbox under it is checked
4. If you find features missing from the report, add them first
5. Never declare a phase complete without updating the current focus marker and Summary
6. Deferred follow-up and superseded/obsolete checklist debt must not be counted as current blockers
7. Fully deferred/tabled sections must be moved under Deferred follow-up; empty active sections must not remain between completed/current sections
8. `FP-<number>` references must be backed by real progress-report sections and checkboxes, not merely named

---

## 0. Hard Dependencies

None. This plan is upstream of any router/consumer CLI usage and does not depend on `01-router-execution-options-and-failure-taxonomy` ship state beyond using its `TurnOptions`/`TurnRunOptions` surface (already on `main` at 0.2.0). `bun run demo` and `scripts/check-versions.ts` already exist as patterns to reuse.

---

## Architecture

### System shape

```
src/knowledge  ──► src/interpretation ──► src/execution
   (pure data)      (pure fns)            (impure, dual-runtime)
                                              ▲
                                              │ injected {spawn, clock, signal}
                                              │
                                          src/cli  (thin consumer, Node-only)
                                             │
                                          dist/cli.js  (built, #!/usr/bin/env node, chmod +x)
                                             │
                                          package.json bin { hcn: ./dist/cli.js }
```

<!-- D-002 --> <!-- D-003 --> `src/cli` is a thin consumer of the three existing layers. It parses argv with `node:util` `parseArgs`, validates via `interpretation` (`validateModel`, `renderTurnOptions`, refusal guards), and executes via `execution` (`streamTurn`, `openSession`, `nodeRunnerDeps`). It adds no new harness knowledge and no new event shapes.

### Key Constraints

| Constraint | Impact |
|---|---|
| Purity gate (`test/interpretation/purity.test.ts`) - `src/knowledge` and `src/interpretation` MUST stay 100% pure (no `node:` imports, no `process.env`, no `Math.random`/`Date.now`). | CLI MUST NOT be placed under `src/interpretation` or `src/knowledge`. CLI lives in `src/cli/` and is allowed to import `node:` (explicit gate exception). |
| Chat seam gate (`test/no-chat-imports.test.ts`) - `src/` MUST NOT import `lucid`/chat-protocol. | CLI MUST NOT import any chat/frame/reducer types. It consumes `HarnessEvent` only. |
| Dual-runtime (`src/execution`) - execution runs identically on Node+Bun via injected primitives, never `child_process` outside `node-deps`. | CLI is Node-only (`nodeRunnerDeps`). It MUST NOT add a Bun-specific spawn path. It drives execution only via the injected-primitive surface. |
| Node >= 24 | `node:util` `parseArgs` is stable; no polyfill needed. |
| Zero new runtime deps | Keeps publish size lean; matches existing toolchain (Biome/pnpm/lefthook). |

### Boundaries

- **CLI owns:** argv parsing, flag->`TurnOptions` mapping, human vs JSON rendering, exit-code mapping, help/version/changelog-adjacent docs, and `bin` packaging. It owns the `README.md` `## CLI` section.
- **CLI does not own:** descriptor facts, argv rendering order, refusal policy, event decoding, limit/auth detection, transport/pump lifecycle. Those stay in `knowledge`/`interpretation`/`execution` and the CLI calls them.
- **Build owns:** `tsconfig.build.json` include expansion and `scripts/build.ts` shebang+chmod. `src/cli` source is typechecked (`tsc --noEmit` via lefthook) but not required in `files`.
- **Docs own:** `README.md` intro simplification and CLI examples, plus `CHANGELOG.md` via release-please (do not hand-edit per global `AGENTS.md`).

### Observability

Only `M5` (harness execution) changes runtime behavior (process spawn, stdout/stderr pumps, signal escalation). It already emits structured lifecycle events via `stream-turn.ts`/`open-session.ts` (`spawn`/`exit`/`stall` with redacted argv, `StderrTail`). The CLI MUST preserve those events and route human diagnostics to stderr so JSON stdout stays pure NDJSON. No new spans are added; the existing `execution` contract is the observability surface.

---

## Phases

### Phase 1: CLI skeleton, packaging, and pure inspection (no spawn)

**Goal:** `pnpm build` ships an executable `dist/cli.js` and `hcn --help|--version|ls|inspect` work without spawning a harness.

**Gate from previous:** RFC-01 accepted and `D-001`..`D-003` recorded.

#### M1: `src/cli` module and `bin` wiring

- **Dependencies:** none
- **Effort:** S (1-2d)
- **Testing:** test-after (scaffold + build artifact - behavior is file existence + execute bit and `node dist/cli.js --help` exits 0)
- **Tasks:**
  1. Create `src/cli/` with `index.ts` (entry), `help.ts`, `version.ts`, `ls.ts`, `inspect.ts`, `run.ts` (stub), `session.ts` (stub), `render.ts`, `args.ts` (parseArgs wrapper). <!-- D-003 -->
  2. Add `#!/usr/bin/env node` header to `src/cli/index.ts`.
  3. Expand `tsconfig.build.json` `include` to `["src"]` -> already covers `src/cli`, but verify `dist/cli.js` emits; if `tsc` strips shebang, update `scripts/build.ts` to prepend shebang and `chmod 755 dist/cli.js`.
  4. Add `package.json` `bin: { "hcn": "./dist/cli.js" }` <!-- D-002 --> and verify `npm pack --dry-run` lists `dist/cli.js` under `files`.
  5. Verify: `pnpm build && node ./dist/cli.js --help` prints usage and exits 0; `pnpm build && ./dist/cli.js --version` prints `0.2.0+` (from `package.json`); `ls -l dist/cli.js` shows `x` bits.

#### M2: `hcn ls` and `hcn inspect <harness>` (pure, no spawn)

- **Dependencies:** M1
- **Effort:** S (1-2d)
- **Testing:** test-first (pure output of descriptor reads; seams: `ls` output shape, `inspect` without argv, unknown-harness error)
- **Tasks:**
  1. Seams under test: `ls` formatter, `inspect` formatter, harness-name validation.
  2. RED: Write failing test for `hcn ls` lists `claude@<verifiedAgainst>`, `codex@...`, `pi@...`, `muse@...` with `versionSource`.
  3. GREEN: Implement `ls.ts` reading `src/knowledge/{claude-code,codex,pi,muse}.ts` descriptors (no spawn).
  4. RED: Write failing test for `hcn inspect claude` shows `bin`, `verifiedAgainst`, `launch.streamFlags`, `resume.flag`, `vocabulary.models`.
  5. GREEN: Implement `inspect.ts` (no `--argv`).
  6. RED: Write failing test for `hcn inspect unknown` exits 2 with `supported: [claude, codex, pi, muse]`.
  7. GREEN: Implement harness-name validation (shared with M5).
  8. REFACTOR: Extract `resolveHarness(name)` helper returning `HarnessDescriptor` or throwing typed refusal.

#### M3: `hcn inspect <harness> --argv` (argv preview + redaction)

- **Dependencies:** M2
- **Effort:** S (1-2d)
- **Testing:** test-first (pure argv preview; seams: `buildLaunchArgv`/`buildResumeArgv` path, redaction)
- **Tasks:**
  1. Seams under test: `--argv` preview string, prompt redaction, refusal reporting.
  2. RED: Write failing test for `hcn inspect claude --argv --prompt "hi" --effort high` previews argv `["claude", "-p", "hi", "--output-format", "stream-json", ...]` with prompt redacted as `[prompt:2ch]` in stderr-visible preview but raw slot used for real spawn.
  3. GREEN: Implement `--argv` path calling `buildLaunchArgv`/`buildResumeArgv` + `renderTurnOptions` ordering, using `redactArgv` for display.
  4. RED: Write failing test for `hcn inspect pi --argv --prompt "hi" --sandbox read-only` refuses (pi has no sandbox) and prints supported list.
  5. GREEN: Wire refusal (`ArgvRefusalError`) print to stderr with `issue` + `supported`.
  6. RED: Write failing test for `hcn inspect claude --argv --prompt "-bad"` refuses `prompt-flag-injection` unless `--prompt "-bad"` form.
  7. GREEN: Handle prompt via `--prompt`/`--prompt-file` vs positional.
  8. REFACTOR: Share flag->`TurnOptions` mapping with M5 (extract `parseTurnOptions`).

#### M4: Help, version, and error polish

- **Dependencies:** M1
- **Effort:** S (1d)
- **Testing:** test-after (CLI UX - snapshot/char-by-char assertions are brittle test-first; verify via integration exec)
- **Tasks:**
  1. Implement `--help` per-command (`hcn run --help`, `hcn inspect --help`) and top-level usage.
  2. Implement `--version` from `package.json` version (import with `assert { type: "json" }` or read `package.json`).
  3. Verify: `hcn --help` lists `run|session|inspect|ls|check`; `hcn inspect --help` lists flag table; unknown flag exits 2 with usage hint.

### Gate 1→2

- [ ] `pnpm build && ./dist/cli.js --help|--version|ls|inspect` pass without spawn
- [ ] `hcn inspect --argv` redacts prompt and reports refusals with supported list
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:bun` green (CLI tests under `test/cli/`)

### Phase 2: `hcn run` (harness execution, human + JSON)

**Goal:** One-shot headless turns work from the shell with parity to the TS `streamTurn` path, in both human and JSON modes.

**Gate from previous:** Gate 1→2 passes.

#### M5: `hcn run <harness> <prompt>` - flag mapping, human rendering, exit codes <!-- D-003 -->

- **Dependencies:** M3 (flag mapping), M4
- **Effort:** M (3-5d)
- **Testing:** test-first
- **Observability:** required (process spawn, pump, and JSON/stdio routing)
- **Tasks:**
  1. Seams under test: flag->`TurnOptions` mapping, `streamTurn` invocation, human render, exit codes, error reporting.
  2. RED: Write failing test for `hcn run claude "hi" --model <known>` builds the same argv as `buildLaunchArgv(claudeCode, {prompt:"hi", model:...})` (spy on `buildLaunchArgv` or on spawned argv via stub deps).
  3. GREEN: Implement `run.ts` using `nodeRunnerDeps()` + `streamTurn(h, opts, deps)`; wire all flags from the RFC table (`--model`, `--effort`, `--sandbox`, `--provider`, `--tools`, `--autonomy`, `--write/--no-write`, `--shell`, `--max-steps`, `--no-tools` etc., `--cwd`, `--env`, `--resume`).
  4. RED: Write failing test for `hcn run pi --sandbox read-only ...` refuses exit 2 (no sandbox on pi) with no spawn.
  5. GREEN: Validate via `renderTurnOptions`/`validateModel`/`validateEffort` before spawn.
  6. RED: Write failing test for human mode renders `identity` dim, `token` inline, `tool` cyan, `limit` yellow, `done` green/red, matching `scripts/demo.ts:45-79` semantics.
  7. GREEN: Port `demo.ts` `render` function to `src/cli/render.ts` (shared with `session`).
  8. RED: Write failing test for exit codes: clean 0, refusal 2, limit/transport 1 (lock the table in a test fixture before READY).
  9. GREEN: Map `done.cause` + `ArgvRefusalError` to exit code per RFC table and record as `D-NNN`.
  10. RED: Write failing test for `HERDR_ENV` deletion before spawn (child must not inherit it).
  11. GREEN: `delete process.env.HERDR_ENV` before `streamTurn` (as `demo.ts:27`).
  12. REFACTOR: Extract `parseTurnOptions(parsedArgs)` and `resolveRunHarness(name)` helpers.

#### M6: `hcn run --json` NDJSON and stdio contracts

- **Dependencies:** M5
- **Effort:** S (1-3d)
- **Testing:** test-first
- **Observability:** required (stdout-is-JSON vs stderr-is-diagnostics)
- **Tasks:**
  1. Seams under test: NDJSON line-per-`HarnessEvent`, stdout/stderr split, abort cleanup.
  2. RED: Write failing test for `hcn run claude "hi" --json` emits one JSON line per `HarnessEvent` to stdout, `done` last, with `JSON.parse` per line succeeding, and no ANSI.
  3. GREEN: Implement `--json` path: `JSON.stringify(event)` per line to `process.stdout`, diagnostics (spawn argv preview redacted, stall warnings) to stderr only.
  4. RED: Write failing test for `hcn run claude "hi" --json | head -n 5` breaks cleanly: pumps disposed, child signaled, no hanging handles (abandonment path).
  5. GREEN: Use `deps.signal` escalation (`KILL_GRACE_MS`) and `AsyncChannel` close handling as in `stream-turn.ts`.
  6. RED: Write failing test for `hcn run` stdout in human mode does NOT emit JSON; `token` text is raw, not quoted.
  7. GREEN: Guard JSON vs human branching at the event loop top.
  8. REFACTOR: Share NDJSON helper `writeEventNdjson(event)` for `session` JSON mode later.

#### M7: `--prompt`, `--prompt-file`, and interruption handling

- **Dependencies:** M5
- **Effort:** S (1-2d)
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: prompt sources, file read, stdin prompt, SIGINT handling.
  2. RED: Write failing test for `hcn run claude --prompt-file fixtures/prompt.txt` reads prompt from file; `--prompt-file -` reads from stdin until EOF.
  3. GREEN: Implement `--prompt-file` reading (UTF-8, bounded? reuse `LINE_MAX` policy) and mutual exclusion with positional/`--prompt`.
  4. RED: Write failing test for `hcn run claude "-bad" --prompt "-bad"` - positional `-bad` alone must refuse, `--prompt "-bad"` must succeed.
  5. GREEN: Implement prompt-source guard (`prompt-flag-injection` only applies to positional prompt, not to explicit `--prompt` opt-in).
  6. RED: Write failing test for SIGINT during `run` forwards SIGTERM then SIGKILL after `KILL_GRACE_MS` and exits non-zero.
  7. GREEN: Wire `process.on("SIGINT"/"SIGTERM")` to `deps.signal` escalation.
  8. REFACTOR: Extract `resolvePrompt(parsed)` helper.

### Gate 2→3

- [ ] `hcn run claude "say hi" [--json]` streams `HarnessEvent` and exits per table; `hcn run --help` lists flag table
- [ ] `hcn run` refusals (unknown model/effort, sandbox on pi, prompt-flag-injection) exit 2 with supported list, no spawn
- [ ] NDJSON output is `jq`-parseable; human output has no JSON; stdout/stderr split correct
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:bun` green

### Phase 3: `hcn session`, `hcn check`, and README refresh

**Goal:** Interactive session, drift check, and README/package.json docs ship together.

**Gate from previous:** Gate 2→3 passes.

#### M8: `hcn session claude` (interactive, Claude-only)

- **Dependencies:** M6
- **Effort:** S (2-3d)
- **Testing:** test-first (logic) + integration (pty/readline)
- **Observability:** required (session queue, close escalation)
- **Tasks:**
  1. Seams under test: `openSession` handle creation, `send()` disposition, turn iteration, close escalation.
  2. RED: Write failing test for `hcn session claude` creates `openSession` with `sessionId` and `model`/`cwd`; stub `openSession` returns a handle with `turns` async iterable and `send`/`close`.
  3. GREEN: Implement `session.ts` using `openSession` + `readline/promises` loop: each line is `send()`-ed, `turns` iterated with `render` per event, `Ctrl-D` calls `close()`.
  4. RED: Write failing test for `hcn session codex` exits 2 (Muse only until other harnesses add sessionMode).
  5. GREEN: Guard `harness !== "claude"` refusal.
  6. RED: Write failing test for queued `send` during live turn returns `disposition: "queued"` diagnostic to stderr.
  7. GREEN: Log queued disposition; `close()` escalates SIGTERM->SIGKILL after `CLOSE_GRACE_MS`.
  8. REFACTOR: Share render path with `run`.

#### M9: `hcn check` (drift check, pure)

- **Dependencies:** M2
- **Effort:** S (1-2d)
- **Testing:** test-first (reuse `scripts/check-versions.ts` / `interpretation/versions.ts` seam)
- **Tasks:**
  1. Seams under test: version fetch, comparison to `verifiedAgainst`, exit code, output shape.
  2. RED: Write failing test for `hcn check` prints each harness `verifiedAgainst` + published version and exits 0 when no drift, non-zero when drift.
  3. GREEN: Implement `check.ts` reusing `src/interpretation/versions.ts` and `src/knowledge` `versionSource`; do not duplicate version-fetch logic - import or delegate to `scripts/check-versions.ts` library surface if needed (extract to `src/interpretation/versions.ts` if not already).
  4. RED: Write failing test for network failure in `check` prints warning and exits 1 with partial results.
  5. GREEN: Handle fetch errors with `error` diagnostic, not crash.
  6. REFACTOR: Ensure `check` is pure-reporting (no spawn).

#### M10: README simplification and CLI docs <!-- D-001 -->

- **Dependencies:** M3 (CLI surface known), M6 (examples verified)
- **Effort:** S (1d)
- **Testing:** test-after (docs - visual verification; `pnpm lint` and `tsc --noEmit` still pass)
- **Tasks:**
  1. Edit `README.md:3` tagline from `One stable interface to four coding-agent CLIs that survives their updates.` to `One stable interface to four coding-agent CLIs.` <!-- D-001 -->
  2. Edit `package.json:4` description to match (no "that survives their updates").
  3. Replace `README.md:5-10` intro (5 sentences across 2 paragraphs) with the 4-sentence simplified paragraph from the RFC (`<!-- D-001 -->` marker in README at the replacement site).
  4. Add new `## CLI` section after `## Use it` documenting: install (`pnpm add`, `npx hcn`, global), `hcn run|session|inspect|ls|check` examples, `--json` piping (`| jq`), flag table excerpt, and `bun run demo` as dev alternative. Ensure no `docs/` or `CONTEXT.md` file is introduced beyond README.
  5. Verify: `pnpm lint && pnpm typecheck` green; `grep -rn "survives their updates" README.md package.json` exits non-zero; manual `hcn --help` output matches README examples (copy-paste test).

### Gate 3→4

- [ ] `hcn session claude` interactive loop works; `hcn session codex|pi|muse` refuses exit 2
- [ ] `hcn check` reports drift with correct exit code and reuses version source
- [ ] README intro simplified, tagline removed, `## CLI` section matches shipped flags
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:bun && pnpm build` green

### Phase 4: Tests, gates, and release polish

**Goal:** The CLI meets the repo's gates and ships as a documented feature.

**Gate from previous:** Gate 3→4 passes.

#### M11: CLI tests and package contract

- **Dependencies:** M7, M8, M9, M10
- **Effort:** S (2-3d)
- **Testing:** test-first (package contract is behavior)
- **Tasks:**
  1. Add `test/cli/` suite (vitest + bun lanes) covering: argv->`TurnOptions` mapping, refusal exits (unknown model/effort/sandbox, prompt-flag-injection), harness-name validation, `--json` NDJSON contract, `--prompt-file` mutual exclusion, exit-code table snapshot, help/version output.
  2. Update `test/interpretation/purity.test.ts` to explicitly allow `node:` in `src/cli/` (or keep the existing `src/cli` exemption if the gate tests `src/knowledge`+`src/interpretation` only - verify and document the boundary in the gate file comment).
  3. Ensure `test/no-chat-imports.test.ts` still asserts no chat imports in `src/cli/`.
  4. Add `scripts/check-package.ts` assertion that `dist/cli.js` is present and `bin.hcn` points at it.
  5. Verify: `pnpm check` (lint + typecheck + vitest + bun test + build + check:package) green.

#### M12: Release notes and landing

- **Dependencies:** M11
- **Effort:** S (1d)
- **Testing:** test-after (release flow - `release-please` reads Conventional Commits; verify in CI)
- **Tasks:**
  1. Write commit messages as `feat:` per Conventional Commits; `README.md`/`package.json` changes go in the same release as the CLI.
  2. Verify `release-please` notes picks up `feat: add CLI surface (hcn)` and that `CHANGELOG.md` is not hand-edited.
  3. Final manual pass: `pnpm exec hcn run claude "say hi" --json | jq .`, `pnpm exec hcn inspect codex --argv --prompt "hi"`, `pnpm exec hcn ls`, `pnpm exec hcn check`.

### Final Gate (before READY -> IMPLEMENTING)

- [ ] `pnpm check` green (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:bun && pnpm build && pnpm check:package`)
- [ ] `npx hcn run|session|inspect|ls|check --help` accurate and matches README `## CLI`
- [ ] `npx hcn run claude "hi" --json` is NDJSON (`jq` succeeds), `npx hcn check` exit code correct for drift/no-drift
- [ ] No `survives their updates` remains in `README.md` or `package.json`
- [ ] No new runtime dependencies added; `bin.hcn` points to executable `dist/cli.js`

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|
| `harness` bin name collides on npm/global | medium | medium | Ship `hcn` primary; defer `harness` alias to READY decision `D-002`. | author |
| Flag table drift vs `TurnOptions` | medium | medium | Share `parseTurnOptions` between `run`/`inspect --argv`; test that `buildLaunchArgv` spy matches CLI argv. | author |
| Prompt redaction regression | high | low | Reuse `redactArgv`; test that `inspect --argv` output never contains raw prompt. | author |
| JSON stdout pollution (diagnostics leak) | medium | medium | Route all diagnostics to stderr; NDJSON test asserts stdout is pure `JSON.parse`-able. | author |
| Signal/abandonment leak | medium | low | Reuse `KILL_GRACE_MS`/`CLOSE_GRACE_MS` and `AsyncChannel` close handling; integration test pipes to `head`. | author |
| Purity/chat-seam gate breakage | high | low | Expand gate file comment to allow `node:` in `src/cli/` only; verify `test/no-chat-imports.test.ts` still asserts for `src/cli`. | author |

---

## Escape Hatches

1. **If `node:util` `parseArgs` semantics are too limited for flag combinations:** Add a tiny `src/cli/args.ts` shim that pre-parses only the prompt positional before `parseArgs`; no new dep. Gate: `M5` flag-mapping tests fail.
2. **If `dist/cli.js` shebang is stripped by `tsc`:** Move shebang injection to `scripts/build.ts` post-step (already in plan) rather than fighting `tsc`.
3. **If `hcn check` fetch flakiness blocks CI:** Keep `check` non-blocking in CI (warn, not fail) until stabilized; `check` still exits non-zero locally.

---

## Landing Strategy

| Field | Value |
|---|---|
| Merge target | `main` |
| Branch model | One branch `feat/02-cli-surface` (small scope, ~12 milestones) |
| PR cadence | One PR for the whole plan (phases are sequential but small); reviewer nirvana via `codex-review`/`muse-review` skill for the diff |
| Independent reviewer | `codex-review` or `muse-review` for the CLI diff + human sign-off on README `## CLI` prose |
| Ship mechanism | `release-please` via `pnpm check` gate on `main` push (existing flow from `00-session-input-backpressure-and-ci`). `feat:` commits cut a minor bump (0.2.0 -> 0.3.0). |

---

## Validation Commands

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:bun && pnpm build && pnpm check:package
pnpm exec hcn --help
pnpm exec hcn run claude "say hi" --json | jq .
pnpm exec hcn inspect claude --argv --prompt "hi" --effort high
pnpm exec hcn ls
pnpm exec hcn check
grep -rn "survives their updates" README.md package.json && echo "FAIL" || echo "OK"
```

---

## Decisions

Canonical decisions are in the plan database (`.plans/02-cli-surface/plan.db`).

Query with:

```bash
npx tsx /Users/kevin/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "02-cli-surface"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.

