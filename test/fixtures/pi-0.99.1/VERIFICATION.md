# pi 0.99.1 verification

Captured on pro, 2026-09-30, with `zai/glm-5.2`. `README.md` and
`resume-last.ndjson` are the earlier captures, carried forward unchanged.

```sh
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=/tmp/hcn-smoke-ws/pi SMOKE_CAPTURE_DIR=.smoke/runs/pi-2026-09-30-seven-rerun bun run smoke:seven
SMOKE_HARNESS=pi SMOKE_MODEL=zai/glm-5.2 SMOKE_CWD=/tmp/hcn-smoke-ws/pi SMOKE_CAPTURE_DIR=.smoke/runs/pi-2026-09-30-questions-rerun bun run smoke:questions
```

All seven scenarios pass (`seven.snapshot.json`) and the question probe passed
on its first uncontended attempt (`questions.snapshot.json`). `fresh.ndjson`
is capture 01 of the seven run and `question.ndjson` is capture 01 of the
question run, both native stdout. `escalation.observedOn`:
`{ harness: "pi", model: "zai/glm-5.2", version: "0.99.1", date: "2026-09-30" }`.

Two earlier attempts are recorded and not carried into this directory:
a first seven pass and a first questions attempt that shared one
`SMOKE_CAPTURE_DIR` (`.smoke/runs/pi-2026-09-30`, left in place), where the
questions run - started while a compaction filler read was still streaming,
against the same model - hit the runner's 90 s deadline (`done=killed`, no
question event). Distinct capture directories per suite are what
docs/harness-updates.md asks for; the reruns above follow that. The shared
directory's capture 01 also carries the question run's appended bytes, which
is why the fixtures anchor on the rerun captures instead.

## Compaction: reproduced

`nativeContextManagement` declares auto-compaction on 0.87.0 live evidence
(docs/research/2026-09-22-compaction-signals/pi). The 0.99.1 re-probe
reproduced it, across three configurations:

- Filler: a 522,116-byte synthetic filler (`SYNTHETIC-FILLER-BLOCK-OTTERPOP`,
  5,803 marker lines) read completely into a fresh session through 12 read-tool
  calls under the default settings; 230,031 context tokens confirmed from the
  next turn's usage. Probe workspace `/tmp/hcn-pi-compaction-2026-09-30/` on
  pro (scratch; not committed).
- Config 1 - project `<ws>/.pi/settings.json`
  `{"compaction":{"reserveTokens":950000,"keepRecentTokens":500}}` after
  `git init`, resumed through hcn's own resume grammar
  `pi --session-id <id> -p --mode json` with `--approve`: `compaction_start`
  and `compaction_end`, both `reason:"threshold"`, between the session header
  and `agent_start`; tokensBefore 230,031, estimatedTokensAfter 57,487, full
  payload (summary, firstKeptEntryId, usage, details, aborted/willRetry
  false). Evidence: `compaction-resume-950k.ndjson`.
- Config 2 - user `~/.pi/agent/settings.json` with
  `{"compaction":{"reserveTokens":5000000,"keepRecentTokens":500}}`: no
  compaction. Root cause established: this machine's shell exports
  `PI_CODING_AGENT_DIR=/Users/kevin/.pi`, so pi's global settings resolve to
  `/Users/kevin/.pi/settings.json` (`getAgentDir()` in dist/config.js), and
  the file written to `~/.pi/agent/settings.json` is never read; the default
  reserve (16384) applied, putting the threshold near 983.6k against a 1M
  window, far above the 57k context. The same environment existed for the
  0.87.1 cycle, so this routing explains its user-settings misses. The same
  run verified recall in a later process: asked what the session had read and
  what single-word reply the original instructions demanded, it answered
  `filler.txt` and `DONE` from the compacted summary. Evidence:
  `compaction-recall.ndjson`.
- Config 3 - project settings with `reserveTokens: 5000000` plus
  `--approve`: reproduced again, `reason:"threshold"`, tokensBefore 230,666,
  estimatedTokensAfter 57,689 - the forcing value is not load-bearing; the
  settings route is. Evidence: `compaction-resume-5m.ndjson`.

Both 0.87.1 failure modes now have concrete explanations: the user-settings
route never read the written file (env routing above), and the
project-settings route ignored project resources because non-interactive
modes skip them without a saved trust decision or `--approve`
(docs/settings.md; the 0.87.0 research hit the same gate in its probe A).
The 0.87.1 recipe passed neither.

A fourth run - the user-settings route retried through a private agent dir
(`PI_CODING_AGENT_DIR` override with a symlinked auth store) - was blocked by
this machine's secret-file-gate before spawn; config 3 settles
value-independence, so the route question rests on the env evidence.

Session files carry matching `compaction` entries (summary, firstKeptEntryId,
tokensBefore, details, usage, fromHook, systemMessage), byte-consistent with
the streamed `compaction_end.result` as the 0.87.0 research describes. The
declaration keeps its full-capacity 0.87.0 evidence; this cycle adds live
0.99.1 evidence under lowered thresholds, with the documented limitation that
lowered thresholds exercise the path but do not prove full-capacity behavior
or lossless recall.

## Changelog scan, 0.87.1 -> 0.99.1

npm published only 0.99.0 and 0.99.1 after 0.87.1 (2026-09-29); the
changelog has no 0.88-0.98 sections. Nothing contradicts the descriptor:

- steer/follow_up: unchanged. 0.99.0 adds per-input disposition to successful
  RPC `prompt`/`steer`/`follow_up` responses (additive, #9098/#9803).
- `--continue`/resume: unchanged. 0.99.0 moves session-file creation to the
  first user message (fix #10000); the resume grammar and `onMissing: create`
  semantics are untouched.
- `--mode json`: unchanged. The v3 record grammar is untouched; 0.87.1
  (already the anchor) had made invalid `--mode` values a hard error.
- Extension option probing: unchanged. `--agent` stays extension-registered;
  on this machine the subagent extension is absent and `hcn inspect pi
  --runtime` reports `expressible: false` with the gate refusing pre-spawn
  (0.99.1 binary probed live).
- Native settings: paths and keys unchanged (`getAgentDir()` = env override
  else `~/.pi/agent`; project `<cwd>/.pi/settings.json`; `compaction`
  `reserveTokens`/`keepRecentTokens`/`modelOverrides` - the overrides landed
  in 0.86.0, before the previous anchor).
- Compaction: no changelog change since 0.86.x; docs/compaction.md documents
  the same threshold rule the descriptor declares.
- `--no-extensions` now also disables pi's built-in extensions (0.99.0), and
  built-in extensions are named `builtin:<name>` in diagnostics. The
  descriptor's `-ne` facet still records disable-polarity discovery; the
  flag's reach broadened, its normalized meaning did not.
- MCP and codemode ship as built-in extensions on 0.99.0, opt-in through
  `defaultTools`/`--tools`; not enabled by default, and none of the
  descriptor's builtin tool entries changed (verified against the seven run's
  stream).

## Native behavior observations

- The pi core stream emits no new record classes on 0.99.1. All runs carry
  `custom` records with `customType` `tasks-context` and `tasks-state` from
  the locally installed tasks extension (`~/.pi/extensions/tasks`), which
  publishes machine-local task state into session context - the same noise
  class the 0.87.0 research recorded for `@quintinshaw/pi-dynamic-workflows`.
  The decoder drops them; every scenario passes with them present. One
  consequence observed live: a concurrent session's active task list was
  injected into this probe's headless context, and a compaction summary then
  summarized that injected text alongside the probe's own content.
- Store resolution exercised live on 0.99.1: smoke sessions landed under
  `$PI_CODING_AGENT_DIR/sessions/--private-tmp-hcn-smoke-ws-pi--`, the
  declared root + dash-wrapped slug.
- Transcript reader: reads a real 0.99.1-written session file
  (`validated-prefix`, compatibility `verified`, 10 entries observed,
  exit 0).

## Redaction

Applied per AGENTS.md to every new capture: `message.sections`
`project_context`/`docs`/`skills` and locally-registered (non-pi-builtin)
tool `description` fields replaced with length-naming markers. Verified by
re-serialization: only the marked lines differ from the raw captures, and
config-content probes (instruction-file phrases, skill names, paths,
identities) come back absent. Kept per the rule's letter and prior-cycle
practice: `sections.preamble`/`tools`/`rules`/`cwd`, and non-builtin tools'
`parameters` schemas (third-party package documentation text - Better Stack
MCP, pi-dynamic-workflows - no local paths, identities, or credentials;
probed). The machine-local tasks-context content described above stays
byte-for-byte: it is session metadata, not operator configuration.

## Normalization

None. `verifiedAgainst`, `versionSource` and `escalation.observedOn` moved
together; the only prose change is the descriptor's compaction comment, which
now records this reproduction in place of the 0.87.1 non-reproduction.
