# Router execution options and failure taxonomy - Spike Report

Run 2026-08-13 against the installed CLIs. Two of three assumptions resolved;
the third is blocked on Codex availability and does not gate the plan.

| Code | Result | One-line outcome |
| --- | --- | --- |
| A-001 | **DEFERRED** | Needs live codex inference; Codex at usage limit ~4 days. Shipped refusal path is correct either way |
| A-002 | **PASS** with caveat | claude `--effort` reaches the `-p` path, but claude does not enforce its own ladder |
| A-003 | **PASS** | muse's step-cap reason string is stable and templated; `budget` has a verified producer |

## A-002 - claude `--effort` on a headless turn

**Verified against claude 2.1.229.**

Positive:

```
$ claude -p --effort high --output-format stream-json --verbose --include-partial-messages \
    "reply with the single word ok"
exit=0, stderr empty, normal turn
```

Negative control:

```
$ claude -p --effort bogus "reply with the single word ok"
stderr: Warning: Unknown --effort value 'bogus' — ignoring it and using the
        default effort. Valid values: low, medium, high, xhigh, max.
stdout: ok
exit=0
```

**Findings.**

1. The flag is parsed on the `-p` path - the warning is specific to
   `--effort`, so it reaches the headless code path rather than being an
   interactive-only setting. The declared ladder matches
   `vocabulary.efforts` exactly.
2. **claude does not enforce the ladder.** An unknown value warns and runs the
   turn at *default* effort, exit 0.
3. **The setting is unobservable in the stream.** The `system`/`init` record
   carries `model` (`claude-opus-5[1m]` in the capture) but no effort field;
   `result` carries `usage` / `modelUsage` but no effort. Full init keys:
   `agents, analytics_disabled, apiKeySource, capabilities,
   claude_code_version, cwd, fast_mode_disabled_reason, fast_mode_state,
   mcp_servers, memory_paths, messaging_socket_path, model, output_style,
   permissionMode, plugins, product_feedback_disabled, session_id, skills,
   slash_commands, subtype, terminal_slash_commands, tools, type, uuid`.

**Consequence for the plan.** (2) and (3) together mean a caller has no way to
detect that its requested effort was discarded. `renderTurnOptions` MUST
refuse an out-of-ladder effort rather than pass it through, or a typo produces
a turn that ran at default effort while the router's records claim `xhigh` -
and nothing anywhere contradicts them. <!-- D-043 --> The warning line lands
in `StderrTail`, matches no limit or auth matcher, and classifies as nothing,
which is correct.

**Incidental finding, out of scope.** The init record carries
`claude_code_version` (`2.1.229` in the capture). A runtime version-drift
signal therefore exists in-band for at least one harness, which contradicts
the survey's "version drift is invisible at runtime". Recorded as RFC Open
Question 3 for a follow-up plan, not acted on here.

## A-003 - muse step-cap exhaustion

**Verified against muse 0.1.0**, two runs with different caps.

```
$ muse exec --json --max-model-steps 1 --model muse-spark-1.2-contributor "<multi-step prompt>"
exit=1
payload_type: run.terminal.failed
payload.terminal: "failed"
payload.reason: "model did not reach a terminal state within 1 step(s)"

$ muse exec --json --max-model-steps 2 --model muse-spark-1.2-contributor "<multi-step prompt>"
exit=1
payload.reason: "model did not reach a terminal state within 2 step(s)"
```

**Findings.**

1. The reason string is stable and templated on the cap. The matcher
   `/did not reach a terminal state within \d+ step/i` distinguishes budget
   exhaustion from an ordinary task failure. Open Question 1 resolves to
   option (a). <!-- D-042 -->
2. `payload_type: "run.terminal.failed"` is a more structured discriminator
   than `payload.kind` + `payload.terminal`. The existing reader uses the
   latter and needs no change.
3. **muse exits 1 on step exhaustion**, not 0. The muse descriptor header
   says "muse exec exits 0 even when the work inside failed" - true for task
   failure, false for this. The comment is corrected in M2.

## A-001 - codex resume sandbox enforcement

Not run. Codex is at its usage limit for approximately four days from
2026-08-13 and the experiment requires live inference; grammar acceptance was
already confirmed from `codex exec resume --help` at the RFC stage (`-c
<key=value>` and `--json` both parse in the resume grammar), and only
*enforcement* is open.

**The experiment, for whoever runs it.** Two directions, because one direction
cannot distinguish enforcement from a model that simply declined to write. Run
in a scratch git repo.

1. `codex exec --json --sandbox workspace-write --skip-git-repo-check "create
   a file spike-a001.txt containing OK"` - capture the thread id from the
   `thread.started` record.
2. `codex exec resume <id> --json --skip-git-repo-check -c
   sandbox_mode="read-only" "create a file spike-a001-b.txt containing OK"` -
   assert the write is **refused**, and that the refusal is a sandbox denial
   in the item stream rather than a polite refusal in prose.
3. Inverted: launch with `--sandbox read-only`, resume with `-c
   sandbox_mode="workspace-write"` and the same write prompt - assert the
   write **succeeds**.

**Pass criteria:** both directions behave as the config value dictates. A pass
in only one direction is a FAIL - it means the config is ignored and the
launch value or codex's built-in default is what governed.

The plan ships `resumeRender: null` for codex's `sandbox` spec, so a resume
carrying a sandbox value refuses. That is the safe behavior under either
outcome, so nothing blocks. If A-001 later passes, adding `resumeRender` is a
purely additive commit (M14).
