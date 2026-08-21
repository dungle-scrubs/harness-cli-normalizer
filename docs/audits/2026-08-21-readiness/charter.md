# Readiness audit charter - harness-cli-normalizer 53c400a

Date: 2026-08-21. This document instructs an executing pass. It contains no
findings. Hypotheses live under `## Pre-observed`.

## Subjects

- Package: `/Users/kevin/dev/harness-cli-normalizer`, commit `53c400a`, main,
  `package.json` version 0.4.4, npm name `@dungle-scrubs/harness-cli-normalizer`.
  Working tree is clean except one untracked file named `1` at the repo root
  (out of scope; do not open, do not delete).
- Consumer: lucid-v2, commit `88664eb` (2026-08-12). Local read-only copy:
  `SCRATCH/lucid-v2/` (rsync done 2026-08-21, `node_modules`, `spikes`,
  `lucid-v2-plan` excluded). Origin: `pro:~/dev/lucid-v2`.
- `SCRATCH` = `/private/tmp/claude-501/-Users-kevin-dev-harness-cli-normalizer/a20779f3-e014-473d-bcdb-f91e051df2a9/scratchpad`.
  All audit output goes under `SCRATCH/audit/`.
- Installed harnesses on this machine (air): claude 2.1.238, codex 0.146.1,
  pi 0.84.2, muse 0.2.1. Node v26.4.0, bun 1.3.10, pnpm per `packageManager`.
- codebase-memory project id: `Users-kevin-dev-harness-cli-normalizer`,
  indexed 2026-08-21T03:32:49Z, full mode. lucid-v2 is not indexed; read it
  with grep and file reads.

## Readiness questions

- Q1 - delegated subagent tasks through `hcn` (CLI surface). Consumers:
  `~/.agents/skills/delegate/SKILL.md`, `~/.agents/skills/choose-model/SKILL.md`,
  `~/.agents/skills/hcn/SKILL.md` (symlink to
  `~/dev/skills-new/skills/vendor/hcn`), Claude Code wrapper agents running
  `hcn` from Bash in the background.
- Q2 - lucid-v2 driving the `hcn` binary: one `hcn run --json` process per
  turn, resume by id, events read from stdout in real time into its reducer,
  `question` escalation to a human, kill and resume, limit propagation (the
  seven in `SCRATCH/lucid-v2/docs/smoke-seven.md`).

Decisions taken 2026-08-21 that shape Q2:

- lucid-v2 consumes the CLI only. No imports of `src/`. The deep imports in
  lucid-v2 today are history, not the target.
- One process per turn via `hcn run --resume`. The per-turn spawn and
  transcript reload latency is accepted.
- No machine-driven `hcn session` mode is required. Session mode is out of
  the readiness gate.

Every dimension below names the question it serves. A dimension that serves
neither is cut. Every dimension assumes the CLI surface; the only place a
library import is still checked is the choose-model example in D12.

## 1. Scope

In scope (read-only):

- `src/**`, `scripts/**`, `test/**` (excluding edits to `test/fixtures/`),
  `package.json`, `tsconfig.json`, `tsconfig.build.json`, `bunfig.toml`,
  `vitest.config.ts`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`,
  `.github/workflows/ci.yml`, `.github/workflows/harness-versions.yml`,
  `.plans/02-cli-surface/01_cli-surface-for-harness-normalization.rfc.md`
  (the CLI-only decision record; D1 and D12 only).
- `dist/**` as built by `pnpm build` (gitignored; rebuilt by the pass).
- Skills: `~/.agents/skills/hcn/SKILL.md`,
  `~/.agents/skills/hcn/references/reference.md`,
  `~/.agents/skills/hcn/scripts/check-claims.sh`,
  `~/.agents/skills/delegate/SKILL.md`,
  `~/.agents/skills/choose-model/SKILL.md` lines 95-135.
- lucid-v2 (read-only context, from `SCRATCH/lucid-v2/`): `PLAN.md` lines
  60-190, `AGENTS.md`, `docs/smoke-seven.md`, `package.json`, `tsconfig.json`,
  `src/modes/host.ts`, `src/modes/interactive-host.ts`,
  `src/modes/sequencer.ts`, `src/modes/headless.ts`, `src/cli/runtime.ts`,
  `src/cli/harness.ts`, `test/modes/headless.test.ts`,
  `test/modes/interactive.test.ts`, `scripts/smoke-live.ts`,
  `src/protocol/reducer.ts` (D4 only).

Out of scope, with reason:

- `test/fixtures/**` edits. The files are captured evidence. Read them; never
  write them.
- lucid-v2 defects in its own code. Report one only when it shows a normalizer
  surface that is missing or wrong (example: lucid-v2 has no arm for an event
  kind the normalizer emits - that is a normalizer contract question, D4).
- lucid-v2's current library imports and its typecheck status. The CLI
  decision supersedes them. The lucid-v2 copy is read for what lucid needs
  (events, resume, kill, questions), not for how it imports today.
- `~/dev/lucid-v2` on `pro`. Never link, install, or typecheck there.
- `.lucid/**`, `.plans/00-*`, `.plans/01-*`, `CHANGELOG.md`,
  `release-please-config.json`. History, not surface.
- Muse internals, pi internals, claude internals. The audit judges the
  descriptors' claims about them, not the harnesses.
- The untracked file `1`.

## 2. Pre-observed

Facts already verified (build on these):

- lucid-v2 `package.json` depends on
  `"@dungle-scrubs/harness-cli": "file:../harness-cli-normalizer"`. The alias
  differs from the published name.
- lucid-v2 imports deep paths only:
  `src/execution/{open-session,stream-turn,node-deps,deps,events}.js`,
  `src/knowledge/{claude-code,codex,pi,muse,descriptor}.js`,
  `src/interpretation/{capabilities,content,shape}.js`,
  `test/execution/fakes.js` (from `test/modes/headless.test.ts:6-11`).
  `package.json` `files` is `["dist","src"]`; `test/` is not packed.
- `package.json` has no `exports`, `main`, or `types`. `README.md:7`
  (`<!-- D-001 / v1: CLI-only -->`), `README.md:175`, and `README.md:230`
  say CLI-only. `~/.agents/skills/choose-model/SKILL.md:114` shows a root
  import `from "@dungle-scrubs/harness-cli-normalizer"`. These conflict.
- `bun run typecheck` in lucid-v2 on `pro` fails against the normalizer at
  `24c90a3`: TS2307 on alias paths plus errors attributed to `RunnerDeps`
  `log` and `stallMs` at `test/modes/headless.test.ts:63,64,181`. Not reproduced
  by this pass: the CLI decision retires the library path. Kept as context.
- `PLAN.md` Part 0 expects `openSession(h, opts, deps) -> { turns, send,
  interrupt?, close }`, `streamTurn(h, opts, deps) -> AsyncIterable<HarnessEvent>`,
  `identity.capabilities: CapabilityResult` with
  `source: runtime-verified | curated | unknown`, `capabilitiesOf(h, model,
  mode)`, pi persistent sessions via RPC, droppable `token|progress|context`.
  `README.md:51,235` says `hcn session` is Claude-only.

Hypotheses raised while reading (confirm or refute; each names its path):

- H1 `src/execution/deps.ts:58,61`: `stallMs` and `log` are optional
  (`stallMs?`, `log?`) at `53c400a`. `git log 24c90a3..53c400a --
  src/execution/deps.ts` is empty. lucid-v2 `src/modes/host.ts:46` and
  `src/modes/sequencer.ts:49` type the runner as `Pick<RunnerDeps, "spawn" |
  "clock" | "signal" | "stallMs" | "log">`. The "requires log and stallMs"
  attribution may be a cascade from TS2307, not a `RunnerDeps` change. Not
  examined further; lucid will not import `RunnerDeps`.
- H2 On `pro`, `~/dev/lucid-v2/node_modules/@dungle-scrubs/harness-cli` is a
  directory copy (not a symlink), `package.json` version `0.3.0`, dated
  2026-08-11 15:48, and it contains `test/execution/fakes.ts`. bun copies
  `file:` dependencies. lucid-v2's typecheck resolves against that 0.3.0 copy
  until `bun install` runs again. Context only after the CLI decision.
- H3 `src/execution/failure.ts:19-30` declares 10 `FailureClass` values
  (`native`, `timeout` added). `README.md:189` lists 8. `README.md:201` says
  `retryable` is false for 3 classes; `failure.ts:55-56` `retryableOf` returns
  false for 5. `~/.agents/skills/hcn/references/reference.md:85-88` lists 10.
- H4 `src/execution/events.ts:52` types `limit.code` as `string`, not
  `LimitCode`. PLAN `context` carries `usedPct?; used?; total?`; shipped
  `events.ts:42` carries `usedPct: number` only. PLAN `done` is `{ exitCode? }`;
  shipped `events.ts:55-60` adds `cause` and `failure`. Shipped adds kinds
  `question` and `failure` that PLAN does not list.
- H5 `SessionHandle` at `src/execution/open-session.ts:43-50` exposes `turns`,
  `send`, `close`. No `interrupt`. `send` during a live turn is queued
  (`open-session.ts:4-7`, `open-session.ts:510-521`), disposition returned as
  `{ disposition: "started" | "queued" }`.
- H6 pi has a `sessionMode` (`src/knowledge/pi.ts:47-56`, `--mode rpc`,
  `idFlag: null`, `identityProbe: get_state`). `src/cli/session.ts:10-21`
  gates on `sessionMode !== null`, not a name list. `README.md:51,235` says
  Claude-only. Commit `34399aa` changed top-level help to "claude + pi".
- H7 Descriptor freshness: claude `verifiedAgainst` 2.1.233
  (`src/knowledge/claude-code.ts:24`) vs installed 2.1.238; codex 0.147.0
  (`codex.ts:13`) vs installed 0.146.1 (installed is behind the verified
  version); pi 0.84.2 (`pi.ts:15`) equals installed; muse 0.1.0 (`muse.ts:16`)
  vs installed 0.2.1.
- H8 Fixture loading: grep for literal `fixtures/<path>` strings in `test/**`
  hits only `test/fixtures/a001-raw.ndjson` (claude) and
  `test/fixtures/phase0/hints-confirmed.md`. Six test files mention
  `fixtures` (`test/execution/stream-turn.test.ts`,
  `test/interpretation/{content,hints,identity,question}.test.ts`,
  `test/knowledge/tool-vocabulary.test.ts`). The `harnesses/*.ndjson`,
  `phase7-questions/*`, `phase8-payload-stripping/*`, and `pi-rpc-spike/*`
  fixtures are loaded through `join(...)` calls or not at all. D10 traces each
  fixture to the test that reads it.
- H9 `src/cli/exit-codes.ts:7-11` maps every non-clean `ExitCause` to 1.
  Exit 2 is set only by argument paths in `src/cli/run.ts` (`process.exitCode
  = 2` at lines 37, 92, 102, 107, 134, 139, 159, 178, 204, 234, 247). The
  `failure class=rejected` that `streamTurn` emits instead of throwing
  (`README.md:208`) may exit 1 through `exitCodeForCause`. D11 decides.
- H10 `test/execution-layering.test.ts` scans `src/execution` for the string
  literal `"user"`. It tests Claude protocol-value ownership. No test asserts
  that `node:child_process` is imported only by `src/execution/node-deps.ts`.
- H11 `test/interpretation/purity.test.ts:11-20` regex catches `from "node:`,
  `import("node:`, `require(`, `process.env`, `Date.now(`, `Math.random(`,
  `Bun.spawn|file|write`. It does not catch a bare side-effect import
  (`import "node:fs"`), `process.argv`, `process.cwd()`, `globalThis.process`,
  `fetch`, or `performance.now()`. `test/no-chat-imports.test.ts:18` regex
  catches `from "...lucid..."` and not `import("lucid")`.
- H12 `SCRATCH/lucid-v2/src/**` contains no handler for event kind
  `question` or cause `awaiting-input` (grep empty). The normalizer added both
  after PLAN Part 0. Whether the normalizer documents an additive-kind policy
  a reducer can rely on is the D4 question.
- H13 `README.md` flag table (lines 58-82) has no row for `--skills`,
  `--timeout`, `--escalate-questions`, or `--no-escalate-questions`. The hcn
  skill documents all four.
- H14 choose-model `turnOptions` observed today: `{effort, maxSteps}` (muse),
  `{effort, sandbox}` (codex), `{effort, discovery:{extensions:false}}`
  (claude), `{effort, discovery:{tools,instructionFiles,extensions:false}}`
  (glm via pi), `{effort, provider:"lmstudio", discovery:{...,skills:false}}`
  (qwen via pi). `selectedModel` for glm is `zai/glm-5.2` with no `provider`
  key; `README.md:41` spells the same target as `--provider zai/glm-5.2`.
  D9 decides which `TurnOptions` field carries `zai/glm-5.2`.
- H15 `scripts/smoke-seven.ts` parses no `--harness` or `--only` argument; it
  runs every installed harness. `scripts/e2e.ts:920-921` accepts `--only` and
  `--harness`.
- H16 codebase-memory coverage: `src/cli/session.ts` is `parse_partial`
  (lines 1-240). Read it directly. The 37 other files checked report
  `no_recorded_issue`.
- H17 `.smoke/`, `.e2e/`, and `dist/` are gitignored (`.gitignore`). `pnpm
  build` and the permitted live scripts leave `git status` clean.
- H18 `~/.agents/skills/hcn/scripts/check-claims.sh` verifies substrings of
  `hcn --help`, `hcn run --help`, `hcn session --help` only.

## 3. Safety rules for the executing pass

1. Read-only on both repositories. No `Edit`, `Write`, `sed -i`, `git
   checkout`, `git worktree`, `git stash`, or `pnpm install` inside
   `/Users/kevin/dev/harness-cli-normalizer`. `git status --short` at the end
   of every agent must show only `?? 1`.
2. Permitted repo commands: `pnpm check` (runs lint, typecheck, vitest, bun
   test, build, check:package; writes only `dist/`), `pnpm build`,
   `pnpm check:package`, `bun test`, `pnpm test`, `bun scripts/check-versions.ts`
   (network read of the npm registry), `node dist/cli.js --help`,
   `node dist/cli.js run --help`, `node dist/cli.js session --help`,
   `node dist/cli.js ls`, `node dist/cli.js inspect <harness> [--argv
   --prompt "hi" ...]`, `node dist/cli.js check`. None of these spawns a
   harness.
3. Live harness spend. Every command below spawns a real harness and spends
   provider quota. Only these are permitted, with these prompts, each at most
   once per pass. Record every run in `SCRATCH/audit/spend.md` as one line:
   `<ISO time> | <dimension> | <command> | <harness> | <model> | <turns> |
   <exit> | <evidence path>`.
   - D11: `node dist/cli.js run <h> --json --prompt "Reply with only: alpha"`
     for each of `claude`, `codex`, `pi`, `muse`. Four turns. Capture stdout
     to `SCRATCH/audit/live/<h>.ndjson` and stderr to
     `SCRATCH/audit/live/<h>.stderr`.
   - D11: one backgrounded probe, pi only:
     `timeout 120 node dist/cli.js run pi --json --prompt "Reply with only:
     alpha" > SCRATCH/audit/live/pi-bg.ndjson 2> SCRATCH/audit/live/pi-bg.stderr &`
     with NO stdin redirect. This is the deliberate stdin-hang probe; the
     `timeout 120` bounds it. A `timeout` exit (124) is the finding. This is
     the only command in the pass that runs pi in the background without
     `< /dev/null`.
   - D8 and D1: `bun scripts/e2e.ts --only question-roundtrip --harness <h>`
     for each of `claude`, `codex`, `pi`, `muse`. The scenario asks, resumes
     with the answer, and checks the resumed turn - it is the per-turn resume
     continuity proof for D1 as well as the question proof for D8. Evidence:
     `.e2e/last-run.json` (copy to `SCRATCH/audit/live/e2e-<h>.json` after
     each run; each run overwrites the file).
   - D1 kill and resume through the CLI, claude only:
     `node dist/cli.js run claude --json --prompt "Count slowly from 1 to 40,
     one number per line" > SCRATCH/audit/live/kill-1.ndjson 2>
     SCRATCH/audit/live/kill-1.stderr < /dev/null &`; record `$!`; when the
     first `token` line lands, `kill -TERM $!`; wait for exit; then
     `node dist/cli.js run claude --json --resume <id from identity>
     --prompt "Reply with only the last number you reached" >
     SCRATCH/audit/live/kill-2.ndjson`. Two turns.
   - D7: `bun scripts/e2e.ts --only session-live-ask --harness claude`. If the
     runner rejects the filter, record `blocked` and do not run the full suite.
   - D6: `bun scripts/smoke-claude.ts` once (claude only: single turn, session
     multi-turn, error propagation, kill and resume). Evidence:
     `.smoke/last-run.json`, copied to `SCRATCH/audit/live/`.
   - Forbidden: `bun run smoke:seven` (no harness filter, H15; runs four
     harnesses times seven scenarios), `bun run smoke:all`, `bun run demo`,
     `bun scripts/e2e.ts` without both `--only` and `--harness`,
     `scripts/e2e-payload-strip.ts`, any `hcn session` driven by hand.
   - A live run that hits a limit wall (`failure.class` in `rate-limit`,
     `usage-limit`, `quota`, `auth`) is recorded and not retried.
4. Any backgrounded `pi` invocation other than the single D11 probe appends
   `< /dev/null`. Any backgrounded `ssh pro` appends `< /dev/null` and passes
   `-n -o BatchMode=yes`.
5. The only compile outside the repo is D12's choose-model example. It runs
   against a scratchpad archive: `git -C /Users/kevin/dev/harness-cli-normalizer
   archive 53c400a | tar -x -C SCRATCH/harness-cli-normalizer` (create the
   directory first), then `pnpm install --frozen-lockfile` there. No
   `bun install` in `SCRATCH/lucid-v2`; nothing in `~/dev/lucid-v2` on `pro`.
6. `ssh pro` is permitted for read-only facts only (`git log`, `ls`, `cat`,
   `grep --devices=skip`). `spikes/live.in` on `pro` is a named pipe; never
   grep `spikes/` without `--devices=skip`.
7. Every normalizer file cited in a finding gets
   `mcp__codebase-memory-mcp__check_index_coverage` with
   `project: Users-kevin-dev-harness-cli-normalizer`. A `partial` result means
   the agent reads the flagged ranges directly and says so in the finding.
8. No edits to any skill under `~/.agents/skills/` or `~/dev/skills-new/`.

## 4. Dimensions

Changes from the seed list, one line each:

- Cut "Consumption surface decision": decided - lucid uses the CLI. What
  remains (README, choose-model example, and `package.json` agreeing on
  CLI-only) moves into D12.
- Cut "PLAN Part 0 contract diff": PLAN Part 0 describes a library contract
  the CLI decision supersedes. The clauses lucid still needs (events, resume,
  capabilities in `identity`) are checked by D1 and D4.
- Cut "RunnerDeps and injected-primitive stability" and "lucid-v2 typecheck
  against main": lucid will not import `RunnerDeps` or `fakes.ts`. Fakes
  become a fake `hcn` binary on lucid's side.
- Added D1 "Program-driven turn loop": real-time event delivery, per-turn
  resume continuity, kill through the CLI, schema stable enough to fake.
- Merged "Options, defaults, config, provenance" with "Tool and skill
  selection" (D9): one resolution chain, one agent.
- Merged "Descriptor freshness", "Invariant gates", and "Test evidence
  quality" into "Evidence and gates" (D10).
- Kept the rest. Ten dimensions (D1, D4-D12; numbers D2 and D3 are retired so
  cross-references stay valid), one agent each.

Shared severity rubric (each dimension adds its specifics):

- `blocker`: Q1 or Q2 cannot proceed on `53c400a` without a normalizer
  change.
- `major`: proceeds, the consumer must own a workaround (path pin, local
  fake, flag wrapper, extra parse).
- `minor`: wrong, not on the readiness path (doc drift over correct code, a
  name, a missing `.d.ts` the consumer does not import).
- `note`: observation, no action.

Surface: CLI for every dimension. Library symbols (`streamTurn`,
`openSession`, `RunnerDeps`) are read as the implementation behind the CLI,
never as a consumer surface.

### D1 - Program-driven turn loop (lucid-v2 through the CLI)

Question: can a program drive `hcn run --json` one process per turn and get
real-time events, stable resume, and a clean kill? Serves Q2.

Evidence:

- Real-time delivery: `src/cli/render.ts:84` (`writeEventNdjson`) and the
  event loop in `src/cli/run.ts` that calls it - confirm each event is written
  as it arrives, with no buffering until `done`. Live: run D11's four
  `run --json` captures through
  `while IFS= read -r l; do printf '%s %s\n' "$(date +%s.%N)" "$l"; done >
  SCRATCH/audit/live/<h>.timed` so every line carries its arrival time.
- Streaming granularity per harness: `output.pins` in `src/knowledge/claude-code.ts`,
  `pi.ts:59-62`, `codex.ts`, `muse.ts`; `capabilities.streaming` in the live
  `identity` event; `streamingGranularityOf` (`src/interpretation/argv.ts:253`).
- Per-turn resume continuity: identity authority per harness
  (`claude-code.ts:80`, `codex.ts:53`, `pi.ts:66`, `muse.ts:52`),
  `buildResumeArgv` (`argv.ts:146-163`), resume `turnOptions` specs per
  descriptor (which options are refused on resume: `unsupported-on-resume` in
  `src/interpretation/refusal.ts`). Live: the four `question-roundtrip` runs
  (Safety rule 3). For each harness record the `identity.sessionId` of turn 1
  and of turn 2 and whether turn 2 referenced turn 1.
- Kill through the CLI: `src/cli/run.ts` signal handling (grep
  `process.on("SIGTERM"`, `"SIGINT"`), `src/execution/stream-turn.ts:561-585`
  (abandonment), `267-277` (SIGTERM then SIGKILL), `src/execution/node-deps.ts`
  signal. Live: the D1 kill-and-resume pair (Safety rule 3). After the kill,
  `pgrep -fl claude` must show no child carrying the session id; the first
  capture must end with a `done` line and its `cause`; the second capture
  must reference the count.
- State between turns: none - lucid keeps state from events. List what lucid
  needs (`SCRATCH/lucid-v2/src/protocol/reducer.ts`, `src/modes/host.ts`) and
  map each to an event field. `context` is claude-only (`contextHook`).
- Fakeability: the NDJSON schema a fake `hcn` must reproduce. Compare
  `src/execution/events.ts` field by field with
  `~/.agents/skills/hcn/references/reference.md:60-72` and `README.md:217-222`.

Pass criteria:

1. Events reach stdout as they occur on all four harnesses: in each `.timed`
   capture the first non-`identity` event precedes `done` and, for token
   harnesses, token lines span more than one second of arrival time.
2. `identity.capabilities.streaming` matches what arrived (`token` harnesses
   emitted `token` lines; `message` harnesses emitted `message` only).
3. Turn 2 reaches turn 1's context on all four harnesses; codex's new thread
   id is reported in turn 2's `identity`.
4. SIGTERM to `hcn` ends the harness child within `KILL_GRACE_MS` + 1 s,
   `hcn` still writes `done` (record the `cause`), and the same id resumes.
5. Every field in `events.ts` appears in the reference or README schema.

Severity: 1 or 4 false -> `blocker` for Q2. 3 false on claude -> `blocker`;
on codex, pi, or muse -> `major`. 2 false -> `major`. 5 false -> `minor`.

### D4 - Event contract

Question: can a reducer consume `HarnessEvent` without wedging, on every
harness, including abandonment? Serves Q2 (reducer) and Q1 (NDJSON reader).

Evidence:

- `src/execution/events.ts` whole file (62 lines); `src/execution/failure.ts:33-51`.
- Ordering: `src/execution/stream-turn.ts:115-587` - find where `identity`
  is pushed, where `failure` is pushed, where `done` is pushed, and the
  `finally` at 561-585 (abandonment). `src/execution/open-session.ts:220-241`
  (`endTurn`), `421-467` (`finalize`), `499-509` (turns abandonment ->
  `close()`).
- Tests that assert ordering: `test/execution/stream-turn.test.ts`,
  `test/execution/runner-hardening.test.ts`,
  `test/execution/session-hardening.test.ts`, `test/execution/open-session.test.ts`.
  Name the test per invariant.
- Fixtures per harness per kind: `test/fixtures/phase0/bare-{claude,codex,pi,muse}.ndjson`,
  `test/fixtures/harnesses/{codex,codex-tool,codex-filetool,muse,muse-tool,muse-readtool,pi,pi-tool,pi-autherror}.ndjson`,
  `test/fixtures/a001-raw.ndjson` (claude stream-json),
  `test/fixtures/phase7-questions/ask-*.ndjson`. For each harness, which of
  `identity`, `token`, `message`, `progress`, `tool`, `context`, `limit`,
  `error`, `failure`, `question`, `done` has a fixture-backed decode test
  (`src/interpretation/content.ts:187` `contentEventsOf`, `src/execution/decode.ts:52`
  `decodeParsed`, `src/interpretation/context.ts:19`).
- Graph: `trace_path` from `streamTurn` to every `push(` of an event; from
  `decodeParsed` to `contentEventsOf`.
- Consumer side (context only): `SCRATCH/lucid-v2/src/protocol/reducer.ts`
  and `src/modes/host.ts` - list the `kind` values they switch on. H12.
- Live evidence from D11's four NDJSON captures: verify ordering on real
  output.

Pass criteria (each is a yes/no per harness, per mode `headless-turn` and
`headless-session`):

1. `identity` precedes every other kind except `error`/`limit` (state the
   exceptions the code allows and where: `open-session.ts:141,258`
   `preTurnEvents`).
2. `done` is emitted exactly once per turn and is the last event, including
   spawn failure, stall, kill, abandonment.
3. `failure` precedes `done` and `done.failure` equals the reduced summary
   (`failure.ts:188` `reduceFailures`).
4. Consumer abandonment (break out of the iterator) ends the child and both
   pumps (`stream-turn.ts:561-585`; `open-session.ts:503-509`) - cite the
   test.
5. A kind list a reducer must handle is written somewhere a consumer can read
   (README Reference line 220, or a type). Unknown-kind policy stated or not.
6. `limit.code` carries a `LimitCode` value in practice (H4) - check every
   push site.

Severity: 2 or 3 false on any harness -> `blocker` for Q2. 1 false without a
stated exception -> `major`. 4 false -> `blocker` (zombie child under
lucid-v2 kill-and-resume). 5 absent -> `major` (H12 shows the cost). 6 -> 
`minor` if the value is always a `LimitCode`, `major` if not.


### D5 - Failure taxonomy fidelity

Question: does each `FailureClass` come from a matcher with fixture evidence,
and is `retryable` right per class? Serves Q1 (fallback walk) and Q2 (limit
propagation).

Evidence:

- `src/execution/failure.ts` whole file. Table: class -> constructor
  (`failureFromLimit`, `failureFromAuth`, `failureFromTask`,
  `failureFromBudget`, `failureFromTransport`, `failureFromRejected`,
  `failureFromNative`, `failureFromTimeout`) -> call sites (graph
  `trace_path` to each) -> matcher (`src/knowledge/matchers.ts:9-31`
  shared; per-harness `limitMatchers`/`authMatchers` in
  `src/knowledge/{claude-code,codex,pi,muse}.ts`) -> fixture line that
  matches (grep the pattern over `test/fixtures/**`; `pi-autherror.ndjson`
  is the one auth fixture) -> test (`test/interpretation/limits.test.ts`,
  `test/execution/stream-turn.test.ts`, `test/execution/runner-hardening.test.ts`).
- `retryableOf` (`failure.ts:55-56`) against the README rule (`README.md:201`)
  and the delegate skill rule (`delegate/SKILL.md:42-46`).
- `failureFromLimit` mapping (`failure.ts:114-128`): `LimitCode` ->
  `FailureClass` (`session-limit` and `weekly-limit` both land in
  `usage-limit`; `credits` lands in `quota`). Does `resetsAt` ever get set?
  grep `resetsAt` under `src/`.
- Misses: take each harness's known wall phrasings from the fixtures
  (`bare-*.stderr`, `pi-autherror.ndjson`) and from `hcn inspect <h>`
  matcher dump; list any stderr line in a fixture that names a limit or auth
  condition and matches no pattern. Note `task` (`failureFromTask`) and
  `crash` (`ExitCause`) as the fall-through classes; find what lands there.
- `native` (`failure.ts:95-108`): codex exit 2 convention; check
  `test/fixtures/phase8-payload-stripping/README.md` and
  `scripts/e2e.ts:317` (`passthrough-native`) for the evidence.
- Precedence (`failure.ts:168-186`): `rejected` and `native` at 0; check
  `reduceFailures` with a `native` plus `auth` pair - which wins and is that
  the documented intent.

Pass criteria: every class has at least one path (constructor call site) and
at least one fixture-or-test that produces it; `retryable` per class matches
`README.md:201` once the README lists all ten (H3); no fixture stderr line
that names a limit or auth wall falls through to `task`/`crash`.

Severity: a class with no producing path -> `minor` (dead vocabulary). A
limit or auth wall in a fixture that lands as `task` or `crash` -> `blocker`
for Q1 (a wrapper agent will not retry). `retryable` wrong for a class ->
`blocker`. `resetsAt` documented but never set -> `major` for Q1 (choose-model
reads it). README/skill class lists disagree -> `minor`, to D12.


### D6 - Process lifecycle

Question: are spawn, stall, kill, stdin, and abandonment bounded and
identical on Node and Bun, with no zombie? Serves Q2 (kill and resume) and Q1
(backgrounded `hcn`).

Evidence:

- `src/execution/stream-turn.ts:44-48` (`KILL_GRACE_MS`, `PIPE_GRACE_MS`),
  `267-277` (SIGTERM -> SIGKILL), `296-334` (stall and `turnTimeoutMs`
  arming), `360,420` (rearm on output), `504-519` (stall vs killed
  classification), `561-585` (abandonment).
- `src/execution/open-session.ts:35` (`CLOSE_GRACE_MS`), `155-161`,
  `469-497`.
- `src/execution/node-deps.ts:44` (`disposableOutputStream`), `114-116`
  (stdin mapping `pipe`/`ignore`/`inherit`), `166-175` (stdin handle),
  `189-196` (`nodeRunnerDeps`). `stdin: "close-required"` for pi and codex
  (`src/knowledge/pi.ts:94`, `codex.ts:90`); `inherit` for claude and muse
  (`claude-code.ts:126`, `muse.ts:78`). Trace `stdinPolicyOf`
  (`src/interpretation/dimensions.ts:9`) to the spawn call in `stream-turn.ts`.
- `src/execution/channel.ts` (backpressure, single consumer), `lines.ts`
  (`LINE_MAX` 65536, discard policy).
- Tests: `test/execution/runner-hardening.test.ts`,
  `test/execution/session-hardening.test.ts`,
  `test/execution/process-output.test.ts`, `test/execution/channel.test.ts`.
  Map each criterion below to a named test.
- `test/execution-layering.test.ts` - state what it actually asserts (H10).
  Then grep `child_process|process\.kill|Bun\.spawn` under `src/` and list
  every file that matches.
- Node versus Bun: `pnpm test` and `pnpm test:bun` both run
  `test/execution/**`; confirm from `bunfig.toml` (`root = "test"`) and
  `vitest.config.ts` that the same files run. Any test that skips on one
  runtime (grep `typeof Bun`, `process.versions.bun`, `skipIf`).
- Live: the `scripts/smoke-claude.ts` run permitted in Safety rule 3 (kill
  and resume, session multi-turn, error propagation). Read
  `.smoke/last-run.json` and the boundary log it stores.
- Muse `stdin: "inherit"` with a backgrounded parent: reason from
  `node-deps.ts:114` and state whether an inherited closed stdin can block;
  no live muse background run is permitted here (D11 probes pi only).

Pass criteria:

1. Stall detection arms only when `deps.stallMs` is set and rearms on any
   output chunk; the default `nodeRunnerDeps()` has no stall budget (state
   the line). The CLI's default stall/timeout comes from `src/cli/run.ts`
   (cite the line; `--timeout` opt-in per hcn skill).
2. SIGTERM then SIGKILL after `KILL_GRACE_MS` on stall, timeout, abandonment,
   and `close()`; a test exists per path.
3. Pipes held open by a grandchild do not hang `done` (`PIPE_GRACE_MS` path
   tested).
4. pi and codex are spawned with stdin `ignore`; claude and muse inherit.
   Reason stated for each.
5. No file outside `src/execution/node-deps.ts` imports `node:child_process`
   or calls `process.kill`.
6. Both test lanes run the same execution tests with no runtime-conditional
   skips.

Severity: 2 or 3 untested on a path lucid-v2 uses (`close()`, abandonment) ->
`major`; a reproducible hang in `smoke-claude` kill-and-resume -> `blocker`.
5 false -> `major` (dual-runtime promise broken). 4 false for pi -> `blocker`
for Q1 (the hang the global instructions describe). 6 false -> `minor`.


### D7 - Sessions and resume

Question: which harnesses hold a persistent session, is refusal typed, is
`send` queued or steering, and is resume deterministic? Serves Q2 (sessions,
resume by id) and Q1 (`--resume` round trip).

Evidence:

- `sessionMode` per harness: `src/knowledge/claude-code.ts:48-62`,
  `pi.ts:47-56`, `codex.ts:43` (null), `muse.ts:43` (null).
- Refusal: `src/cli/session.ts:10-25` (read the whole file directly; H16
  partial coverage), `src/interpretation/refusal.ts:11-26` (`no-session-mode`
  in `REFUSAL_ISSUES`), `src/interpretation/session-input.ts:13-36`
  (`SessionInputRefusalError`), `src/execution/open-session.ts:90-102`.
  Which error type does a library caller get for codex/muse, and which exit
  code does the CLI give.
- `send` semantics: `open-session.ts:1-15` header, `510-531`; `SessionSendResult`
  at 39-41; where the "queued, not steering" disposition is declared for a
  consumer (README, `hcn session --help`, type doc). PLAN 104-106 expects
  "queued or steering per the declared capability" - find the capability
  field or its absence.
- pi RPC: `test/fixtures/pi-rpc-spike/README.md`, `assertions.txt`,
  `04-steer-followup.ndjson`, `05-prompt-during-stream-error.ndjson`;
  `open-session.ts:279-360` (identity probe, `success:false` surfacing).
  `test/execution/session-questions.test.ts` for the pi slice.
- Identity: `src/interpretation/identity.ts:15-60` (`IdentityOutcome`,
  rotation), `session-id.ts:13-35`, authority per harness
  (`claude-code.ts:80`, `codex.ts:53`, `pi.ts:66`, `muse.ts:52`).
- Resume: `src/interpretation/argv.ts:146-163` (`buildResumeArgv`),
  `resume-last.ts:14-93` (`rankResumeLast`, refusal on ties),
  `store.ts:37` (`storePath`), `parse-resume.ts`. `resumeLast` flags:
  codex and muse `--last`; claude and pi null. Tests:
  `test/interpretation/resume-last.test.ts`, `parse-resume.test.ts`,
  `store-context.test.ts`.
- Concurrency: two sessions of the same harness in the same cwd - does
  `rankResumeLast` refuse or pick; is the pi minted id (idFlag null) ever
  reusable for `--resume` (`pi.ts` resume block) after the process exits.
- README versus code on Claude-only (`README.md:51,235` vs `session.ts:10-21`,
  H6); `hcn session --help` text from `node dist/cli.js session --help`.
- Live: `session-live-ask` for claude (Safety rule 3) only if the filter
  works.

Pass criteria:

1. Session support is declared by descriptor data, refused with
   `no-session-mode` for harnesses without it, on both the CLI (exit 2) and
   the library (`SessionInputRefusalError` or `ArgvRefusalError` - name which).
2. `send` disposition is declared where a consumer reads it (type doc counts)
   and matches PLAN's "queued or steering" clause or states the difference.
3. pi sessions: identity arrives via the probe; a session's minted id resumes
   with `hcn run pi --resume <id>` after close (cite the evidence or mark
   unproven).
4. `resume-last` refuses ambiguous candidates rather than guessing (test
   named).
5. README Status, `hcn session --help`, and the descriptors agree on which
   harnesses have sessions.

Severity: 1 false on the library path -> `major` for Q2. 3 unproven ->
`major` for Q2 (PLAN expects pi RPC). 4 false -> `blocker` for Q1 resume on
codex/muse. 5 false -> `minor`, to D12. An undeclared steering/queue
disposition -> `major` for Q2 (lucid-v2 owns input timing per `host.ts:74`).


### D8 - Question escalation (issue #41, #44)

Question: does the round trip work per harness - worker asks, consumer
answers, worker continues - and what happens on timeout or a rejected answer?
Serves Q2 (human answers in lucid-v2) and Q1 (wrapper agent answers).

Evidence:

- `src/interpretation/question.ts` whole file (158 lines): preambles at
  21-55, `composeEscalatedPrompt` 56-65, `detectQuestionBlock` 149-158,
  last-message rule.
- `src/execution/stream-turn.ts` - the `escalateQuestions` branch (grep
  `detectQuestionBlock`, `awaiting-input`); `open-session.ts:189-227`.
- `src/cli/run.ts` - the `--escalate-questions` flags and config key;
  `src/cli/session.ts` - the answer menu (read directly, H16).
- Fixtures: `test/fixtures/phase7-questions/README.md`,
  `ask-{claude,codex,pi,muse}.ndjson`, `ask-probe-prompt.md`. Which
  harnesses' fixtures contain a well-formed `hcn-question` block.
- Tests: `test/interpretation/question.test.ts`, `test/execution/question.test.ts`,
  `test/execution/session-questions.test.ts`, `test/cli/question.test.ts`.
- Scripts: `scripts/e2e-questions.ts:54-292` (four scenarios),
  `scripts/e2e-session-questions.ts:50-133`. Read the `question-roundtrip`
  scenario to learn the id continuity rule per harness (claude stable,
  pi/muse caller-assigned, codex minted - `hcn/SKILL.md` lines 100-104).
- Timeout: what happens when the consumer never answers - is there a
  normalizer-side timer, or is the turn simply ended (`done cause
  awaiting-input`, exit 0) and the session idle. Session mode: does
  `CLOSE_GRACE_MS` or `stallMs` fire while waiting for an answer.
- Rejected answer: the resume prompt is the answer verbatim
  (`hcn/SKILL.md:97-99`); what does the worker see if the answer is not one
  of `options`; is there any validation in `run.ts` or `session.ts`.
- Malformed block -> `error` event (`open-session.ts:198-201`); confirm the
  same in `stream-turn.ts`.
- Live: `question-roundtrip` for claude and pi (Safety rule 3). Record
  `eventCounts`, `exitCode`, and whether the resumed turn referenced the
  answer.
- Consumer: lucid-v2 has no `question` arm (H12). For Q1, the wrapper-agent
  procedure is `hcn/SKILL.md:82-112`; check it against the code.

Pass criteria:

1. For each harness: a fixture with a well-formed block, a decode test, and a
   typed `question` event before `done cause=awaiting-input`, exit 0.
2. Resume with the answer reaches the same session (id continuity rule holds
   per harness; the e2e scenario asserts it).
3. Timeout behavior is stated (no timer, or a named budget) in README or the
   skill.
4. A malformed block is an `error` event in both `streamTurn` and `openSession`.
5. Under `--no-escalate-questions` no `question` event fires (test named).

Severity: 1 or 2 false for claude -> `blocker` for Q2 and Q1. 1 or 2 false
for codex/pi/muse -> `major` for Q1 (the delegate skill routes there). 3
unstated -> `major` for Q2 (a human can take hours). 4 or 5 false -> `major`.


### D9 - Options, config, provenance, tools, skills

Question: does the resolution chain do what README and the skill say, and does
choose-model's `turnOptions` map onto `TurnOptions` field for field? Serves
Q1.

Evidence:

- `src/interpretation/resolve-options.ts:14-214` (`ProvenanceTier`,
  `FloorExceededError`, `ConfigTiers`, `resolveEffectiveOptions`).
- `src/knowledge/profile.ts:15-53` (`DEFAULT_TURN_PROFILE`).
- `src/cli/config.ts:27-183` (`userConfigPath`, `projectConfigPath`,
  `parseUserConfig`, hard-fail rules), `HCN_CONFIG_DIR` (19 uses in tests).
- `src/knowledge/overrides.ts:229` (`parseOverrides`) and the graph route
  `~/.config/harness-cli/overrides.json` - find who reads it (grep
  `overrides.json` under `src/`, `scripts/`). Is the override file a fourth
  tier the README chain omits.
- `src/interpretation/turn-options.ts:30` (`renderTurnOptions`),
  `argv.ts:47-92` (`DiscoveryOptions`, `TurnOptions`).
- `src/interpretation/tool-selection.ts:23-161`, `skills-selection.ts:18-73`,
  `src/cli/skills-root.ts:16-47` (`HCN_SKILLS_ROOT`, default
  `~/.agents/skills`).
- Tests: `test/interpretation/resolve-options.test.ts`, `test/cli/config.test.ts`,
  `test/interpretation/tool-selection.test.ts`, `skills-selection.test.ts`,
  `test/knowledge/overrides.test.ts`, `test/knowledge/tool-vocabulary.test.ts`.
- choose-model: run
  `npx tsx ~/.agents/skills/choose-model/scripts/choose.ts --models` and, for
  each task in `--tasks`, one query at `stakes: normal`; collect every distinct
  `turnOptions` key and value. Compare with `TurnOptions` keys
  (`descriptor.ts:79-94` `TURN_OPTION_KEYS`) and `DiscoveryFacet`
  (`descriptor.ts:101-107`). Compare `selectedModel` values with
  `validateModel` (`src/interpretation/vocabulary.ts:39`) per harness via
  `node dist/cli.js inspect <h> --argv --prompt hi --model <selectedModel>
  [--effort <effort>] [--provider ...]`. H14: decide whether `zai/glm-5.2`
  is a `model` or a `provider` on pi.
- Provenance output: `node dist/cli.js inspect claude --argv --prompt hi
  --effort high` stderr; does every resolved key print a tier; does
  `divergence:` print for `sandbox` on non-codex.
- Silent fallthrough check: `--model <unknown>` refuses (`unknown-model`)
  rather than launching the default model; `--effort <unknown>` refuses
  (`unknown-effort`). Cite `turn-options.ts` lines and the e2e scenario
  `refusal-diagnostics` (`scripts/e2e.ts:267`).

Pass criteria:

1. Precedence is `arg > project-config > user-config > profile > harness`
   in code (`resolve-options.ts`) and both documents; the override file is
   either in the chain or documented as outside it.
2. Every choose-model `turnOptions` key is a `TurnOptions` key with the same
   value vocabulary; every `selectedModel` passes `validateModel` on its
   harness (table: model x harness x verdict).
3. `--tools` floor and named toolsets behave per `README.md:116-131` (test
   named per rule).
4. `--skills` resolves bare names against `HCN_SKILLS_ROOT`/`~/.agents/skills`,
   refuses unknown names listing the registry, and refuses on codex/muse
   with a hint (test named; a skill that exists for one harness only is
   covered by the unknown-name path or is not - state which).
5. Unknown model or effort refuses; no launch on a default.

Severity: 2 false for any model choose-model returns today -> `blocker` for
Q1 (the delegate walk passes those options). 5 false -> `blocker` (silent
fallthrough). 1 false -> `major`. 3 or 4 false -> `major`.


### D10 - Evidence and gates

Question: do the invariant gates enforce what `AGENTS.md` says, is each
harness backed by fixtures, and are the descriptors verified against the
versions in use? Serves Q1 and Q2 equally (trust in the evidence).

Evidence:

- Gates: `test/interpretation/purity.test.ts` and `test/no-chat-imports.test.ts`
  (H11). For each bypass listed in H11, write the one-line import that would
  slip through and state whether `tsc`, Biome (`biome.json`), or any other
  gate catches it. Do not add the import to the repo. `AGENTS.md` Invariants
  section is the claim to check.
- `test/execution-layering.test.ts` - per H10, state what it asserts and
  whether any test covers the `node-deps.ts` boundary (also in D6; D10 owns
  the gate verdict, D6 owns the lifecycle verdict).
- Fixture map: for each of `test/fixtures/**` (40 files), the test file that
  reads it (grep `readFileSync|Bun.file|join(` with `fixtures` across
  `test/**`) or `unreferenced`. Then per harness, per event kind, the count
  of fixture-backed assertions versus synthetic (inline string) assertions.
  Name the harness with the thinnest evidence.
- Lanes: `bunfig.toml` (`root = "test"`), `vitest.config.ts`
  (`test/**/*.test.ts`); `pnpm test -- --reporter=verbose 2>&1 | grep -c '✓'`
  versus `bun test 2>&1 | tail -3` (377 tests, 38 files today). Any file one
  lane runs and the other does not.
- Freshness: `bun scripts/check-versions.ts --json` (network; record the
  output) versus installed versions (Subjects). H7. Then read
  `.github/workflows/harness-versions.yml` (weekly, opens an issue, no
  smoke) and `scripts/smoke-seven.ts:1-30` (what the local tripwires check).
  State what a drift between `verifiedAgainst` and installed means for each
  claim the audit relies on (stream shapes in D4, matchers in D5, flags in
  D9).
- Descriptor verification commits: `git log --format='%h %ad %s'
  --date=short -- src/knowledge/claude-code.ts src/knowledge/pi.ts
  src/knowledge/codex.ts src/knowledge/muse.ts | head -20`.

Pass criteria:

1. Each bypass in H11 is caught by some gate, or the gate's scope is stated
   in `AGENTS.md` as narrower than "100% pure".
2. Every `test/fixtures/**` file is read by at least one test, and every
   harness has a fixture-backed test for `identity`, `message`, `done`, and
   one failure path.
3. Both lanes run the same file set.
4. For each harness, `verifiedAgainst` equals the installed version, or the
   delta is listed with the last verification commit and the CI issue
   status.

Severity: 1 false -> `minor` (the invariant is a design promise, not a
readiness path) unless a real violation exists today (`major`). 2 false for a
harness the delegate skill routes to (all four) -> `major`. 3 false ->
`minor`. 4: installed ahead of `verifiedAgainst` -> `note`; installed behind
(codex, H7) -> `major` for Q1 if any codex fixture depends on 0.147.0-only
output (cite it) else `note`.


### D11 - CLI ergonomics for agents

Question: can a wrapper agent branch on `hcn` exit codes and NDJSON without
parsing prose, discover harnesses without spawning, and background `hcn`
safely? Serves Q1.

Evidence:

- `pnpm build` first. Then `src/cli/exit-codes.ts` (H9), `src/cli/run.ts`
  exit paths (lines listed in H9) and the event-stream path (`writeEventNdjson`
  from `src/cli/render.ts:84`): for each refusal written to stderr, is a
  `failure` event also written to stdout under `--json`? Check the
  `ArgvRefusalError` catch blocks at `run.ts:120-180` and the
  `streamTurn`-emitted `rejected` path.
- `node dist/cli.js --help`, `run --help`, `session --help`, `inspect --help`
  versus `src/cli/help.ts` and the actual flag parser `src/cli/args.ts:154-455`
  (`parseTurnOptions`, `parseCommonFlags`, `detectPositionalPromptInjection`).
  Every flag the parser accepts appears in help and vice versa.
- `node dist/cli.js ls` and `node dist/cli.js inspect <h>` for all four:
  output is JSON (`--json`) or a stable text shape; the discovery path an
  agent would follow from `delegate/SKILL.md:23-27`.
- Live (Safety rule 3): four `run --json` turns plus the pi background probe.
  For each capture: every stdout line parses as JSON (`jq -c . < file`),
  first event kind, last event kind, `done.cause`, exit code, stderr contains
  `provenance:` lines and nothing that duplicates stdout.
- Exit code table: build from `exit-codes.ts`, `run.ts`, `session.ts`,
  `index.ts` (unknown harness, `failUnknownHarness` at `index.ts:28`) and
  compare with `hcn/SKILL.md:27-30` and `reference.md:85-95`.
- Silent fallthrough: `node dist/cli.js run codex --provider zai/glm-5.2
  --prompt hi --json` (no spawn expected - a refusal) and `node dist/cli.js
  inspect pi --argv --prompt hi --model not-a-model`. Both must refuse, not
  launch.
- Backgrounding: besides the pi probe, reason from `node-deps.ts:114` for
  claude/muse `inherit` when the parent's stdin is a closed pipe (Claude Code
  Bash background). Record as `unproven` if no evidence; do not add live
  runs.

Pass criteria:

1. Exit code is 0 for `clean` and `awaiting-input`, 1 for every failure, 2
   for every hcn refusal - including a `rejected` failure raised inside
   `streamTurn` (H9).
2. Under `--json`, every refusal or failure that reaches stderr also appears
   as a `failure` event on stdout, so an agent reading stdout alone can branch.
3. Each stdout line is one JSON object; no banners, no provenance on stdout.
4. Help lists every parser flag; `hcn ls`/`hcn inspect` run without spawning.
5. The pi background probe exits within the timeout with `done`.
6. Unknown model/provider on the wrong harness refuses with exit 2.

Severity: 1, 2, 5, or 6 false -> `blocker` for Q1. 3 false -> `major`. 4
false -> `minor`.


### D12 - Documentation truth

Question: does every claim in `README.md` Status, `PLAN.md` Part 0, the hcn
skill, the delegate skill, and the choose-model example match the code at
`53c400a`? Serves Q1 and Q2.

Evidence:

- `README.md:228-243` (Status) claim by claim; `README.md:184-215` (failure
  taxonomy and refusals; H3); `README.md:58-82` flag table (H13);
  `README.md:51,235` (H6).
- `PLAN.md` 60-190: consume D2's table; D12 adds the `superseded by README`
  rows and checks the README actually says so.
- `~/.agents/skills/hcn/SKILL.md` and `references/reference.md:1-128`: each
  flag, default, exit code, event kind, failure class, config key. Run
  `~/.agents/skills/hcn/scripts/check-claims.sh` with `dist/cli.js` on PATH
  (`PATH="$PWD/dist:$PATH"` needs an `hcn` name - create a symlink in
  `SCRATCH/bin/hcn -> /Users/kevin/dev/harness-cli-normalizer/dist/cli.js`
  and prepend `SCRATCH/bin`). Record its exit code and misses. State what
  the script does not check (H18).
- `~/.agents/skills/delegate/SKILL.md:15-60`: install instruction, flag
  names, failure-walk rule; compare with the code.
- `~/.agents/skills/choose-model/SKILL.md:112-128`: write the example to
  `SCRATCH/audit/D12-choose-example.ts` with the import specifier exactly as
  written and run `cd SCRATCH/harness-cli-normalizer && npx tsc --noEmit
  --module nodenext --moduleResolution nodenext SCRATCH/audit/D12-choose-example.ts`
  after the Safety rule 5 install (use a stub `choose`). Record `compiles` or the TS error.
  Under (A), rewrite the import to deep paths and compile again; record both.
- `CONTRIBUTING.md:1-5` describes "a library"; `README.md:9` says "no library
  API". Note which `AGENTS.md` line agrees with which.

Pass criteria: each claim marked `true`, `false` (cite code line), or
`unverifiable`. The choose-model example is marked `compiles under <surface>`
or `unrunnable`.

Severity: a `false` claim that changes what a wrapper agent does (exit code,
failure class, flag name, which harnesses have sessions) -> `major` for Q1.
A `false` claim in PLAN Part 0 that lucid-v2 builds on (event kinds,
`interrupt`) -> `major` for Q2. Choose-model example unrunnable -> `major`
for Q1. Stale prose with correct behavior -> `minor`.


## 5. Parallelization plan

Agent budget: 12 (10 dimension agents, 1 synthesis, 1 cross-family review).

Stage 0 - setup (inline, no agent): `mkdir -p SCRATCH/audit/live SCRATCH/bin`;
`cd /Users/kevin/dev/harness-cli-normalizer && pnpm build` (so every agent
has `dist/`); write `SCRATCH/audit/spend.md` header.

Stage 1 - fan out, all ten at once. No dimension depends on another's
result. D12 does its own archive and install (Safety rule 5). D1 consumes
D11's four live captures, so D11 runs them first and writes
`SCRATCH/audit/live/captures.done`; D1 starts its own runs (kill pair) in
parallel and waits on that marker only for the timing check. Each agent writes
`SCRATCH/audit/D<n>.md` with: dimension, surface assumption, evidence
consulted (paths and commands), coverage results, criteria verdicts, findings
in the Section 6 shape, spend lines appended to `spend.md`.

Live-spend owners: D11 (five runs), D8 (four `question-roundtrip` runs,
shared with D1), D1 (kill pair), D7 (one run), D6 (one run). No other
agent spawns a harness.

Stage 2 - synthesis (one agent, after all ten): merge duplicate findings (same `file:line`
and scenario); rank; write the two verdicts; produce
`SCRATCH/audit/report.md` in the Section 6 format.

Stage 3 - cross-family review (one agent, wrapper pattern): reads
`SCRATCH/audit/report.md` and the ten `D<n>.md` files; tries to refute
each `blocker` and `major` by reading the cited line; returns a list of
`upheld` / `refuted (reason)` / `downgrade to <severity>`. The synthesis
agent applies the list and writes the final `report.md`, noting any review
verdict it rejected and why.

Model routing - queries run on 2026-08-21 with
`npx tsx ~/.agents/skills/choose-model/scripts/choose.ts '<query>'`:

- Stage 1 dimension agents. Query `{"task":"research","stakes":"normal","privacy":"normal"}`.
  Selection: `muse-spark-1.2-contributor` via `muse`, reasoning `high`,
  `turnOptions {"effort":"high","maxSteps":40}`. Fallbacks in order:
  `gpt-5.6-sol` via `codex` (`{"effort":"high","sandbox":"read-only"}`),
  `opus-5` via `claude` (`{"effort":"high","discovery":{"extensions":false}}`),
  `fable-5` via `claude`. Constraint that the registry cannot express: Safety
  rule 7 requires `mcp__codebase-memory-mcp__check_index_coverage`, an MCP
  tool reachable only by in-process Claude Code agents; `muse` and `codex`
  workers reached through `hcn` have no MCP. Dimension agents therefore run
  in-process on the first Claude fallback, `opus-5` at effort `high`, with
  `fable-5` as the next fallback. Record this in the report as a capability
  constraint, not a judgment. Exception: D12 reads documents and compiles a
  sample; it cites few normalizer lines. Run D12 on the selection
  (`muse-spark-1.2-contributor` through `hcn run muse --json --effort high
  --max-steps 40 --prompt-file <brief>` from a `sonnet` low-effort wrapper
  labeled `muse-spark:D12-doc-truth`), with the synthesis agent running
  `check_index_coverage` on D12's cited files. On a retryable failure, walk
  to `gpt-5.6-sol` via `codex` (`--sandbox read-only`), then `opus-5`
  in-process.
- Stage 2 synthesis. Query `{"task":"plan","stakes":"high","privacy":"normal"}`.
  Selection: `opus-5` via `claude`, reasoning `high`,
  `turnOptions {"effort":"high","discovery":{"extensions":false}}`. Fallback:
  `fable-5`. Runs in-process.
- Stage 3 cross-family review. Query
  `{"task":"code-review","stakes":"high","privacy":"normal","excludeFamilies":["claude"]}`.
  Selection: `muse-spark-1.2-contributor` via `muse`, reasoning `high`,
  `turnOptions {"effort":"high","maxSteps":40}`. Fallbacks in order:
  `gpt-5.6-sol` via `codex` (`{"effort":"high","sandbox":"read-only"}`),
  `glm-5.2` via `pi` (`{"effort":"xhigh","discovery":{...}}`),
  `qwen3.6-27b` via `pi --provider lmstudio`. Registry warning returned
  verbatim: "no candidate meets the high-stakes minimums for code-review
  (intelligence >= 9, taste >= 8); returning the most capable candidate -
  treat its output as below the bar and verify accordingly". Run through a
  `sonnet` low-effort wrapper labeled `muse-spark:synthesis-review`, brief in
  a prompt file, `hcn run muse --json --effort high --max-steps 40
  --prompt-file <brief> --no-write --no-shell`. On `FailureSummary.retryable`
  true, walk the fallbacks in order; codex gets `--sandbox read-only`; pi
  gets `< /dev/null` if backgrounded. If every cross-family candidate fails,
  the synthesis notes "cross-family review unavailable" and does not
  substitute a Claude reviewer for that slot.
- Wrapper rules: every wrapper runs the worker via `hcn` (never `muse exec`,
  `codex exec`, `pi -p` directly), passes the brief with `--prompt-file`,
  captures NDJSON, and reports `done.cause`, `failure.class`, and
  `identity.sessionId`. Codex runs may exceed Bash's default timeout; pass
  `timeout: 600000` or background and poll the output file. Wrapper
  invocations spend provider quota on their own account; they are the
  delegation mechanism, not audit live runs, and are logged in
  `SCRATCH/audit/wrappers.md`, not `spend.md`.

## 6. Output format for the audit report

File: `SCRATCH/audit/report.md`. Sections in this order.

1. Header: commits (`53c400a`, lucid-v2 `88664eb`), date, machine, installed
   harness versions, and the CLI-only decision the verdicts assume.
2. Findings, ranked `blocker` > `major` > `minor` > `note`, numbered `F-01`
   upward. Each finding:
   - `file:line` (normalizer path; lucid-v2 paths prefixed `lucid-v2/`)
   - dimension `D<n>`
   - readiness question `Q1`, `Q2`, or `Q1+Q2`
   - severity
   - coverage: `check_index_coverage` status for the cited file
   - failing scenario: inputs and state -> wrong output, in two to four
     sentences
   - evidence: the test, fixture, command output, or live capture path
   - smallest change that flips it to pass, one or two sentences, naming the
     file and symbol
   - cross-family review: `upheld`, `refuted`, `downgraded from <x>`, or
     `not reviewed`
3. Pre-observed resolution: each H1-H18 marked `confirmed (F-nn)`,
   `refuted (reason)`, or `not examined`.
4. Spend: the contents of `SCRATCH/audit/spend.md` and `wrappers.md`.
5. Verdicts:
   - Q1 - delegated subagent tasks: `ready`, `ready with listed workarounds`,
     or `not ready`; list the blockers by `F-nn`; list the workarounds the
     consumer (delegate skill, wrapper agents) must own.
   - Q2 - lucid-v2 through the CLI, one process per turn: same three values;
     list blockers.
6. Gaps: dimensions or criteria the pass could not evaluate (blocked live
   run, limit wall, missing filter), each with the reason.
