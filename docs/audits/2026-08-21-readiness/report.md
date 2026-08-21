# Readiness audit - harness-cli-normalizer 53c400a

- Normalizer: `/Users/kevin/dev/harness-cli-normalizer`, commit `53c400a`,
  main, `package.json` 0.4.4, npm `@dungle-scrubs/harness-cli-normalizer`.
- Consumer: lucid-v2 `88664eb`, read from `SCRATCH/lucid-v2/`.
- Date: 2026-08-21. Machine: air (Darwin 25.5.0, Node v26.4.0, bun 1.3.10).
- Installed harnesses: claude 2.1.238, codex 0.146.1, pi 0.84.2, muse 0.2.1.
- Decision the verdicts assume (charter, 2026-08-21): both questions use the
  CLI surface only. lucid-v2 runs one `hcn run --json` process per turn,
  resumes by id, reads events from stdout. `hcn session` is outside the
  readiness gate, so a session-only defect is capped at `major`.
- Dimension agents ran in-process on `opus-5` because `check_index_coverage`
  is reachable only to in-process Claude Code agents. D12 ran on
  `muse-spark-1.2-contributor` through `hcn run muse`; the synthesis agent
  ran coverage for D12's cited files. This is a capability constraint, not a
  judgment of the registry selection.
- Findings below merge the ten dimension reports. Each names every
  contributing `F-D<n>-<k>` id. Where the merged severity differs from what a
  dimension wrote, the finding says so and gives the reason.
- Cross-family review: run by `muse-spark-1.2-contributor` through
  `hcn run muse` (`SCRATCH/audit/review.md`), on the three blockers and the
  twenty-three majors. 23 upheld, 0 refuted, 6 downgrades proposed (2 applied,
  1 applied one level less, 3 rejected), 1 new finding raised and verified
  (F-68). Every disposition is recorded in `## Review disposition`.
- Repo state at the end of the pass:

```
$ git -C /Users/kevin/dev/harness-cli-normalizer status --short
?? 1
```

## Findings

68 findings: 3 blockers, 21 majors, 26 minors, 18 notes. Numbers were assigned
by severity in the draft and kept stable through the review, so the four
findings whose severity changed (F-18, F-19, F-22 down; F-68 added) no longer
sit in rank order. Severity is the field, not the position.

### F-01 `src/interpretation/argv.ts:147`

- also `src/interpretation/session-id.ts:24`, `src/cli/run.ts:368`
- dimensions: D4 (F-D4-1)
- question: Q1+Q2
- severity: blocker
- coverage: `no_recorded_issue` on all three files (synthesis run,
  generation 2026-08-21T03:32:49Z)
- failing scenario: a caller resumes with an id that fails the shape rule - a
  truncated id, an id read from a crashed transcript, a token that starts
  with `-`. `buildResumeArgv` calls `assertUsableSessionId`, which throws
  `SessionIdRefusalError`. That class extends `Error`, not
  `ArgvRefusalError`, so `stream-turn.ts:217` rethrows it and the generator
  throws out of its first `next()` with zero events - no `failure`, no
  `done`. `README.md:208` states the opposite ("never throws out of its first
  `next()`"). Through the CLI the same input exits **1** with a stack trace on
  stderr and zero bytes on stdout, so a consumer reading stdout gets an empty
  stream on a failure exit and a reducer waiting for `done` never gets one.
- evidence: synthesis probe, repo root -
  `node dist/cli.js run claude --json --resume "../../etc/passwd" --prompt hi`
  -> `exit=1`, stdout 0 bytes, stderr `fatal: session id ... is not a usable
  id` followed by `SessionIdRefusalError` and a five-frame stack through
  `assertUsableSessionId` -> `buildResumeArgv` -> `run`. D4's library probe
  `SCRATCH/audit/d4/probe-resume-id.mjs` returns
  `{"events":[],"thrown":"SessionIdRefusalError: ..."}`. `run.ts:355-368`
  catches `ArgvRefusalError` only and rethrows everything else.
  `buildSessionArgv` (`argv.ts:177`) has the identical hole.
- smallest change: make `SessionIdRefusalError` an `ArgvRefusalError` with
  issue `invalid-option-value`, or catch it beside `ArgvRefusalError` in
  `stream-turn.ts:188` and in `run.ts:356`, so the existing
  `failureFromRejected` + `done` path runs and the CLI exits 2.
- severity note: D4 rated it blocker on its own rubric (criterion 2, `done`
  exactly once per turn). Upheld and widened: the synthesis probe shows the
  CLI path also violates D11 criterion 1 (exit 2 for every refusal), which
  D11 did not test on this input class.
- cross-family review: upheld

### F-02 `src/knowledge/matchers.ts:23`

- dimensions: D5 (F-D5-1)
- question: Q1+Q2
- severity: blocker
- coverage: `no_recorded_issue`
- failing scenario: the shared rate-limit matcher is the bare string `429`
  with no word boundary and no HTTP context, applied to every harness. Any
  stderr line containing those three digits - a UUID segment, a byte count, a
  port, an elapsed-ms figure - classifies the turn `rate-limit`. Because
  `state.limitSeen` is then true, the guard at `stream-turn.ts:491`
  suppresses the native and transport classification at exit, so a real
  harness error on the same turn is replaced by a fabricated retryable wall.
  A wrapper agent walks its fallback chain on a fault that never happened,
  and lucid-v2 records a limit that did not occur. No consumer can tell the
  fabricated summary from a real one.
- evidence: synthesis probe against `dist/` -
  `detectLimitInLine(claudeCode, "task_id d3665fd8-fd23-4297-ab53-4528fc517db3")`
  -> `rate-limit`; same for `"read 4291 bytes from cache"` and
  `"elapsed 1429ms"`; `"all good here"` -> `null`. D5's
  `SCRATCH/audit/d5/wall.ts` drives `streamTurn` twice with one real error:
  with the UUID line first, `done` is `{cause:"limit", failure:"rate-limit",
  retryable:true}`; without it, `done` is `{cause:"crash",
  failure:"native", retryable:false}`. `test/fixtures/harnesses/muse-readtool.ndjson`
  carries `429` inside ids on 9 of 49 lines.
- smallest change: in `SHARED_LIMIT_MATCHERS` (`src/knowledge/matchers.ts:23`)
  replace the bare `429` with an HTTP-anchored pattern such as
  `\b(?:status|code|http)[^0-9]{0,8}429\b`, so a digit run inside an
  identifier cannot match.
- severity note: D5 rated it blocker. Upheld. The frequency on live harness
  stderr is unmeasured - the four live captures had clean stderr - but the
  defect is a wrong `FailureSummary` on the exact field both consumers
  branch on, with no consumer-side workaround.
- cross-family review: upheld

### F-03 `src/cli/run.ts:35-38`

- also `run.ts:89-93, 101-103, 106-108, 126-135, 151-160, 171-179, 202-205,
  233-236, 246-249, 357-366` (eleven refusal branches)
- dimensions: D11 (F-D11-1)
- question: Q1+Q2
- severity: blocker
- coverage: `no_recorded_issue`
- failing scenario: a program runs `hcn run <h> --json ...`, captures stdout,
  and branches on the NDJSON. When hcn refuses the invocation - unknown flag,
  option not expressible on the harness, bad `--env`, bad `--max-steps`,
  unknown skill name, leading-dash positional, config error, floor violation
  - the process writes prose to stderr, sets exit 2, and writes zero bytes to
  stdout. The consumer sees an empty stream with no `failure` and no `done`,
  so it cannot tell a refusal from a crash without parsing the prose the hcn
  skill tells it never to parse. `wantJson` is read once at `run.ts:111` and
  is never consulted by any refusal branch.
- evidence: synthesis probe -
  `node dist/cli.js run codex --json --provider zai/glm-5.2 --prompt hi` ->
  `exit=2`, stdout 0 bytes, refusal prose on stderr. D11's
  `audit/live/refusal-probes.txt` (probe A) and
  `audit/live/nospawn-probes.txt` (P3, P6, P7, P8, P9) show five more refusal
  shapes with the same result. `~/.agents/skills/hcn/SKILL.md:29-31` promises
  "**2** hcn refused the invocation itself (structured - never parse prose;
  the hint and support list are fields)"; the fields exist on
  `ArgvRefusalError` and never reach stdout.
- smallest change: in `src/cli/run.ts`, replace the repeated
  `process.stderr.write(...); process.exitCode = 2` blocks with one helper
  that also calls `writeEventNdjson(failureFromRejected(err))` plus a
  `{kind:"done", cause:"failed"}` line when `wantJson` is true.
  `failureFromRejected` already exists at `src/execution/failure.ts:161`.
- severity note: D11 rated it blocker for Q1. Widened to Q1+Q2: lucid-v2
  reads events from stdout only, so a refused turn gives its reducer nothing
  at all.
- cross-family review: upheld

### F-04 `src/execution/stream-turn.ts:496`

- also `src/execution/node-deps.ts:140-142`
- dimensions: D4 (F-D4-6), D6 (F-D6-6)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: the harness binary is not installed - the most common Q1
  failure for a wrapper agent routing to codex, pi, or muse. Node reports
  ENOENT asynchronously, so `node-deps.ts:140-142` resolves `exited` with 127
  and puts the message on stderr rather than throwing. `stream-turn.ts:486-497`
  sees a nonzero exit with a non-empty stderr tail and builds
  `failureFromNative`: `retryable:false`, `done.exitCode:null`,
  `cause:"crash"`, message "the harness rejected or failed on its own
  arguments". A router obeying `retryable:false` stops instead of falling
  back to a harness that is installed, and the message blames a harness that
  never ran.
- evidence: `SCRATCH/audit/d4/probe-enoent.mjs` and
  `SCRATCH/audit/live/d6-enoent.mjs` (the latter run under Node 26.4.0 and
  Bun 1.3.10 against the built `dist/`) both produce
  `{"class":"native","retryable":false,"nativeExitCode":127}` then
  `{"cause":"crash","exitCode":null}`. `test/execution/runner-hardening.test.ts:274`
  pins the opposite classification (`transport`, `exitCode:127`,
  `cause:"failed"`) but injects a spawner that throws synchronously - a
  branch the shipped adapter never takes. The event order differs too: the
  sync branch emits `error` then `failure`, the real branch the reverse.
- smallest change: have `node-deps.ts` surface a spawn-failure flag on
  `SpawnedProcess` (it already holds `spawnError` at `:141`) and route that
  exit to `failureFromTransport` in `stream-turn.ts:493-497`, matching the
  sync-throw branch at `:242`.
- severity note: both dimensions rated it major. Upheld. It is the highest-
  consequence major for Q1 - the delegate fallback walk stops on the one
  condition it exists to survive - but a consumer can work around it by
  treating `class:"native"` with `nativeExitCode:127` as retryable, or by
  running `hcn check` first.
- cross-family review: upheld

### F-05 `src/execution/stream-turn.ts:514-526`

- dimensions: D1 (F-D1-2), D4 (F-D4-5)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: lucid-v2 or a wrapper sends SIGTERM to `hcn` to interrupt
  a turn. `run.ts:431` relays it to the child; claude handles it and exits
  143. `node-deps.ts:144` drops node's `signal` argument, and nothing tells
  `streamTurn` the exit was caller-requested, so the cause ladder reaches
  `exitCode !== 0` and reports `cause:"crash"` with
  `failure {class:"transport", retryable:true}`. The `killed` cause exists
  and is unreachable on this path. README's canonical check then routes a
  deliberate user stop into `descendFallbackChain` - a stop is re-dispatched
  as a provider outage. A harness with no SIGTERM handler exits `null` and
  gets `killed` for the same gesture, so `done.cause` for one action differs
  by harness.
- evidence: `SCRATCH/audit/live/kill-1.ndjson`, last two lines -
  `{"kind":"failure","class":"transport","retryable":true,"message":"Transport
  failure (nonzero exit 143) - retry or route to another provider"}` then
  `{"kind":"done","exitCode":143,"cause":"crash","failure":{...transport...}}`.
- smallest change: record the caller-requested stop - set a flag when the
  CLI's `onSig` (`src/cli/run.ts:426`) signals, or thread an abort signal
  into `streamTurn` - and classify that exit `cause:"killed"` with no
  `transport` failure attached.
- cross-family review: upheld

### F-06 `src/execution/decode.ts:39-43`

- dimensions: D5 (F-D5-2)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: a limit wall printed on stdout as a plain (non-JSON) line
  goes through `decodeLine`'s parse-failure branch. That branch sets
  `state.limitSeen` and returns a `{kind:"limit"}` event only. `limit` is not
  `failure`, so `stream-turn.ts:363` never pushes it into `failures` and
  `reduceFailures` returns undefined. The turn ends `cause:"limit"` with no
  `failure` field, so README's canonical `if (done.failure)` check reads the
  walled turn as a success and the delegate walk never advances to a
  fallback model. Q2 names limit propagation explicitly.
- evidence: `SCRATCH/audit/d5/wall.ts`. Same claude wall text on stderr:
  `limit, failure, done` with `done {cause:"limit", failure:"usage-limit",
  retryable:true}`. Same text on stdout as a plain line: `limit, done` with
  `done {cause:"limit", exitCode:1, failure:null}`.
- smallest change: have `decodeLine` return the `failure` event alongside the
  `limit` event as `pumpStderr` does at `stream-turn.ts:425-432`, or push
  `failureFromLimit(event.code)` at `stream-turn.ts:363` when a `limit` event
  arrives from decode.
- severity note: D5 rated it major. Upheld - a consumer can also branch on
  `done.cause === "limit"`, which is the workaround that keeps it off
  blocker.
- cross-family review: upheld

### F-07 `test/fixtures/harnesses/pi-autherror.ndjson:6` and `src/interpretation/content.ts:68-74`

- dimensions: D5 (F-D5-8), D4 (F-D4-8)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue` (`content.ts`); fixture directory scope
  reports no recorded issue
- failing scenario: a terminal `error` event that arrives with a clean exit
  code reports the turn as a success. Two inputs reach it. pi carries a
  provider 400 inside valid JSON on stdout (`"stopReason":"error"`,
  `invalid_request_error`); parsed JSON lines are never wall-scanned
  (`decode.ts:34-46` scans only the parse-failure branch), so the taxonomy
  produces an `error` event and nothing else, and at process exit 0 the turn
  ends `cause:"clean"` with `failure` undefined and no assistant text. claude
  ends a max-turns or execution error with `{"type":"result","is_error":true}`;
  `content.ts:73` emits an `error` event and nothing pushes a
  `FailureSummary`, so the same clean ending results. `events.ts:5-7` tells
  the consumer to treat `error` as informational and wait for `done`, so a
  consumer that obeys records a failed turn as a success.
- evidence: `SCRATCH/audit/d5/pierr.ts` replays all 11 fixture lines: exit 0
  -> `identity, error, done` with `done {cause:"clean", failure:null}`; exit 1
  -> `done {cause:"crash", failure:"transport"}`. `openSession` handles the
  claude twin correctly (`open-session.ts:371-376` ends the turn
  `cause:"crash"`, pinned by `session-hardening.test.ts:227`), so turn mode
  and session mode disagree on the same input; no turn-mode test pins it.
- smallest change: in `stream-turn.ts`'s stdout pump, push `failureFromTask`
  when the decoded record is a terminal error - a claude `result` with
  `is_error:true`, or a harness `error` event that ends the turn with no
  assistant content - the way `pushFailure` already handles limit and auth.
- severity note: D5 rated the pi half major, D4 rated the claude half minor.
  Merged at major: one missing arm produces both. If a live pi run confirms
  the exit-0 branch, D5's rubric ("a wall that lands as `task`/`crash`")
  would put it at blocker; the exit code pi returns for that condition is
  unproven (see Gaps).
- cross-family review: upheld

### F-08 `src/interpretation/content.ts:67`

- dimensions: D4 (F-D4-4)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: on a machine with claude `SessionStart` hooks configured,
  claude emits `system` records with subtypes `hook_started` and
  `hook_response` before `system/init`. `content.ts:63-67` turns each into a
  `progress` event, so the first nine to twenty NDJSON lines of an
  `hcn run claude --json` turn are `progress` and `identity` arrives after
  them. A consumer that reads the first line to learn the session id - the
  documented way (`reference.md:78-81`) - reads a `progress` event instead.
  The behavior follows the operator's hook config, so it appears and
  disappears between machines, and no document states the exception.
- evidence: `SCRATCH/audit/live/claude.ndjson` (2026-08-21) leads with 9
  `progress` events; `test/fixtures/phase0/bare-claude.ndjson` 8;
  `test/fixtures/phase7-questions/ask-claude.ndjson` 20. codex, pi and muse
  all lead with `identity` in the same captures and in
  `SCRATCH/audit/d4/decode-fixtures.mjs`.
- smallest change: hold `progress` events in `streamTurn` until the first
  `identity` (or first non-`progress` event) is decoded, or state the
  exception at `README.md:220` and in the skill reference's schema block so a
  consumer scans rather than reads line 1.
- cross-family review: upheld

### F-09 `src/execution/stream-turn.ts:362`

- dimensions: D1 (F-D1-1)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `hcn run <h> --json` without `--model` passes
  `opts.model ?? ""` into `decodeLine`, so `capabilitiesOf` resolves `""`,
  finds it outside `vocabulary.models`, and takes the degrade branch at
  `capabilities.ts:34-41`. Every default run announces
  `identity.capabilities = {streaming:"none", session:false, source:"unknown",
  confidence:"none"}` while the turn goes on to emit `token` events on
  claude, pi and muse and `message` events on codex. A consumer sizing its
  reducer from `identity.capabilities.streaming` - the use the charter names
  - is told "none" on every default turn on all four harnesses, and is told
  `session:false` for claude, which has a `sessionMode`.
- evidence: six identity events across
  `SCRATCH/audit/live/{claude,codex,pi,muse}.timed`, `kill-1.ndjson` and
  `kill-2.ndjson`, all `"streaming":"none","source":"unknown"`. The correct
  values are in the descriptors: `streamingByMode["headless-turn"]` is
  `token` for claude (`claude-code.ts:134`), `message` for codex
  (`codex.ts:98`), `token` for pi (`pi.ts:102`) and muse (`muse.ts:88`).
- smallest change: resolve the effective model before the decode loop and
  pass it to `decodeLine`, or take `streaming` from
  `streamingGranularityOf(h, argv)` (`argv.ts:253`), which already computes
  it from the argv actually spawned.
- cross-family review: upheld

### F-10 `src/execution/failure.ts:112-125`

- dimensions: D5 (F-D5-4)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `failureFromLimit` builds every matcher-detected wall and
  never sets `resetsAt`, for any of the six `LimitCode` values. The only
  writer is `decode.ts:88-101`, which fires solely on claude's structured
  `rate_limit_event` with `status != "allowed"`. A claude stderr wall that
  prints its reset time arrives with `resetsAt` undefined, and codex, pi and
  muse can never carry it. `~/.agents/skills/choose-model/SKILL.md:127` tells
  the router `ev.failure.resetsAt` is the wait for `rate-limit`/`usage-limit`,
  so the router has no wait to honour and re-attacks the same provider.
- evidence: `SCRATCH/audit/d5/reduce.ts` prints `resetsAt=undefined` for all
  six codes. `grep -rn resetsAt src/` returns `decode.ts:88-101` and the type
  declaration only. The one fixture record,
  `test/fixtures/a001-raw.ndjson:6`, carries `"status":"allowed"`, so the
  single writer has no fixture or test exercising it.
- smallest change: add a `resetsAt` capture convention to `LimitMatcher` and
  thread the parsed reset time through `detectLimitInLine` into
  `failureFromLimit`; failing that, drop `resetsAt` from the documented
  contract so choose-model stops reading it.
- severity note: D5 rated it major, matching the charter's D5 rubric
  ("`resetsAt` documented but never set -> major for Q1"). Upheld.
- cross-family review: upheld

### F-11 `src/interpretation/tool-selection.ts:118-122`

- dimensions: D9 (F-D9-1)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: a project config carrying the exact `tools` list from
  `README.md:122` (`["read","grep","find","ls"]`) resolves at project tier
  and reaches `renderToolSelection` for claude. None of the four names is in
  `claudeCode.tools.builtins` (`Bash, Edit, Glob, Grep, Read, Write, ...`),
  so `mapped` is empty and `excluded` becomes every known claude tool. hcn
  emits `--allowedTools read,grep,find,ls --disallowedTools Bash,Edit,Glob,
  Grep,Read,Write,...` and exits 0. The delegated claude worker has every
  real tool denied and four grants that name nothing.
  `renderToolSelection` returns `unmapped` for exactly this and
  `argv.ts:126-132` discards it - no provenance line, no warning, no refusal.
- evidence: `SCRATCH/audit/d9/floor.txt` sections "README project example on
  claude" and "README toolset 'review' on claude";
  `SCRATCH/audit/d9/refusals.txt` "claude --tools read,bash". Every existing
  test uses the correct per-harness case
  (`test/interpretation/tool-selection.test.ts:67-73` vs `:81-84`), so the
  cross-harness case is untested.
- smallest change: in `renderToolSelection`, refuse with `unknown-tool-name`
  when `mapped` is empty and `unmapped` is non-empty on a harness whose
  include list is not a strict allowlist, listing `h.tools.builtins`; or have
  `src/cli/run.ts` print a `provenance: unmapped tools = [...]` line from the
  discarded `RenderedToolSelection.unmapped`.
- cross-family review: upheld

### F-12 `src/interpretation/resolve-options.ts:165-176`

- dimensions: D9 (F-D9-2)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: a caller passes `--no-tools` on pi. The profile key
  `tools: "all-known"` (`profile.ts:42`) is untouched by args and by config,
  so the `all-known` branch expands it to pi's full built-in list at profile
  tier. `renderTurnOptions` emits `-nt` for `discovery.tools:false` and
  `turnTail` appends `--tools read,bash,edit,write,grep,find,ls`. pi reads
  `-nt` as "disable all tools" and `--tools` as an allowlist to enable, so
  the profile grant re-enables every built-in the caller switched off,
  including `bash`, `edit` and `write`. The same happens on the privacy
  route: choose-model's `qwen3.6-27b` entry asks for `-nt -nc -ne -ns` and
  hcn ships those flags plus the full tool grant.
- evidence: `SCRATCH/audit/d9/inspect-matrix.txt` entries 9 and 10;
  `SCRATCH/audit/d9/provenance.txt` "pi, unknown effort" shows the profile
  tier supplying the list. `grep -rn "tools: false" test/` returns nothing,
  so no test sets `discovery.tools:false` at all.
- smallest change: in `resolveEffectiveOptions`, skip the `all-known`
  expansion when `effectiveArgs.discovery?.tools === false`, and record the
  skip as a provenance entry.
- severity note: D9 rated it major per its criterion-3 rubric. Upheld. It is
  the major with the widest blast radius for the privacy routing rule, since
  the containment flags are the point of that route.
- cross-family review: upheld

### F-13 `README.md:189` and `README.md:204`

- also `README.md:192`, `~/.agents/skills/delegate/SKILL.md:42-46`,
  `~/.agents/skills/choose-model/SKILL.md:135`
- dimensions: D1 (F-D1-5), D4 (F-D4-7), D5 (F-D5-5), D12 (F-D12-2, F-D12-7)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `README.md` is the only contract document shipped with
  the package. Its taxonomy block declares `FailureClass` with 8 members
  (`native` and `timeout` missing against 10 in `failure.ts:19-30`),
  `ExitCause` with 6 (`awaiting-input` missing against 7 in
  `events.ts:20-29`, though the prose at `README.md:151` names it), and says
  `retryable` is false for three classes while `retryableOf` returns false
  for five. `FailureSummary` omits `supportedBy`, `hint` and
  `nativeExitCode`. A consumer writing an exhaustive switch from the README
  has no arm for the two classes and one cause the runner emits most often
  outside the happy path, and its retryable table is wrong for exactly the
  two classes F-04 and F-19 produce. `delegate/SKILL.md:42-46` and
  `choose-model/SKILL.md:135` repeat the three-class rule, so an agent that
  follows the prose retries a `native` argument error through the whole
  chain. Nothing anywhere states an additive-kind policy, so a consumer has
  no written basis for tolerating a kind it does not know.
- evidence: synthesis read of `README.md:186-206` -
  `type FailureClass = "rate-limit" | "usage-limit" | "quota" | "auth" |
  "budget" | "task" | "transport" | "rejected";`,
  `type ExitCause = "clean" | "limit" | "crash" | "stall" | "killed" |
  "failed";`, and "`retryable` is `false` for `task`, `budget`, `rejected`".
  `SCRATCH/audit/d5/reduce.ts` retryable table: 5 false, 5 true.
  `~/.agents/skills/hcn/references/reference.md:85-93` is correct (10 classes,
  7 causes), so the three documents disagree with each other.
  `grep -rni 'unknown kind|additive|new kinds'` over `README.md`, `AGENTS.md`
  and `events.ts` returns nothing.
- smallest change: regenerate the `README.md:189-204` block from
  `FAILURE_CLASSES`, `ExitCause` and `retryableOf`, add one sentence next to
  `README.md:220` stating kinds and classes are additive and a consumer must
  ignore what it does not recognize, and add `native` and `timeout` to the
  non-retryable list in `delegate/SKILL.md` and `choose-model/SKILL.md`.
- severity note: D1 and D5 rated it minor (doc drift routes to D12); D4 and
  D12 rated it major. Merged at major, per the charter's D12 rubric - a false
  claim that changes what a wrapper agent does (failure class, retryable) is
  major for Q1 - and because it is the schema a fake `hcn` binary would be
  built from for Q2.
- cross-family review: upheld

### F-14 `~/.agents/skills/choose-model/SKILL.md:114`

- dimensions: D12 (F-D12-5)
- question: Q1
- severity: major
- coverage: not a normalizer file; `package.json` is `no_recorded_issue`
- failing scenario: the skill's fallback-walk example imports
  `{ streamTurn, nodeRunnerDeps, ... } from
  "@dungle-scrubs/harness-cli-normalizer"`. `package.json` declares no
  `exports`, no `main`, no `types`, and ships only `dist` and `src`, so the
  root specifier does not resolve. A consumer that copies the example gets
  TS2307. The example is the documented bridge between choose-model's
  `turnOptions` and the runner, so the one place the two skills meet does not
  compile.
- evidence: `tsc -p SCRATCH/audit/D12-tsconfig.json` against the pristine
  archive - TS2307 "cannot find module" for
  `SCRATCH/audit/D12-choose-example.ts` (root import, verbatim from the
  skill); `SCRATCH/audit/D12-choose-example-deep.ts` (same code with deep
  `src/...` paths) compiles under the same config.
- smallest change: rewrite the skill example to drive the CLI
  (`hcn run --json`) as the CLI-only decision requires, or - if a library
  path is wanted - add `exports`/`types` to `package.json`.
- cross-family review: upheld (reviewer asked to downgrade to minor; rejected - see Review disposition)

### F-15 `src/cli/inspect.ts:186`

- dimensions: D7 (F-D7-4), D1 (F-D1-6)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `hcn run <h> --resume <id>` skips turn-option resolution
  (`run.ts:240` gates `resolveEffectiveOptions` on `extra.resume ===
  undefined`) and builds the resume argv from the raw parsed options.
  `hcn inspect <h> --argv --resume <id>` builds from `fullOpts`, the resolved
  profile. The preview shows flags the real run will not pass, and on codex
  it refuses outright: the resolved profile carries `sandbox:
  "workspace-write"`, `codex.ts:123` sets `resumeRender: null` for `sandbox`,
  and `turn-options.ts:224` throws `unsupported-on-resume`. An agent using
  `inspect --argv` to check a resume before spending a turn is told codex
  resume is impossible when it works.
- evidence: `node dist/cli.js inspect codex --argv --resume
  11111111-2222-4333-8444-555555555555 --prompt hi` prints `"sandbox" cannot
  be expressed on resume for codex; supported: effort, systemPrompt`. For
  claude the preview prints `--effort high` while the real resumed spawn line
  in `SCRATCH/audit/live/kill-2.stderr` carries no `--effort`.
- smallest change: in `src/cli/inspect.ts`, build the resume preview from the
  unresolved turn options on the `values.resume` branch, mirroring `run.ts`'s
  launch-only rule.
- severity note: D1 rated it minor, D7 major. Merged at major: the delegate
  skill sends agents to `hcn inspect` to check flags, and on codex the
  preview refuses a resume the run performs.
- cross-family review: upheld

### F-16 `src/cli/inspect.ts:113-125`

- dimensions: D9 (F-D9-4)
- question: Q1
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `run.ts:186-199` resolves `--skills` names to absolute
  paths through `resolveSkillNames` and builds `__claudeSkillTokens`.
  `inspect` does neither. `hcn inspect pi --argv --prompt hi --skills
  bogus-name` exits 0 and emits `-ns --skill bogus-name` - a bare name where
  the run emits an absolute path, and no refusal where the run refuses.
  `hcn inspect claude --argv --prompt hi --skills hcn` emits no skill tokens
  at all, because the `--settings skillOverrides` pair is appended only in
  `run.ts:348-352`. The preview is not the argv the run builds.
- evidence: `SCRATCH/audit/d9/skills.txt` (six inspect probes) against
  `SCRATCH/audit/d9/skills-run.txt` (the same unknown name refuses under
  `run`).
- smallest change: call `resolveSkillNames` and `claudeSkillOverridesArg` in
  `inspect` before `buildLaunchArgv`, as `run.ts:186-199` does, and append
  the claude tokens to the previewed argv.
- cross-family review: upheld

### F-17 `README.md:134-157`

- also `~/.agents/skills/hcn/SKILL.md:78-121`
- dimensions: D8 (F-D8-1)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: lucid-v2 escalates a `question` to a human who walks away
  for six hours. Nothing in README, `hcn run --help`, or the hcn skill says
  whether hcn holds state, whether a budget expires, or whether the id stays
  resumable. The code answer is "no timer at all, in either mode" - the
  `question` event is emitted after `proc.exited`, the turn ends
  `awaiting-input`, hcn exits 0, and the answer arrives as a new process -
  but a consumer has to read `stream-turn.ts` and `open-session.ts` to learn
  it, and a wrapper agent cannot know whether it must bound the wait itself.
- evidence: `grep -i "never answer|no timer|answer.*timeout|idle|indefinit"`
  over `README.md`, `~/.agents/skills/hcn/SKILL.md` and
  `references/reference.md` returns nothing. Code path traced by D8 at
  `stream-turn.ts:473-475, 520-523`, `run.ts:463`, `open-session.ts:160, 473,
  494` (all three session timers arm on other events; `deps.stallMs` is not
  read in `open-session.ts`).
- smallest change: add two sentences to the "Question escalation" section of
  `README.md` and mirror them in `SKILL.md` step 2 - a turn that ends
  `awaiting-input` arms no answer timer because the process has exited and
  the id stays resumable; `hcn session` keeps the process alive with no idle
  budget of hcn's own.
- cross-family review: upheld

### F-18 `scripts/smoke-claude.ts:124`

- dimensions: D6 (F-D6-1)
- question: Q1+Q2
- severity: minor
- coverage: `scripts/` outside the checked set; the source it turns on,
  `src/execution/stream-turn.ts`, is `no_recorded_issue`
- failing scenario: the claude smoke script asserts `done.exitCode === 127`
  for a spawn failure. Commit `986ce17` added `nativeReduced`
  (`stream-turn.ts:545-560`), which nulls `done.exitCode` when the reduced
  failure is `native`, and did not update the script. The scenario fails and
  the script exits 1. CI never runs the smoke script
  (`.github/workflows/ci.yml` has no smoke step), so the lifecycle gate for
  the one harness with live coverage has been red, unobserved.
- evidence: the permitted live run.
  `SCRATCH/audit/live/smoke-claude.json`, scenario "error propagation (spawn
  failure)", `pass:false`, detail
  `{"exitCode":null,"cause":"crash","failure":{"class":"native",
  "nativeExitCode":127}}`; `4/5 scenarios green`, exit 1.
- smallest change: change the assertion in `scripts/smoke-claude.ts:124` to
  `done.failure.nativeExitCode === 127` with `done.exitCode === null`,
  matching the `nativeReduced` decision - and fix F-04 first, since that
  decides which class the scenario should expect.
- cross-family review: downgraded from major to minor (reviewer asked for note; see Review disposition)

### F-19 `src/execution/stream-turn.ts:318-335`

- dimensions: D6 (F-D6-2)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `turnTimeoutMs` is the only bounded budget the CLI can
  arm (`run.ts:401` sets it from `--timeout`; nothing sets `stallMs`). A
  wrapper agent that backgrounds `hcn run <h> --timeout 600` depends on that
  timer firing, escalating SIGTERM then SIGKILL, classifying
  `watchdogReason = "turn-deadline"`, and producing `failureFromTimeout` with
  `cause:"killed"`. No test in the repository sets `turnTimeoutMs`, so none of
  it is pinned: a regression that never arms the deadline, mislabels it
  `stall`, or makes it retryable passes both lanes.
- evidence: `grep -rn "turnTimeoutMs" test/ src/ scripts/` returns exactly one
  line, `src/cli/run.ts:401`. Both lanes report 377/377 passing with the path
  unexercised (`SCRATCH/audit/live/d6-vitest.log`, `d6-buntest.log`).
- smallest change: add a test beside `test/execution/stream-turn.test.ts:88`
  that passes `{turnTimeoutMs: 100}` with a `FakeClock`, advances past it plus
  `KILL_GRACE_MS`, and asserts `["SIGTERM","SIGKILL"]` with
  `done.cause === "killed"` and `failure.class === "timeout"`.
- cross-family review: downgraded from major

### F-20 `test/fixtures/` (21 of 40 files unread) and `test/interpretation/content.test.ts:25-147`

- dimensions: D10 (F-D10-3, F-D10-4)
- question: Q1+Q2
- severity: major
- coverage: fixture scope reports `total: 0` recorded issues;
  `content.test.ts` and `identity.test.ts` are `no_recorded_issue`
- failing scenario: 21 of 40 files under `test/fixtures/` are read by no test
  and named by no source file, including the two
  `phase8-payload-stripping/codex-instructions-*.ndjson` captures that are the
  evidence for the feature `53c400a` shipped, and all eight
  `phase0/bare-*.{ndjson,stderr}` captures. Separately, no harness has
  fixture-backed assertions for all four kinds the criterion names: claude has
  no `test/fixtures/harnesses/*.ndjson` at all, so its `message`, `token` and
  `tool` decoding rests on inline strings; codex, pi and muse have no
  fixture-backed `identity` and no fixture-backed `done`. If codex renames
  `thread.started` or muse renames `run.terminal.completed`, the
  deterministic suite stays green and the break surfaces only in a live run.
- evidence: `SCRATCH/audit/D10-fixture-list.txt` (40 files) against
  `grep -rn "fixtures" test/ --include="*.ts"` (9 hits, of which 4 are loads);
  per-harness table in `D10.md` "Fixture map";
  `grep -rln "decodeIdentity" test/` returns two files, neither feeding a
  codex, pi or muse capture.
- smallest change: capture `test/fixtures/harnesses/claude.ndjson`, add a
  `streamTurn` replay per harness asserting `identity`, `message` and `done`
  (generalizing `stream-turn.test.ts:189-205` over `HARNESSES`), and add one
  inventory test that `readdirSync`s `test/fixtures` and fails on any
  `.ndjson` no test opens.
- cross-family review: upheld (reviewer asked to downgrade to note; rejected - see Review disposition)

### F-21 `test/interpretation/limits.test.ts:1-52`

- dimensions: D5 (F-D5-6)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: no fixture matches any of the 34 compiled
  `limitMatchers`/`authMatchers` entries across the four descriptors, so no
  wall phrasing in the repo is evidence-backed. The only matcher test uses
  hand-written strings and only the claude descriptor - codex's
  `run codex login` and every pi and muse matcher are untested and
  unfixtured. At the failure-event level only `transport` and `native` are
  asserted; `rate-limit`, `quota`, `budget`, `task`, `auth`, `usage-limit`,
  `rejected` and `timeout` have no test that reaches the class. A harness
  that changes its wall wording passes `pnpm check` while silently ceasing to
  classify.
- evidence: `SCRATCH/audit/d5/scan.ts` - 33 of 34 matcher entries report
  `NO FIXTURE`; the 34th is the `429` false-positive of F-02.
  `grep -rn 'class: "<c>"' test/` returns nothing for the eight classes
  above. `grep -rn turnTimeoutMs test/` is empty.
- smallest change: add a table-driven test feeding one representative line
  per matcher entry through `detectLimitInLine` and
  `detectAuthFailureInLine` for all four descriptors, plus one `streamTurn`
  fake-process test per failure class asserting `done.failure.class` and
  `done.failure.retryable`.
- cross-family review: upheld (reviewer asked to downgrade to minor; rejected - see Review disposition)

### F-22 `scripts/check-versions.ts:56-66`

- dimensions: D10 (F-D10-6)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `resolveLatest` compares `verifiedAgainst` to the npm
  registry's `dist-tags.latest` for every `versionSource.kind === "npm"`
  harness (claude, codex, pi) and never reads the installed binary. A machine
  whose installed CLI is older than `verifiedAgainst` - the codex case today
  - reports `status: "behind"` relative to npm and gives no signal about the
  local mismatch. Every claim verified by running the local CLI is checked
  against a descriptor anchored to a version that is not installed, and the
  weekly workflow cannot detect it. The `installed` path exists at
  `check-versions.ts:46-54` and only muse uses it.
- evidence: `SCRATCH/audit/D10-check-versions.json` - codex row
  `verifiedAgainst 0.147.0`, `latest 0.149.0`, `status behind`, no installed
  field; installed is 0.146.1.
- smallest change: call `installedVersion(h.bin)` for every descriptor in
  addition to the npm lookup, add it to `Row`, and set a distinct status when
  `installed !== verifiedAgainst`.
- cross-family review: downgraded from major

### F-23 `src/knowledge/descriptor.ts:256` and `src/execution/stream-turn.ts:258`

- dimensions: D7 (F-D7-2)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `resume.onMissing` is `"create"` for pi and muse
  (`pi.ts:37`, `muse.ts:38`) and its own doc comment warns that a consumer
  resuming a session it believes exists gets a blank session, not an error.
  Nothing in `src/` reads the field. So `hcn run pi --resume <stale-or-typo-id>`
  runs a fresh, historyless session; the harness announces the requested id,
  so `decodeIdentity` returns `announced` rather than `rotated` and the
  stream carries a normal `identity` and a clean `done`. lucid-v2's turn
  strategy feeds `resumeId` back per turn (`lucid-v2/src/modes/host.ts:127,
  167, 184`) with no way to see the context was dropped.
- evidence: `grep -rn 'onMissing' src/ test/ scripts/ README.md` returns
  descriptor lines plus `test/knowledge/harnesses.test.ts:249-252`, which
  only asserts the values; `stream-turn.ts:258` and
  `identity.ts:70-80` show rotation is the only anomaly the runner detects.
- smallest change: in `streamTurn`, when `effective.resume` is set and
  `h.resume.onMissing === "create"`, emit a warning `error` event (or a field
  on `identity`) naming the create-on-missing risk, and document it under
  `--resume` in `src/cli/help.ts`.
- severity note: D7 rated it major. Upheld - it sits on the per-turn resume
  path the charter puts on the readiness path, but a consumer can work around
  it by only resuming ids it saw in an `identity` event this session.
- cross-family review: upheld

### F-24 `src/execution/open-session.ts:449`

- dimensions: D4 (F-D4-2), D5 (F-D5-9)
- question: Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: a session turn hits a usage-limit wall or the child
  crashes. `openSession` emits `limit` and `error` events and ends the turn
  with `done.cause` `limit` or `crash`, but never emits a `kind:"failure"`
  event and never sets `done.failure` - the file has no `failure.js` import
  and no `failureFrom*` call. README's canonical `if (done.failure)` check is
  always false in session mode, so a router sees a done turn with no class,
  no `retryable`, no `resetsAt` and no `code`. The same wall in `streamTurn`
  gives a full `FailureSummary`.
- evidence: `grep -rn 'kind: *"failure"' src/` returns no
  `open-session.ts` hit; the only `done` constructions are
  `open-session.ts:373` and `:449`, neither carrying `failure`.
  `grep -rn failureFrom src/execution/open-session.ts` is empty.
  `session-hardening.test.ts:227-244` asserts `done.cause:"crash"` and
  nothing about `done.failure`.
- smallest change: track a `FailureSummary[]` in `openSession` as
  `streamTurn` does, fed by the limit branches at `:299`/`:395` and the auth
  branch at `:401`, reduce it in `endTurn`, and attach the result to `done`.
- severity note: D4's own rubric makes it a blocker for criterion 3; capped
  at major because the charter puts session mode outside the readiness gate.
- cross-family review: upheld

### F-25 `src/interpretation/argv.ts:178-185`

- dimensions: D7 (F-D7-1)
- question: Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: `buildSessionArgv` unconditionally prepends
  `h.launch.baseFlags` before `h.sessionMode.flags`. For pi, `baseFlags` are
  the one-shot turn flags `["-p","--mode","json"]`, so `hcn session pi`
  spawns `pi -p --mode json --mode rpc` - `--mode` twice with conflicting
  values, plus `-p` (one-shot print) on a process meant to hold a
  bidirectional rpc session. The verified invocation in the spike the
  descriptor cites is `pi --mode rpc` with neither flag.
  `descriptor.ts:258-259` calls `sessionMode.flags` "the exact flag set that
  opens one lucid-owned process", which the builder contradicts.
- evidence: synthesis read of `argv.ts:178-185` confirms the unconditional
  spread. D7's library probe prints
  `pi session argv : ["pi","-p","--mode","json","--mode","rpc"]`
  (`SCRATCH/audit/d7-lib-probe.mjs`);
  `test/fixtures/pi-rpc-spike/spike.py:87` launched `["pi","--mode","rpc"]`.
  `test/execution/session-questions.test.ts:163-165` asserts only
  `toContain("--mode")` and `toContain("rpc")`, so no test catches it. claude
  is unaffected - its `baseFlags` are `["-p"]`, which its session mode needs.
- smallest change: give `sessionMode` its own base-flag set, or have
  `buildSessionArgv` skip `h.launch.baseFlags` and read the full argv prefix
  from `h.sessionMode.flags`; then pin the whole argv in the test.
- severity note: session-only, so capped at major by the charter.
- cross-family review: upheld

### F-26 `src/knowledge/pi.ts:47-56`

- dimensions: D7 (F-D7-3)
- question: Q2
- severity: major
- coverage: `no_recorded_issue`
- failing scenario: pi's session mode has `idFlag: null`, so the id is minted
  by pi and read only through the `get_state` probe. Whether that minted id
  then resumes through the turn path (`hcn run pi --resume <id>`, which
  spells it `--session-id` under `-p --mode json`) is shown by no test,
  fixture, or captured run. The spike README says `--session <id>` re-enters
  in RPC mode - a different flag in a different mode. If the two namespaces
  differ, a flow that opens a pi session, reads the identity, closes and
  resumes gets a blank session, compounded by F-23's silent create.
- evidence: `test/fixtures/pi-rpc-spike/assertions.txt` (25 assertions, none
  about turn-mode resume); no `test/**` reference to a pi session-to-turn
  resume.
- smallest change: capture one live probe - open `pi --mode rpc`, read
  `get_state`'s `sessionId`, close, then run `pi --session-id <id> -p --mode
  json "<recall prompt>"` - store it under `test/fixtures/pi-rpc-spike/` and
  record the result in the `resume` comment block of `src/knowledge/pi.ts`.
- cross-family review: upheld

### F-27 `src/cli/run.ts:432-441`

- dimensions: D1 (F-D1-3)
- question: Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `onSig` sends SIGTERM to the child and awaits a plain
  `setTimeout(..., KILL_GRACE_MS)` that is never cancelled when the child
  exits early. The timer keeps node's event loop alive, so `hcn` cannot exit
  sooner than 5 s after SIGTERM however fast the harness dies. A consumer
  killing a turn per user interrupt sees a fixed 5 s stall on every
  interrupt.
- evidence: `SCRATCH/audit/d1-kill.sh` output -
  `kill_to_exit_seconds=5.011` while the child's exit code 143 proves it died
  of SIGTERM, not of the grace-expiry SIGKILL.
- smallest change: keep the escalation timer handle in `onSig` and clear it
  once the `for await` over `streamTurn` completes, or `unref()` it.
- cross-family review: not reviewed

### F-28 `src/interpretation/context.ts:19`

- dimensions: D4 (F-D4-3)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: a consumer builds a context-usage gauge because
  `README.md:220` lists `context` as a normalized kind and `:222` names it
  droppable. No runner emits it: `contextEventFrom` has zero callers in
  `src/`, and neither `decodeParsed`, `streamTurn` nor `openSession` calls
  it. The gauge stays empty forever on all four harnesses with no error to
  explain why.
- evidence: `trace_path contextEventFrom inbound depth 3` ->
  `callers_total: 0`; `trace_path streamTurn outbound depth 2` (39 callees)
  does not contain it; no live capture and no fixture holds a `context` line.
- smallest change: route the claude statusline channel into
  `contextEventFrom` from `src/execution/`, or drop `context` from
  `HarnessEvent`, `DROPPABLE_KINDS`, and `README.md:220`.
- cross-family review: not reviewed

### F-29 `src/execution/events.ts:52`

- dimensions: D4 (F-D4-9)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `limit.code` is declared `string`, so a consumer writing
  an exhaustive switch on the six `LimitCode` values gets no compile-time
  help and must keep a default arm. In practice the value is always a
  `LimitCode`: all four push sites take it from `detectLimitInLine`
  (`LimitCode | null`) and `decode.ts:100` hard-codes `"rate-limit"`. A type
  width problem, not a data problem.
- evidence: push sites `stream-turn.ts:428`, `decode.ts:42`,
  `open-session.ts:299`, `:395`; `limits.ts:141` signature;
  `descriptor.ts:43-49` union. `FailureSummary.code` is already narrowed
  (`failure.ts:37`).
- smallest change: change `readonly code: string` to `readonly code:
  LimitCode` at `src/execution/events.ts:52` and import the type from
  `../knowledge/descriptor.js`.
- cross-family review: not reviewed

### F-30 `README.md:51` and `README.md:235`

- dimensions: D7 (F-D7-5), D12 (F-D12-1)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: README says "Session (Claude-only)" and "sessions
  (`hcn session`) remain Claude-only". `SESSION_HELP` says "claude, pi" and
  "claude | pi (others have no sessionMode)"; the top-level help says
  "claude + pi" (commit `34399aa`); `pi.ts:47-56` declares `sessionMode`; and
  `session.ts:14-18` gates on the descriptor, not a name list. A reader who
  trusts README will not try `hcn session pi`.
- evidence: synthesis read of `README.md:51,235`; `node dist/cli.js session
  --help`; `src/cli/session.ts:10-21` (file coverage `partial` 1-240, read
  in full by D7 and D8).
- smallest change: change both README lines to name claude and pi, matching
  `SESSION_HELP` in `src/cli/help.ts`.
- severity note: D12 rated it major on its "which harnesses have sessions"
  clause; D7 rated it minor. Set to minor: session mode is outside the
  readiness gate, so this is stale prose over correct code and cannot block
  either question.
- cross-family review: not reviewed

### F-31 `src/cli/help.ts:19-88` and `README.md:58-82`

- dimensions: D11 (F-D11-2), D12 (F-D12-3), D8 (H13 half), D9 (H13 half)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: an agent following `delegate/SKILL.md:25-27` reads
  `hcn run --help` to find the skills flag. `RUN_HELP` documents only
  `--no-skills` (the discovery facet), so the agent concludes `--skills` does
  not exist and inlines skill guidance into the prompt, on pi and claude
  where `--skills` works. `--session-id` has the same problem - a working
  `--resume` alias absent from all run help. The README flag table
  additionally omits `--timeout`, `--escalate-questions`,
  `--no-escalate-questions`, `--system-prompt` and `--append-system-prompt`.
- evidence: `SCRATCH/audit/live/nospawn-probes.txt` P4 and P5 (`run --help |
  grep -c -- "--skills"` -> 0; same for `--session-id`); parser accepts both
  at `args.ts:426` and `:445`; `run.ts:188-209` acts on `--skills`.
  `check-claims.sh` never lists either flag, so its presence-only check
  cannot catch the omission.
- smallest change: add `--skills <a,b>` and `--session-id <uuid>` rows to
  `RUN_HELP`, add the six missing rows to the README flag table, and add both
  flags to the `hcn run --help` expectation list in `check-claims.sh`.
- cross-family review: not reviewed

### F-32 `src/execution/stream-turn.ts:395-398`

- also `src/execution/open-session.ts:198-201, 226`
- dimensions: D8 (F-D8-2)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: a worker tries to ask but botches the JSON in the
  `hcn-question` block. Detection returns `{malformed}`,
  `emitQuestionIfAsked` pushes an `error` event and returns before setting
  `asked`, so the cause ladder keeps `cause:"clean"` with exit 0. A consumer
  branching on `done.cause` reads a completed turn, drops the worker, and
  never escalates, while the worker believes it ended blocked on an answer.
- evidence: `test/execution/question.test.ts:110-122` asserts exactly this
  outcome - error event present, `done` is `{exitCode:0, cause:"clean"}`.
- smallest change: in `emitQuestionIfAsked` (both files), set a distinct flag
  on the malformed branch and let the done cause carry it, instead of leaving
  the turn indistinguishable from a clean completion.
- cross-family review: not reviewed

### F-33 `src/cli/run.ts:311`

- dimensions: D8 (F-D8-3)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: nothing validates the resume prompt against the
  question's `options`. An out-of-options or evasive answer becomes the next
  prompt, and because `run.ts:311` composes the escalation preamble onto
  every turn including resumes, the worker may ask again - another
  `question`, `awaiting-input`, exit 0. Each `hcn run` is a fresh process, so
  no ask counter exists anywhere; an unattended wrapper answering
  mechanically can loop ask -> answer -> ask without bound.
- evidence: `grep -n "options" src/cli/run.ts` shows no question-options use;
  `test/execution/question.test.ts:149-166` shows the resume turn carries the
  same preamble; `scripts/e2e-questions.ts:267` treats a second ask as a
  scenario failure, which is the scenario's rule, not the code's.
- smallest change: state in `SKILL.md` step 3 that the answer is unvalidated
  and a resumed turn may ask again, and have the wrapper cap ask cycles.
- cross-family review: not reviewed

### F-34 `src/cli/args.ts:255-256`

- dimensions: D7 (F-D7-7)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `parseRunExtra` maps both `--resume` and `--session-id`
  onto `extra.resume`, with `--session-id` assigned second, so
  `hcn run claude --resume A --session-id B` silently resumes B.
  `src/cli/inspect.ts:184` uses the opposite precedence
  (`values.resume ?? values["session-id"]`), so the two commands disagree
  when both are given. `--session-id` also suggests assigning an id at
  launch, which hcn never does.
- evidence: `node dist/cli.js inspect claude --argv --session-id <uuid>
  --prompt hi` renders `claude --resume <uuid> ...`; the two precedence lines
  read directly.
- smallest change: refuse `mutually-exclusive-options` in `parseRunExtra`
  when both flags are present, and document `--session-id` as a `--resume`
  alias in `RUN_HELP`.
- cross-family review: not reviewed

### F-35 `src/cli/skills-root.ts:38-44`

- dimensions: D9 (F-D9-5)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `resolveSkillNames` hardcodes `harness: "claude"` and
  `issue: "unknown-tool-name"` regardless of the harness in play. A caller
  running `hcn run pi --skills bogus-name` reads a refusal that names claude
  and gives tool-complement remedy prose instead of a skills remedy. The
  registry listing that follows is correct, so the refusal is recoverable.
- evidence: `SCRATCH/audit/d9/skills-run.txt`, first section.
- smallest change: pass the harness name into `resolveSkillNames` and add a
  dedicated `unknown-skill-name` issue to `src/interpretation/refusal.ts`
  with skills-shaped remedy text.
- cross-family review: not reviewed

### F-36 `src/interpretation/resolve-options.ts:148-151`

- dimensions: D9 (F-D9-6)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `README.md:129-131` says "an empty floor refuses every
  grant". An explicit `--tools read` against `{"tools": []}` does refuse.
  With no `--tools` arg the floor check is skipped and `resolved.tools = []`
  flows into `renderToolSelection` as an empty include list, so hcn emits
  `--allowedTools "" --disallowedTools <all 13>` on claude and `--tools ""`
  on pi - an empty argv token rather than an omitted flag. Exit 0.
- evidence: `SCRATCH/audit/d9/floor.txt` sections "empty floor, no --tools
  (claude)" and "(pi)"; `test/interpretation/resolve-options.test.ts:171-187`
  asserts the value and never renders the argv.
- smallest change: in `renderToolSelection`, treat an empty include list as
  "deny everything" - emit the deny complement with no empty include token on
  claude, and refuse on pi where `--tools ""` has no defined meaning.
- cross-family review: not reviewed

### F-37 `README.md:41`

- dimensions: D9 (F-D9-7)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue` (`src/knowledge/pi.ts`)
- failing scenario: `README.md:41` shows
  `hcn run pi "name three primes" --provider zai/glm-5.2`. pi's `provider`
  spec is `kind: "selector"` (`pi.ts:112`), validated only against
  `CLEAN_SELECTOR`, which `zai/glm-5.2` matches, so hcn accepts it and passes
  it to pi, whose `--provider` takes a bare provider name. The model id
  belongs in `--model`, where `pi.ts:76` curates it. Both spellings exit 0,
  so nothing tells the caller which is right.
- evidence: `SCRATCH/audit/d9/inspect-matrix.txt` entries "H14a" and "H14b",
  both exit 0; `pi --help` provider line; `~/.pi/models.json` provider keys.
- smallest change: correct `README.md:41` to `--model zai/glm-5.2`; a tighter
  fix narrows pi's `provider` spec from `selector` to an enum of known
  provider names.
- cross-family review: not reviewed

### F-38 `src/cli/run.ts:271-279`

- dimensions: D9 (F-D9-9)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: the branch prints "divergence: setting-sources isolation
  also skips hooks, LSP and keychain reads on claude - weighed, not refused"
  when `discovery.instructionFiles === false` on claude. claude's descriptor
  declares no `instructionFiles` facet, so `renderTurnOptions` refuses the
  facet two lines later and the run exits 2. The advice line describes a
  spelling the CLI will not build.
- evidence: `hcn run claude --prompt hi --no-instruction-files` prints the
  divergence line, then `claude cannot express discovery facet
  "instructionFiles"`, exit 2 (D9 probe).
- smallest change: add an `instructionFiles` facet to
  `claudeCode.turnOptions.discovery` rendering `--setting-sources project`,
  or delete the branch and keep the text in the refusal hint at
  `src/interpretation/hints.ts`, where it already appears.
- cross-family review: not reviewed

### F-39 `src/cli/inspect.ts:147-204`

- dimensions: D9 (F-D9-3)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `inspect` calls `resolveEffectiveOptions` and
  destructures only `resolved.options`, dropping `provenance` and
  `unrenderable`. `hcn inspect claude --argv --prompt hi --effort high`
  writes one `argv:` line to stderr and nothing else, so the only no-spawn
  command in the CLI prints no tier for any resolved key and no `divergence:`
  line. An agent that wants to know which tier set a value must spend a live
  turn on `hcn run`, which does print both.
- evidence: `SCRATCH/audit/d9/provenance.txt` - `run` prints seven
  `provenance:` lines plus a `divergence:` line for the resolution `inspect`
  prints nothing for.
- smallest change: write the same `provenance:` and `divergence:` lines
  `run.ts:257-280` writes, or add `--provenance` to `INSPECT_HELP` and gate
  them on it.
- cross-family review: not reviewed

### F-40 `src/cli/inspect.ts:53-77`

- dimensions: D5 (F-D5-7)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `inspect`'s descriptor dump is a hand-written allowlist
  of nine keys that omits `limitMatchers` and `authMatchers`. An agent
  driving hcn from the CLI cannot see which wall phrasings hcn recognizes,
  cannot tell whether a matcher override took effect, and cannot report why a
  real wall was missed - which is what F-02 and F-21 make expensive.
- evidence: `node dist/cli.js inspect <h>` for all four returns keys
  `['bin','launch','name','resume','sessionMode','turnOptions',
  'verifiedAgainst','versionSource','vocabulary']`.
- smallest change: add `limitMatchers: h.limitMatchers` and
  `authMatchers: h.authMatchers` to the `out` object; both are already
  serializable data.
- cross-family review: not reviewed

### F-41 `test/interpretation/purity.test.ts:11-21` and `test/no-chat-imports.test.ts:18`

- dimensions: D10 (F-D10-1, F-D10-2)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue` on both
- failing scenario: both gates match one import form. A change adding
  `import "node:fs";`, `import fs from "fs";`, `process.argv`,
  `process.cwd()`, `performance.now()`, `fetch(...)`, `crypto.randomUUID()`
  or `Bun.env` under `src/interpretation` or `src/knowledge` passes the
  purity regex, `tsc --noEmit`, and Biome. A file under `src/execution` or
  `src/cli` writing `require("lucid")`, `await import("lucid")` or
  `import "lucid/frames";` passes the chat-seam regex. `AGENTS.md` says
  "Both layers stay 100% pure" and describes the seam as enforced.
- evidence: `SCRATCH/audit/bypass/regex-results.txt` - 14 of 15 candidates
  pass both regexes; the control row C4 is `CAUGHT`, proving the harness is
  wired. `SCRATCH/audit/bypass/tsc-out.txt` empty at exit 0; `biome check`
  returns `Found 1 info.` at exit 0. No violation exists in the tree today.
- smallest change: replace `IMPURITY` with an allow-list scan (reject any
  import specifier that is not a relative path) plus arms for `\bprocess\.`,
  `\bfetch\(`, `\bperformance\.`, `\bcrypto\.`, `\bBun\.`, `\bnew Date\(`,
  `\bglobalThis\b`; and change `FORBIDDEN` to a specifier match
  `/["'][^"']*(lucid|\/frames|chat-protocol|\/reducer)[^"']*["']/`.
- cross-family review: not reviewed

### F-42 `test/execution-layering.test.ts:12`

- dimensions: D6 (F-D6-5), D10 (F-D10-7)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: the file named for layering asserts one thing - that no
  source under `src/execution` contains the string literal `"user"` (claude's
  session-input protocol value). It says nothing about `node:child_process`,
  `process.kill` or `Bun.spawn`, so the dual-runtime invariant `AGENTS.md`
  states as "enforced by tests" is prose only. A new
  `import { spawn } from "node:child_process"` in
  `src/execution/stream-turn.ts` passes every gate in `pnpm check`, and the
  Bun lane keeps passing because Bun implements the module. The boundary
  holds today; only the gate is missing.
- evidence: `test/execution-layering.test.ts:12-39` read in full;
  `grep -rnE "child_process|process\.kill|Bun\.spawn" src/` returns
  `src/cli/check.ts:1` (CLI layer, see F-56), `src/execution/node-deps.ts:2,9`
  (the sanctioned adapter) and comments. No `process.kill` call site exists.
- smallest change: add a second test to `test/execution-layering.test.ts`
  that reads every `.ts` under `src/execution` and asserts
  `node:child_process` and `process.kill` appear in no file except
  `node-deps.ts`.
- cross-family review: not reviewed

### F-43 `src/execution/failure.ts:134-144`

- dimensions: D5 (F-D5-3)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `failureFromTask` and `failureFromBudget` have zero
  callers in `src/`, `test/` or `scripts/`, and no path constructs
  `class:"task"` or `class:"budget"` by literal. Both classes sit in
  `FAILURE_CLASSES` and in `retryableOf`'s non-retryable arm, and
  `README.md:204`, `delegate/SKILL.md:44` and choose-model instruct agents to
  stop the walk on them, but hcn cannot emit them. A model that exhausts
  `maxSteps` or fails the work surfaces as `clean`, `native` or `transport`.
- evidence: `trace_path` inbound on both symbols returns `callers_total: 0`
  with tests included; `grep -rn` returns only the definitions.
- smallest change: call `failureFromBudget` from the `maxSteps`-exhaustion
  path and `failureFromTask` from a harness-reported work verdict (F-07 needs
  the same constructor), or drop both from `FAILURE_CLASSES`.
- cross-family review: not reviewed

### F-44 `src/execution/stream-turn.ts:566-569`

- dimensions: D6 (F-D6-3)
- question: Q1+Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: the abandonment branch calls `escalate()`, which sends
  SIGTERM and arms a `KILL_GRACE_MS` SIGKILL timer. The abandonment tests
  stop at SIGTERM. If a consumer breaks out of the turn and the child ignores
  SIGTERM, only that timer prevents a leaked process, and it is cleared in
  the same `finally` after `await Promise.all([proc.exited,
  pumpSettlements])`, so the SIGKILL depends on the awaited exit resolving
  first. Nothing tests the wedged-child abandonment case.
- evidence: `runner-hardening.test.ts:50-67` asserts SIGTERM only;
  `:203-252` uses a `signal` fake that exits the process immediately so
  escalation never runs. The pair is asserted only on the stall path
  (`:332`) and the session `close()` path (`session-hardening.test.ts:85`).
- smallest change: add a test that abandons a turn with
  `fakeSignal({autoExit:false})`, advances the `FakeClock` past
  `KILL_GRACE_MS`, and asserts `["SIGTERM","SIGKILL"]`.
- cross-family review: not reviewed

### F-45 `scripts/e2e-questions.ts:277-290`

- dimensions: D1 (F-D1-4), D8 (F-D8-4)
- question: Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `questionRoundtripScenario` is the charter's proof of
  per-turn resume continuity, but it exempts codex from the id-continuity
  assertion (`if (harness !== "codex")`) and returns `eventCounts: {}` with
  no session ids. `.e2e/last-run.json` records only `{durationMs, exitCode,
  eventCounts:{}, failures:[], ok}`, so neither D1's criterion 3 codex
  sub-clause nor D8's event census is recoverable from the artifact, and a
  regression in codex id reporting would still show `ok:true`.
- evidence: `SCRATCH/audit/live/e2e-codex.json` -
  `[{"durationMs":17187,"exitCode":0,"eventCounts":{},"failures":[],
  "scenario":"question-roundtrip","harness":"codex","ok":true}]`; same empty
  shape in the three siblings.
- smallest change: add `sessionIds: {turn1, turn2}` and filled `eventCounts`
  to `ScenarioResultLite`, and assert on codex that turn 2 announced an
  identity rather than skipping the harness.
- cross-family review: not reviewed

### F-46 `src/execution/decode.ts:65`

- dimensions: D1 (F-D1-7)
- question: Q2
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: the identity event's `authority` is copied from the
  descriptor constant, so it describes what the harness accepts, not what
  happened to this id. `buildLaunchArgv` never renders `launch.idFlag` - the
  only use is `buildSessionArgv` - so a `hcn run` launch never assigns an id
  and every first-turn id is harness-minted, yet claude, pi and muse all
  report `"authority":"caller-assigned"`. A consumer branching on
  `authority` to decide whether it already knows the id is told the wrong
  thing on every launch.
- evidence: `SCRATCH/audit/live/kill-1.stderr` spawn line carries no
  `--session-id` while `kill-1.ndjson` announces
  `"authority":"caller-assigned"`; `pgrep -fl <id>` returned nothing before
  and after the kill.
- smallest change: set the event's `authority` from whether this turn
  supplied the id (`state.requestedId !== null`), or rename the descriptor
  field to say it is a capability.
- cross-family review: not reviewed

### F-47 `src/interpretation/argv.ts:170-176`

- dimensions: D7 (F-D7-6)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: `buildSessionArgv`'s `no-session-mode` refusal sets
  `supported: ["session is available where sessionMode is declared"]` -
  prose, not harness names - while `refusal.ts:42` states the contract as
  "every message names an alternative so an agent can pivot without reading
  the descriptor". A library consumer reading `err.supported` to pick a
  fallback gets an unparsable sentence; the CLI dodges it by recomputing the
  list itself (`session.ts:15-18`), which duplicates the logic.
- evidence: synthesis read of `argv.ts:170-176`; D7's library probe prints
  the prose value against the CLI's `supported: claude, pi`.
- smallest change: derive `supported` from `defaultDescriptors()` filtered on
  `sessionMode !== null`, and drop the duplicate list in `src/cli/session.ts`.
- cross-family review: not reviewed

### F-48 `test/interpretation/argv.test.ts` (absence)

- dimensions: D7 (F-D7-8)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue`
- failing scenario: no test builds a session argv or opens a session for
  codex or muse, so the `no-session-mode` branch at `argv.ts:170-176` and the
  CLI gate at `session.ts:14-29` are both unpinned. A refactor that reordered
  `buildSessionArgv`'s guard behind `resolveSessionInput` would change the
  thrown type to `SessionInputRefusalError` and no test would fail.
- evidence: `grep -n 'no-session-mode|buildSessionArgv' test/**/*.ts` returns
  only claude cases (`argv.test.ts:55`, `granularity.test.ts:12,28,63`).
- smallest change: add a case asserting `buildSessionArgv(codexCli, ...)`
  throws `ArgvRefusalError` with `issue === "no-session-mode"`.
- cross-family review: not reviewed

### F-49 `CONTRIBUTING.md:1` and `AGENTS.md:7` versus `README.md:9`

- dimensions: D12 (F-D12-4)
- question: Q1
- severity: minor
- coverage: `no_recorded_issue` on all three
- failing scenario: CONTRIBUTING and AGENTS call the repo a library that
  normalizes into pure data layers; README says there is no library API and
  the CLI is the product. A newcomer - or an agent reading the repo to decide
  how to consume it - gets two conflicting surface promises, which is how the
  choose-model example in F-14 came to import the package root.
- evidence: `CONTRIBUTING.md:1-5`, `AGENTS.md:7`, `README.md:7,9`.
- smallest change: edit the first line of `CONTRIBUTING.md` and `AGENTS.md`
  to say the repo is a CLI product with internal library layers, not an
  install surface.
- cross-family review: not reviewed

### F-50 `src/cli/run.ts:257-280`

- dimensions: D1 (F-D1-8)
- question: Q2
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: everything about how the turn resolved - `provenance:`,
  `divergence:`, `spawn:` - is written to stderr only, in both render modes,
  by design ("stdout carries the NDJSON contract"). A consumer reading only
  NDJSON cannot tell which effort, sandbox, tool set or escalation mode the
  turn ran with, so lucid must capture and parse stderr as a second channel
  or accept not knowing.
- evidence: `SCRATCH/audit/live/kill-1.stderr` carries eight
  `provenance:`/`divergence:` lines and the spawn line;
  `kill-1.ndjson` carries none of it.
- smallest change: none for readiness - recorded so the consumer plans for
  two streams per turn. Carrying it on stdout would mean a new event kind,
  which is a contract decision.
- cross-family review: not reviewed

### F-51 `src/cli/exit-codes.ts:7`

- dimensions: D11 (F-D11-3)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `exitCodeForCause` is exported and asserted by two test
  files, but no file under `src/` imports it - `run.ts:462-467`
  re-implements the mapping inline. The exit-code contract is proven against
  a helper the CLI does not call, so a change to `run.ts:462-467` alone
  leaves both tests green. Separately, `streamTurn` yields a
  `class:"rejected"` failure with `cause:"failed"`, and `run.ts:462-467` has
  no arm for `failure.class`, so that shape would exit 1 rather than 2 - the
  path is unreachable from `hcn run` today because argv is pre-built and
  refusals are caught first.
- evidence: `grep -rn "exitCodeForCause" src/ test/ scripts/` returns only
  the definition and the two test files.
- smallest change: make `run.ts` call `exitCodeForCause` and give it a
  `failure.class === "rejected" -> EXIT_REFUSAL` arm, so the tested helper
  and the shipped mapping are the same code.
- cross-family review: not reviewed

### F-52 `src/cli/args.ts:270-321`

- dimensions: D11 (F-D11-4)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `KNOWN_FLAGS` omits `--skills` and `--timeout`;
  `FLAGS_WITH_VALUE` omits `--skills`. `detectPositionalPromptInjection`
  skips a value only after a `FLAGS_WITH_VALUE` token, so a `--skills` value
  beginning with a dash is read as a positional prompt and refused with
  "positional prompt may not start with '-'", naming the wrong flag.
- evidence: `args.ts:270-304` (33 entries, neither flag) against
  `args.ts:417-451` (`parseCommonFlags` options, 33 entries including both);
  the refusal text is the one in `nospawn-probes.txt` P8.
- smallest change: derive `KNOWN_FLAGS` and `FLAGS_WITH_VALUE` from the
  `parseCommonFlags` option table instead of hand-listing them.
- cross-family review: not reviewed

### F-53 `src/cli/ls.ts:12`

- dimensions: D11 (F-D11-5)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `hcn ls` is the no-spawn discovery command an agent
  reaches for first. It prints `<name>@<verifiedAgainst> (<source>)` from the
  descriptor, not the installed binary, and has no `--json`. An agent reads
  `claude@2.1.233` while 2.1.238 is installed, and must regex the text line
  to get a name; `ls --json` exits 2.
- evidence: `SCRATCH/audit/live/ls-inspect.txt`; `audit/live/check.txt`
  (`hcn check` reports the same three harnesses behind, exit 1).
- smallest change: accept `--json` in the `ls` case of `src/cli/index.ts` and
  have `ls()` emit one JSON array of
  `{name, bin, verifiedAgainst, versionSource}`.
- cross-family review: not reviewed

### F-54 `src/knowledge/pi.ts:82`

- dimensions: D11 (F-D11-6)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `hcn inspect pi --argv --prompt hi --model not-a-model`
  renders the argv and exits 0. pi's vocabulary is `extensible: true` by
  ratified decision D-008, so a typo in a pi model id is not caught by hcn
  and surfaces only as a native pi error at run time. An agent that trusts
  hcn to validate `--model` before spending a turn does not get that on pi.
  claude, codex and muse are `extensible: false`.
- evidence: `SCRATCH/audit/live/refusal-probes.txt` probe B, exit 0;
  `descriptor.ts:324-327` documents the accept rule.
- smallest change: none to the code - the behavior matches D-008. State it in
  `~/.agents/skills/hcn/SKILL.md` so a caller knows pi model ids are
  unvalidated.
- cross-family review: not reviewed

### F-55 `src/execution/node-deps.ts:114`

- also `src/knowledge/muse.ts:78`
- dimensions: D11 (F-D11-7), D6 (F-D6-8)
- question: Q1
- severity: note (unproven)
- coverage: `no_recorded_issue`
- failing scenario: `stdio[0]` is `ignore` only when the descriptor says
  `stdin: "close-required"` - pi and codex. claude and muse say `inherit`, so
  the child gets whatever fd 0 the parent has. When that fd is `/dev/null` or
  a closed pipe a read returns EOF and nothing blocks; when it is a
  controlling terminal and the parent is backgrounded, a child read raises
  SIGTTIN and stops the process group - the same wedge the pi rule exists to
  prevent. Whether `muse exec` 0.2.1 reads fd 0 at all is not established,
  and muse's descriptor carries no reason at its `stdin` line while pi's and
  codex's both do.
- evidence: `node-deps.ts:110-118` stdio table; `stream-turn.ts:235`;
  `pi.ts:94`, `codex.ts:90`, `claude-code.ts:126`, `muse.ts:78`. The
  permitted pi background probe passed
  (`SCRATCH/audit/live/pi-bg.ndjson` ends `{"cause":"clean"}`, exit 0 in 9 s
  of a 120 s budget), which proves the `close-required` arm, not the
  `inherit` arm. The charter forbids adding live runs for this.
- smallest change: run one backgrounded `hcn run claude --json` with fd 0
  closed (`0<&-`) and one backgrounded muse turn, then record the reason at
  `src/knowledge/muse.ts:78` and bump `verifiedAgainst` with it.
- cross-family review: not reviewed

### F-56 `src/cli/check.ts:1`

- dimensions: D6 (F-D6-4)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `src/cli/check.ts` imports `execFileSync` from
  `node:child_process` and calls it to read `<bin> --version`. The invariant
  `AGENTS.md` and `src/execution/index.ts:7-8` state is scoped to the
  execution layer and holds - the only `node:child_process` import under
  `src/execution/` is `node-deps.ts:9`. Bun implements the module, so
  `hcn check` runs on both runtimes and no portability break was observed.
- evidence: `grep -rnE "child_process|process\.kill|Bun\.spawn" src/`; both
  test lanes green.
- smallest change: none required; if the invariant is meant to be CLI-wide,
  route `installedVersion` through an injected primitive the way
  `RunnerDeps.spawn` does.
- cross-family review: not reviewed

### F-57 `src/cli/run.ts:394-402`

- dimensions: D6 (F-D6-7)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: the CLI arms no inactivity budget. `stallMs` is never set
  and `nodeRunnerDeps()` sets only `spawn`, `clock` and `signal`. The
  wall-clock `turnTimeoutMs` is opt-in and undefined without `--timeout` or a
  config entry. A backgrounded `hcn run` against a harness that connects and
  then goes silent runs until the parent kills it. This is a design choice -
  the stall machinery exists and works - but a Q1 consumer that backgrounds
  `hcn` owns the timeout.
- evidence: `run.ts:399-402` chooses between `nodeRunnerDeps({turnTimeoutMs})`
  and bare `nodeRunnerDeps()`; `grep -rn "stallMs" src/cli/` returns nothing.
- smallest change: state in the `delegate` and `hcn` skills that `--timeout`
  is required for a backgrounded run, or give `stallMs` a default in
  `src/cli/run.ts`.
- cross-family review: not reviewed

### F-58 `src/knowledge/codex.ts:13` and `.github/workflows/harness-versions.yml:10-11`

- dimensions: D10 (F-D10-5, F-D10-8)
- question: Q1+Q2
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: codex's descriptor claims `verifiedAgainst: "0.147.0"`
  while the installed binary is 0.146.1, so it was never verified against the
  CLI this machine runs; claude (2.1.233 vs 2.1.238) and muse (0.1.0 vs
  0.2.1) are stale the other way. The drift workflow runs Mondays only and
  opens one issue; today three harnesses are behind and no issue is open, so
  a reader sees a clean board while three descriptors are stale. No codex
  fixture depends on 0.147.0-only output, so the rubric keeps this a note.
- evidence: `SCRATCH/audit/D10-check-versions.json` (`behind: ["claude",
  "codex", "muse"]`); `strings -a` on the 0.146.1 binary finds all six codex
  event names the fixtures use; `gh issue list --label harness-update --state
  all` returns one closed issue (#32, 2026-08-17) that covered claude and pi
  only; `git log -S'0.147.0' -- src/knowledge/codex.ts` shows the value set
  at `032c45a` and never re-verified.
- smallest change: re-run the local tripwires and bump `verifiedAgainst` in
  `claude-code.ts`, `codex.ts` and `muse.ts` together with their
  `versionSource`, and add `pull_request` to the workflow's `on:` so drift is
  reported per PR rather than weekly.
- cross-family review: not reviewed

### F-59 `src/execution/failure.ts:176-189`

- dimensions: D5 (F-D5-10)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `PRECEDENCE` gives `native` priority 0, so
  `reduceFailures([native, auth])` returns `native` and an auth wall on the
  same turn would be hidden. The pairing is unreachable: `native` is only
  constructed under `failures.length === 0` (`stream-turn.ts:487`), so it
  never coexists with another failure. The entry is dead configuration that
  reads as an intent it cannot express.
- evidence: `SCRATCH/audit/d5/reduce.ts` - `reduce(native, auth) -> native`
  both orders; `reduce(limit, auth) -> auth` both orders.
- smallest change: state the unreachability in the comment at
  `failure.ts:185-186`, or move `native` below `auth` so the table would be
  correct if the guard loosened.
- cross-family review: not reviewed

### F-60 `src/cli/run.ts:491-499`

- dimensions: D5 (F-D5-11)
- question: Q2
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: the CLI's synthesized transport failure builds one object
  carrying `kind: "failure"` and then nests that same object as
  `done.failure`. Every other `done.failure` in the stream is a bare
  `FailureSummary`, so a consumer switching on keys sees a stray `kind` field
  inside `done.failure` on this one path.
- evidence: `src/cli/run.ts:491-499` read directly.
- smallest change: split the literal into a bare `FailureSummary` and spread
  `kind` only into the standalone event.
- cross-family review: not reviewed

### F-61 `src/execution/open-session.ts:432`

- dimensions: D4 (F-D4-10)
- question: Q2
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `finalize` surfaces a pump failure and dropped queued
  sends through `routeEvent`. With no turn active, `routeEvent` appends to
  `preTurnEvents` and the next line closes `turnsChannel`, so those errors
  reach no consumer - only a log line - while the file header promises queued
  sends are "surfaced, never silently dropped". Separately `preTurnEvents` is
  capped at 256 and evicts the oldest non-droppable entry, which is the
  `identity` event, so a session that buffers 256 lossless events before its
  first `send` loses its identity announcement.
- evidence: `open-session.ts:243-266`, `:434-457`, `:37`, `:259-264`;
  `session-hardening.test.ts:209-225` passes because it kills the session
  while a turn is live.
- smallest change: in `finalize`, when `activeTurn` is null, push a synthetic
  final turn carrying the drained `preTurnEvents` plus a `done` before
  closing the channel.
- cross-family review: not reviewed

### F-62 `src/cli/session.ts:117`

- dimensions: D7 (F-D7-10)
- question: Q2
- severity: note
- coverage: **partial** (`parse_partial` 1-240; read in full with the Read
  tool by D7 and D8)
- failing scenario: for a harness with `sessionMode.idFlag === null` (pi),
  the banner prints `opts.sessionId`, a `randomUUID()` minted by the CLI that
  no harness ever sees, while `renderEvent` later prints the real
  harness-minted id from the identity probe. An operator reading the banner
  and passing that id to `hcn run pi --resume` resumes nothing and, per F-23,
  silently creates.
- evidence: `session.ts:49-52, 116-118` against `open-session.ts:321-334` and
  `src/cli/render.ts:18-20`.
- smallest change: print the banner id only when
  `h.sessionMode.idFlag !== null`, and otherwise wait for the identity event
  to name the session.
- cross-family review: not reviewed

### F-63 `src/cli/session.ts:31-35`

- dimensions: D7 (F-D7-11)
- question: Q1
- severity: note
- coverage: **partial** (`parse_partial` 1-240; read in full by D7)
- failing scenario: `session()` handles `--help` at line 31, but
  `src/cli/index.ts:124-128` intercepts `--help`/`-h` before dispatching, so
  the block is unreachable. It also hides that the sessionMode gate at line
  14 runs before it: a reader expects `hcn session codex --help` to refuse,
  and it prints help and exits 0 while `hcn session codex` exits 2.
- evidence: `node dist/cli.js session codex --help` -> SESSION_HELP, exit 0;
  `node dist/cli.js session codex` -> exit 2.
- smallest change: delete the `--help` block from `src/cli/session.ts`.
- cross-family review: not reviewed

### F-64 `~/.agents/skills/hcn/scripts/check-claims.sh:41-92`

- dimensions: D12 (F-D12-6), D11 (H18)
- question: Q1
- severity: note
- coverage: not a normalizer file
- failing scenario: the script asserts only that named substrings are present
  in `hcn --help`, `hcn run --help` and `hcn session --help`. It never
  enumerates the parser, the event schema, the failure classes, the config
  keys, or the refusal issues, so every drift this audit found in those
  dimensions passes it. It exited 0 against `53c400a` while F-13, F-31 and
  F-30 were all true.
- evidence: script read in full; `PATH=SCRATCH/bin:$PATH bash
  ~/.agents/skills/hcn/scripts/check-claims.sh` exit 0 (D12).
- smallest change: extend the script to diff the documented event kinds and
  failure classes against `hcn inspect`/a `--schema` dump, or state its
  limited scope in `SKILL.md` so a green run is not read as a contract check.
- cross-family review: not reviewed

### F-65 `src/execution/open-session.ts:39-41`

- dimensions: D7 (F-D7-9)
- question: Q2
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: the `started`/`queued` disposition exists only in the
  TypeScript type and the module header. Nothing in README, `hcn session
  --help` or the hcn skill mentions queueing or steering, and the CLI writes
  `disposition: queued (turn in progress)` to stderr as prose, never as a
  structured event. A CLI-only consumer that owns input timing cannot read
  the disposition programmatically. PLAN lines 104-106 expect "queued or
  steering per the declared capability"; no descriptor field distinguishes
  the two and hcn always queues.
- evidence: `grep -rn -i 'queued|disposition|steering|steer' README.md
  src/cli/help.ts ~/.agents/skills/hcn/SKILL.md
  ~/.agents/skills/hcn/references/reference.md` returns nothing;
  `src/cli/render.ts:16-45` has no `send` arm.
- smallest change: document the queue-not-steer rule in `SESSION_HELP` and
  the README session section.
- cross-family review: not reviewed

### F-66 `src/knowledge/overrides.ts:229`

- dimensions: D9 (F-D9-8)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: `parseOverrides` is exported and called by nothing under
  `src/cli/` or `src/execution/`. The path
  `~/.config/harness-cli/overrides.json` appears only as a test constant, and
  it is a different directory from the `~/.config/hcn/` the config tiers use.
  So the override file is not a fourth tier and is not documented as outside
  the chain either - `README.md:221` describes `parseOverrides` as a library
  call without naming a path or relating it to precedence.
- evidence: `grep -rl "overrides.json" dist/` returns nothing;
  `test/knowledge/overrides.test.ts:5`; `README.md:221`; no mention in
  `AGENTS.md` or the hcn skill.
- smallest change: add one line under README's "Defaults, config,
  provenance" saying `parseOverrides` is a library-only descriptor patch with
  no file the CLI reads, so the chain is exactly the four tiers shown.
- cross-family review: not reviewed

### F-67 `test/execution/question.test.ts:15,51`

- dimensions: D8 (F-D8-5)
- question: Q1
- severity: note
- coverage: `no_recorded_issue`
- failing scenario: the `streamTurn` question tests instantiate `claudeCode`
  only, so "question event before done awaiting-input" has an offline
  regression test for one harness. For codex, pi and muse the contract is
  proven only by the probe fixtures and the live `question-roundtrip` run. A
  decode change that stopped emitting a final assistant `message` event for
  one harness would silently disarm detection there
  (`stream-turn.ts:367-369` keys on `kind === "message"`) and no offline test
  would catch it.
- evidence: every `streamTurn` case in the file uses the claude descriptor;
  the fixture census shows each harness currently ends with exactly one
  `message` event.
- smallest change: parameterize the "final-message block becomes a question
  event" test over the four descriptors, replaying each
  `ask-<harness>.ndjson` shape through `streamTurn` fakes.
- cross-family review: not reviewed

### F-68 `src/execution/decode.ts:68`

- also `src/interpretation/identity.ts:70-76`
- dimensions: raised by the cross-family review; verified by the synthesis
  agent (no dimension agent filed it)
- question: Q1+Q2
- severity: major
- coverage: `no_recorded_issue` on both files (D4 coverage batch, generation
  2026-08-21T03:32:49Z)
- failing scenario: a consumer resumes id A and the harness binds a different
  id B. `decodeIdentity` returns `outcome: "rotated"` with `identity: null`
  (`identity.ts:75`), so `decodeParsed` emits no `identity` event for the turn
  and pushes `{kind:"error", message:"identity rotated"}` instead - a message
  that names neither id. No `FailureSummary` is pushed, so at exit 0 the turn
  ends `cause:"clean"` with `failure` undefined, and `README.md`'s rule is to
  treat `error` as informational and wait for `done`. The consumer therefore
  records a clean turn, never learns id B (it lives only in
  `state.lastSeenId`), and resumes id A again on the next turn - looping on a
  session it no longer holds. This is the sibling of F-23: F-23 covers the
  harness announcing the requested id for a session that does not exist;
  this covers the harness announcing a different one.
- evidence: synthesis reads of `src/interpretation/identity.ts:70-76`
  (`return { sessionId: announced, identity: null, outcome: "rotated" }`) and
  `src/execution/decode.ts:59-73` (the `identity` event is pushed only when
  `decoded.identity !== null`; the `else if` at `:68` pushes the bare error).
  `grep -rn "rotated" src/execution/` returns `decode.ts:68` and
  `open-session.ts:348` only - the session path builds a message naming both
  ids, the turn path does not, and neither pushes a failure.
- smallest change: in `src/execution/decode.ts`, put both ids in the rotated
  message and push `failureFromRejected` (or a dedicated non-retryable
  summary) beside the `error`, so the turn cannot end `clean`; or emit an
  `identity` event carrying id B with a `rotated` marker so the consumer can
  rebind.
- cross-family review: raised by the review; verified and filed by synthesis

## Review disposition

The cross-family reviewer was `muse-spark-1.2-contributor` run through
`hcn run muse` (`SCRATCH/audit/review.md`). The registry warned at selection
that no candidate meets the high-stakes minimums for code-review, so the
review's reasons were weighed, not its authority. It examined the three
blockers and the twenty-three majors and skipped the minors and notes, which
carry `cross-family review: not reviewed`.

Tally: 23 upheld, 0 refuted, 6 downgrades proposed - 2 applied as asked, 1
applied one level less than asked, 3 rejected. One new finding raised (F-68).

Findings keep the numbers they had in the draft, because the review and the
verdicts reference them. Four severities changed after the ranking, so
F-18, F-19 and F-22 now sit among the majors while reading `minor`, and F-68
is a major appended after the notes.

Downgrades applied:

- F-19 `src/execution/stream-turn.ts:318-335` - major to minor. Accepted. No
  test sets `turnTimeoutMs`, but no wrong behavior was observed; an untested
  path is not the exit-code contract, the NDJSON contract, the resume path,
  or a failure class a consumer branches on, so it is off the readiness path.
- F-22 `scripts/check-versions.ts:56-66` - major to minor. Accepted. The
  detector's blind spot is real (F-58 is the drift it cannot see) but it has
  produced no wrong output a consumer reads.
- F-18 `scripts/smoke-claude.ts:124` - major to **minor**, not the `note` the
  reviewer asked for. The defect is in a dev script and no consumer owns a
  workaround, which takes it off major; but the assertion has to be fixed and
  the claude lifecycle gate has been red unobserved, so it is not the
  no-action observation `note` means.

Downgrades rejected:

- F-14 `~/.agents/skills/choose-model/SKILL.md:114` - kept at major. The
  reviewer's reason (a library import is outside a CLI-only gate) is the
  charter's own reason for keeping this one library check in scope: section 1
  names the choose-model example as the single place a library import is
  still checked, and the D12 rubric says "choose-model example unrunnable ->
  major for Q1". A Q1 consumer copying the documented delegation example gets
  TS2307 and must rewrite it - a workaround it owns, which is major.
- F-20 `test/fixtures/` - kept at major. The rejection rests on evidence the
  reviewer did not weigh: F-08 (claude emits 9 to 20 `progress` events before
  `identity`) is recorded in `test/fixtures/phase0/bare-claude.ndjson`, one of
  the 21 fixtures no test reads. A defect already escaped through this exact
  gap, so it is not a latent coverage concern.
- F-21 `test/interpretation/limits.test.ts` - kept at major. Same test: F-02,
  a blocker, is the `429` matcher entry that `SCRATCH/audit/d5/scan.ts` shows
  has no fixture and no test asserting its class. The absent evidence is what
  let the blocker ship, and the consumer's only workaround is to distrust the
  whole failure taxonomy it branches on.

Missing findings the reviewer proposed:

- Resume rotation swallowing `failure` (`identity.ts:65`): genuinely new.
  Verified at `identity.ts:70-76` and `decode.ts:59-73` and filed as F-68.
- Unref'd SIGTERM grace timer (`run.ts:432`): duplicate. F-27 already carries
  it, from D1 (F-D1-3), with the measured 5.011 s from
  `SCRATCH/audit/d1-kill.sh`.
- Stale `verifiedAgainst` versus installed (`codex.ts:13`,
  `claude-code.ts`): duplicate. F-58 carries the drift itself (from D10
  F-D10-5 and F-D10-8) and F-22 carries the detector that cannot see it.

## Pre-observed resolution

- H1 `src/execution/deps.ts:58,61`: confirmed as fact, no finding.
  `stallMs?` and `log?` are optional at `53c400a` (D1, D6 read
  `deps.ts:57-60`). The lucid-v2 attribution was a cascade from TS2307, and
  the CLI decision retires the library path.
- H2 (0.3.0 directory copy in lucid-v2 `node_modules` on `pro`): not
  examined. Context only after the CLI decision; the charter forbids
  touching `~/dev/lucid-v2`.
- H3 README failure-class and retryable drift: confirmed (F-13).
- H4 `limit.code` typed `string`, `context` shape, added kinds: confirmed
  (F-29, F-28, F-13).
- H5 `SessionHandle` has no `interrupt`, `send` is queued: confirmed, not a
  defect; documentation gap filed as F-65.
- H6 pi has a `sessionMode` while README says Claude-only: confirmed (F-30).
- H7 descriptor freshness: confirmed with one correction (F-58, F-22). codex
  npm latest is 0.149.0, not 0.147.0, so codex is behind npm and ahead of
  installed at once.
- H8 fixture loading: confirmed and extended (F-20). 21 of 40 fixtures are
  read by no test.
- H9 exit codes: confirmed with two corrections (F-51, F-01). `run.ts` never
  calls `exitCodeForCause`; the `rejected` path is unreachable from
  `hcn run`; and one input class - a malformed `--resume` id - exits 1 with a
  stack trace instead of 2.
- H10 `test/execution-layering.test.ts` scope: confirmed (F-42).
- H11 gate regex bypasses: confirmed and widened (F-41). `import fs from
  "fs"`, `crypto.randomUUID()`, `new Date().getTime()` and `Bun.env` also
  pass.
- H12 lucid-v2 has no `question` or `awaiting-input` arm: confirmed as fact,
  refuted as a wedge. `lucid-v2/src/protocol/events.ts:51` classes an unknown
  kind as lossless and `lucid-v2/test/protocol/events.test.ts:21,26` pins it
  for `"brand-new-kind"`. The cost is that `failure` fires lucid's drift
  probe on every failing turn and `question` reaches no escalation path, and
  the normalizer states no additive-kind policy (F-13).
- H13 README flag table gaps: confirmed (F-31). `RUN_HELP` does carry
  `--timeout`, `--escalate-questions` and `--no-escalate-questions`; it omits
  `--skills` and `--session-id`.
- H14 `zai/glm-5.2` as model or provider: confirmed and resolved (F-37). It
  is a `--model` value; choose-model's `selectedModel` path is right and
  `README.md:41` is wrong. Both spellings are accepted with no refusal.
- H15 `smoke-seven.ts` has no harness filter: confirmed by reading
  `scripts/smoke-seven.ts:1-40`. Refuted for `scripts/e2e.ts`, which parses
  `--only` and `--harness` at `:920-921` and matched one scenario per run.
- H16 `src/cli/session.ts` coverage: confirmed. The synthesis coverage call
  returns `partial` (`parse_partial`, 1-240); D7 and D8 read the whole file
  directly and every session.ts claim rests on that read.
- H17 permitted commands leave the tree clean: confirmed. Every dimension
  reports `git status --short` as `?? 1`.
- H18 `check-claims.sh` scope: confirmed (F-64).

## Spend

`SCRATCH/audit/spend.md` (live harness runs, 13 lines, 20 turns, no limit
wall, no retry):

```
time | dimension | command | harness | model | turns | exit | evidence
2026-08-21T04:15:12Z | D11 | node dist/cli.js run claude --json --prompt "Reply with only: alpha" | claude | default | 1 | 0 | audit/live/claude.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run codex --json --prompt "Reply with only: alpha" | codex | default | 1 | 0 | audit/live/codex.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run pi --json --prompt "Reply with only: alpha" | pi | default | 1 | 0 | audit/live/pi.ndjson
2026-08-21T04:15:12Z | D11 | node dist/cli.js run muse --json --prompt "Reply with only: alpha" | muse | default | 1 | 0 | audit/live/muse.ndjson
2026-08-21T04:15:49Z | D11 | perl timeout 120 node dist/cli.js run pi --json --prompt "Reply with only: alpha" (backgrounded, no stdin redirect) | pi | default | 1 | 0 | audit/live/pi-bg.ndjson
2026-08-21T04:14:55Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness claude | claude | default | 2 | 0 | SCRATCH/audit/live/e2e-claude.json
2026-08-21T04:15:55Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness codex | codex | default | 2 | 0 | SCRATCH/audit/live/e2e-codex.json
2026-08-21T04:16:23Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness pi | pi | default | 2 | 0 | SCRATCH/audit/live/e2e-pi.json
2026-08-21T04:17:13Z | D8 | bun scripts/e2e.ts --only question-roundtrip --harness muse | muse | default | 2 | 0 | SCRATCH/audit/live/e2e-muse.json
2026-08-21T04:14:52Z | D6 | bun scripts/smoke-claude.ts | claude | sonnet (scenario 1) + default | 5 | 1 | SCRATCH/audit/live/smoke-claude.json
2026-08-21T04:17:31Z | D1 | node dist/cli.js run claude --json --prompt "Count slowly from 1 to 40, one number per line" (SIGTERM at first token) | claude | default | 1 | 1 | audit/live/kill-1.ndjson
2026-08-21T04:18:55Z | D1 | node dist/cli.js run claude --json --resume aa0b85d6-cdbf-457a-baca-fc0360437e8e --prompt "Reply with only the last number you reached" | claude | default | 1 | 0 | audit/live/kill-2.ndjson
2026-08-21T04:14:54Z | D7 | bun scripts/e2e.ts --only session-live-ask --harness claude | claude | default | unknown (scenario-internal, <=4 session turns) | 0 | SCRATCH/audit/live/e2e-session-live-ask.stdout
```

Two non-zero exits are findings, not limit walls: D6 exit 1 is F-18, D1 exit
1 is the deliberate SIGTERM (F-05). The synthesis agent added no live run;
its own probes (`run claude --json --resume "../../etc/passwd"`,
`run codex --json --provider zai/glm-5.2`) refuse before spawn and spend no
quota.

`SCRATCH/audit/wrappers.md` (delegation, metered on its own account):

```
time | stage | label | command | harness | model | done.cause | failure.class | sessionId
2026-08-21T04:20:00Z | stage1 | muse-spark:D12-doc-truth | hcn run muse --json --effort high --max-steps 40 --no-write --no-escalate-questions --cwd SCRATCH/audit --prompt-file SCRATCH/audit/D12-brief.md | muse | muse-spark-1.2-contributor | clean | - | fddc06e9-c915-4e0a-9c59-ef4c3926413f
```

## Verdicts

Both verdicts are re-confirmed after the cross-family review. The review
upheld all three blockers at their cited lines, refuted nothing, and proposed
no change that touches a blocker. The four severity changes and the one added
finding move no blocker and open no path that was closed.

### Q1 - delegated subagent tasks through `hcn` (CLI surface)

**not ready.**

Blockers: F-02, F-03, F-01.

- F-02 fabricates a `rate-limit` failure from any stderr line containing
  `429` and suppresses the real classification of a genuine failure on the
  same turn. A wrapper agent branches on `failure.class` and `retryable`; it
  cannot tell a fabricated wall from a real one, so no consumer-side
  workaround exists.
- F-03 means a refused invocation writes zero bytes to stdout under `--json`.
  The hcn skill promises structured refusals and tells the agent never to
  parse prose; today the only signal is prose on stderr.
- F-01 means a malformed `--resume` id exits 1 with a stack trace and no
  events. A wrapper resuming an id read from a crashed transcript gets a
  failure exit it cannot classify.

Workarounds the consumer would own even after the blockers are fixed:

- Treat `class: "native"` with `nativeExitCode: 127` as "binary missing,
  keep walking the fallback chain" until F-04 lands, or run `hcn check`
  before routing.
- Never send `--no-tools` on pi expecting containment, and never pass
  lowercase tool names to claude: F-12 re-enables the whole built-in set and
  F-11 silently muzzles the worker, both at exit 0. Pass per-harness tool
  names and verify the rendered argv with `hcn inspect --argv`.
- Read `failure.retryable` from the event, never the class list in
  `README.md` or the delegate skill (F-13); do not expect `resetsAt` on any
  wall except claude's structured `rate_limit_event` (F-10).
- Do not trust `hcn inspect` as a preview of a resume (F-15) or of `--skills`
  (F-16); it diverges from `hcn run` on both.
- Bound the wait on an escalated question and cap ask cycles: hcn arms no
  answer timer (F-17) and validates no answer (F-33).
- Pass `--timeout` on every backgrounded run; the CLI arms no default stall
  budget (F-57).
- Drive `hcn` through the CLI, not the package root: the choose-model example
  does not compile (F-14).
- Treat a turn that carries no `identity` event as a lost session rather than
  a clean one: a rotated resume id emits an `error` naming neither id, no
  `failure`, and a `clean` done (F-68).

### Q2 - lucid-v2 through the CLI, one `hcn run --json` process per turn

**not ready.**

Blockers: F-01, F-03, F-02.

- F-01 is the sharpest for lucid: a bad resume id produces no `done` event at
  all, so a reducer awaiting the turn it started waits forever, and the
  process exit is 1 with a stack trace on stderr.
- F-03 leaves lucid's per-turn stdout reader with an empty stream on every
  refused turn - no `failure`, no `done`, nothing to reduce.
- F-02 corrupts limit propagation, which Q2 names explicitly: a turn that hit
  no wall can report `cause: "limit"` with a retryable `rate-limit` summary.

Workarounds the consumer would own even after the blockers are fixed:

- Validate session ids against `^[A-Za-z0-9][A-Za-z0-9._:@-]*$` before
  resuming, and only resume ids seen in an `identity` event this session -
  pi and muse silently create a blank session for a stale id (F-23), and a
  harness that binds a different id ends the turn `clean` with no `identity`
  event at all, so the new id is unrecoverable from the stream (F-68).
- Scan for `identity` rather than reading NDJSON line 1: claude leads with
  `progress` events when the operator has `SessionStart` hooks (F-08).
- Ignore `identity.capabilities` on a default turn; it reports
  `streaming: "none"` and `session: false` on every harness (F-09). Take
  streaming from the descriptor or from the events that arrive.
- Track that it sent SIGTERM: a deliberate kill arrives as `cause: "crash"`
  with a retryable `transport` failure (F-05), and `hcn` will not exit for 5 s
  (F-27).
- Add an arm for `failure` and `question` kinds and the `awaiting-input`
  cause; lucid has none today, and the normalizer states no additive-kind
  policy (F-13, H12).
- Capture stderr as a second channel per turn if it wants provenance (F-50).
- Branch on `done.cause === "limit"` as well as `done.failure`; a wall on a
  plain stdout line sets the cause and no summary (F-06). A terminal error
  with a clean exit sets neither (F-07).

## Gaps

- No live session capture exists for any harness except D7's one
  `session-live-ask` run on claude. pi rpc session mode has no live evidence
  at all; the identity-probe path is source-read only. F-24, F-25, F-26 and
  F-62 are judged from source and unit tests. Session mode is outside the
  gate, so this does not change either verdict.
- The live pi exit code for the `pi-autherror` condition is unproven (F-07).
  At exit 0 the turn reports `clean`, at exit 1 `transport`. One live pi run
  against that provider condition would settle whether F-07 is a blocker for
  Q1.
- F-07's claude half (`result.is_error: true` in turn mode) is unreproduced.
  It needs one live claude turn that ends `is_error: true`, which is not on
  the permitted-command list.
- F-55 (claude and muse `stdin: "inherit"` under a backgrounded parent) is
  unproven. The permitted pi probe exercises the `close-required` arm only,
  and the charter forbids adding a run for the other.
- D1 criterion 1's second clause ("token lines span more than one second")
  is not decidable from the permitted prompt: `Reply with only: alpha`
  produces one or two token events. Real-time delivery is proven for claude
  (11 events readable while the child ran) and muse (token 1.79 s before
  `done`); pi's margin is 47 ms, consistent with streaming but not proof.
- D1 criterion 3's codex sub-clause (codex's new thread id reported in turn
  2's identity) is unproven: the only permitted codex resume exempts codex
  from the identity check and records no ids (F-45).
- No `timeout` binary exists on this machine; D11's background probe used a
  perl equivalent with GNU exit-124 semantics. The probe exited 0 in 9 s, so
  the emulation was never on the critical path.
- `hcn session` exit codes were not audited beyond the two `no-session-mode`
  refusals; session mode is outside the gate.
- D9's provenance and skills-resolution observations come from refusal-only
  invocations. The ordering of `provenance:` lines relative to `spawn:` on a
  run that actually spawns is inferred from source, not observed.
- `biome.json` and `tsconfig.json` are `not_tracked` by the codebase-memory
  index; D10 read both directly from disk.
- The real-world effect of `-nt` plus `--tools <list>` on pi 0.84.2 (F-12) is
  taken from `pi --help`, not from a live pi turn. The argv hcn builds is
  observed; what pi does with it is not.
- The cross-family review covered the blockers and majors only. The 26 minors
  and 18 notes carry `cross-family review: not reviewed`, so their severities
  rest on one reading each.
- The reviewer ran below the registry's high-stakes bar for code-review, which
  the registry stated at selection. Its reasons were checked line by line
  before being applied or rejected; its authority was not relied on.

## Addendum - observed while fixing the blockers (2026-08-21)

- F-69 `src/execution/failure.ts` / muse step exhaustion. The F-01 fix
  worker on `muse-spark-1.2-contributor` ran past `--max-steps 40`. muse
  reported "model did not reach a terminal state within 40 step(s)" and
  hcn classified the turn `done.cause: "crash"`, `failure.class: "native"`,
  `retryable: false`. The charter's own retry rule, and the README's,
  expect that case as `budget` (raise the cap, retry on the same model).
  `failureFromBudget` has no callers (D5 F-D5-3), so no path can produce
  it. Severity: major for Q1 (a wrapper cannot tell "raise the cap" from
  "the harness broke"). Evidence:
  `SCRATCH/fix/runs/F01-muse.ndjson`, `SCRATCH/fix/runs/wrappers.md`.
  Not cross-family reviewed.

## Fix status (2026-08-21, end of day)

- Blockers F-01, F-02, F-03: fixed, merged in PR #55 (`0c2d873`).
- Majors F-04 through F-26, F-68, F-69 (19 findings): fixed, merged in
  PR #56 (`4aa0a78`). Gate green at 505 tests. Every fix was written by
  `muse-spark-1.2-contributor` through `hcn run muse` in a git worktree,
  then reviewed and tidied by hand before commit.
- Skill documents named in F-13, F-14, F-17 (delegate, choose-model, hcn)
  were updated in their own repositories the same day.
- Minors (26) and notes (18): not addressed. They remain the open backlog
  from this audit.

Both verdicts at `53c400a` stand as recorded above; the next readiness pass
re-measures against the release that carries PR #55 and PR #56.

## Addendum 2 - reported by Kevin after the majors merged (2026-08-21)

- F-70 `src/interpretation/content.ts` (pi reader) / `src/execution/stream-turn.ts`.
  pi against an unreachable local provider (nothing on 127.0.0.1:1234)
  retries three times, ends each attempt with `stopReason: "error"`,
  `errorMessage: "Connection error."`, and exits 0. hcn 0.4.3 ended the
  turn as `timeout` when a `--timeout` was set; current main ends it as
  `task` through the terminal-error rule. Both are non-retryable, so the
  delegate walk stops on a provider that is merely down. Correct class:
  `transport`, retryable. Severity: major for Q1. Evidence:
  `test/fixtures/harnesses/pi-unreachable.ndjson`.
- F-71 `src/knowledge/pi.ts` `authMatchers`. pi with no credentials for
  the requested provider prints `No API key found for <provider>.` on
  stderr and exits 1. No auth matcher recognizes the phrasing, so the
  turn ends `native`, non-retryable. Correct class: `auth`,
  `authKind: "not-logged-in"`, retryable. Severity: major for Q1.
  Evidence: `test/fixtures/harnesses/pi-noauth.ndjson` and
  `pi-noauth.stderr`.
