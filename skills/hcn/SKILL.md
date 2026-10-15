---
name: hcn
description: "Operate hcn, one CLI for multiple coding-agent harnesses such as Claude, Codex, Pi, Muse, Cursor, Antigravity and Popeye: headless runs, live sessions, worker questions and escalation (hcn-question blocks, awaiting-input turns, answering and resuming), native terminal resume, saved transcripts, event streams and invocation refusals."
metadata:
  upstream: https://github.com/dungle-scrubs/harness-cli-normalizer
---

# hcn

hcn is one CLI for multiple coding agents. `hcn run <harness> "prompt"`
launches a harness CLI headless with normalized flags, a ratified defaults
profile, and one NDJSON event stream. `hcn run --help` lists the harnesses
the installed build supports; `hcn ls` lists each with the CLI version its
descriptor was verified against.

**This skill runs the CLI; it never shells out to a harness directly.**
A raw `claude -p` / `codex exec` call forfeits the defaults profile,
provenance, refusal diagnostics, tool floors, and the unified exit-code
contract - everything below exists so the caller does not re-derive it.

## Prerequisites and install check

- hcn installed and on PATH, or `HCN_BIN` set to its path. Installing this
  skill does not install hcn: `npm install -g @dungle-scrubs/harness-cli-normalizer`.
- Node 24 or newer (hcn's `engines` floor), and Bash for the check script.
- macOS or Linux. hcn's documentation and packaged helpers cover only these.
  Windows is not supported; run hcn inside WSL there.
- hcn 0.6.21 or newer is the verified baseline for claude, codex, pi, muse
  and cursor. A harness added later needs a build whose `hcn run --help`
  and `hcn ls` list it. The `hcn ls` version is the descriptor's
  verification anchor, not an exact version requirement.

`<skill-dir>` is the directory that contains this `SKILL.md`. On a new
installation or after an upgrade, run the check from any directory:

```bash
bash "<skill-dir>/scripts/check-claims.sh"
HCN_BIN=/absolute/path/to/hcn bash "<skill-dir>/scripts/check-claims.sh"
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Every check ran and passed. | Use the skill. |
| 1 | A claim mismatch: the CLI disagrees with this skill (`MISS:` lines). | Do not rely on the skill until hcn and the skill match again. Report the `MISS:` lines. |
| 2 | Blocked before any check ran (`blocked:` names the missing Bash, Node or hcn). | Provide it and rerun. This says nothing about the skill's accuracy. |
| 3 | Every check that ran passed; some could not run here. | Use the skill. Only the operations each `blocked:` line names are unverified on this machine. |

The usual exit 3 is `blocked: snapshot checks`. Transcript reads that need a
filesystem clone (the line names the harnesses) will fail the same way here
until `TMPDIR` points at a writable directory on a clone-capable filesystem:
APFS on macOS, or XFS with reflink or btrfs on Linux. Real reads also need
`TMPDIR` on the same filesystem as the native store. Set it and rerun.
Runs, sessions, refusals and the other transcript reads are unaffected. A
shell that reports `bash: command not found` (exit 127) means Bash is
missing: blocked, not a mismatch.

## Safety rules

- Never add `--autonomy` on your own, and never retry automatically to
  clear a native approval or input request. Autonomy grants unattended
  approvals; that is the human's call. Report the failure instead.
- Branch on fields, never on prose: `failure.class`, `done.cause`, and the
  refusal's `hint:` and `supported on:` lines.
- A failure with `retryable: true` (the provider-unavailable family:
  rate-limit, usage-limit, quota, auth, transport, unavailable,
  trust-refused) reached no verdict on the work, so routing it elsewhere is
  safe. A work-verdict class (task, budget) means
  the model answered; rerouting would hide the error.
- A `native` failure is the harness's own error, with `nativeExitCode` as
  data. Never confuse it with an hcn refusal (exit 2).
- An `internal` failure is an hcn bug: non-retryable, exit 4. Report it
  rather than rerouting or retrying.
- Config files hard-fail: an unknown key, malformed JSON, or a version
  mismatch exits 2 naming the offender. Never warn and continue.
- `--resume-last` lets the harness pick the session, so the announced id
  may be a fresh session or another run's. For strict continuation, keep
  the id from the `identity` event and use `--resume <id>`.

## The headless command shape

```bash
hcn run <harness> [flags] "prompt" [ -- <native harness args> ]
```

Read stderr alongside stdout: provenance lines (`provenance: key = value
(tier)`) and divergence reports (`divergence: profile "sandbox" not
expressible on pi`) land there in both render modes, never on stdout.
Defaults resolve through args, project config, user config, the profile,
then the harness. `hcn run --help` restates the profile in its Defaults
section - quote that, not memory.

Headless exit codes: **0** clean (including a turn that ended by asking -
done cause `awaiting-input`), **1** any failure (native, timeout, limit,
transport), **2** hcn refused the invocation itself (structured - the hint
and support list are fields), **4** hcn's own crash: an `internal` failure
plus a `done` pair with cause `crash` reach stdout when `--json` was set.
A dispatch-level usage error with `--json` in argv also writes the
`failure`/terminal pair (exit 2), so a parser never sees an empty stream.

## Reading events

Consume `--json` as NDJSON. For tool outputs, token/cost accounting or
schema parsing, read [the result and usage contract](references/reference.md#tool-results-and-usage).

A clean `done` is not proof of tool success: inspect `tool-result.isError`
and `result` using the native contract. Missing error flags mean unknown.
`warning` is advisory and does not change the turn verdict.
Branch on `failure.class` and `done.cause` using the rules above. Ignore
unrecognized kinds/classes and still wait for `done`.
For nonzero exits and `done.completion`, read [the event schema](references/reference.md).

## Answering worker questions

A headless worker can ask YOUR user when a genuine decision blocks it.
hcn prepends a protocol contract to the prompt (no harness has native
question conveyance), and a worker that must ask ends its turn with a
fenced `hcn-question` block. You receive a typed `question` event (fields
`question`, `options`, `recommended` - render prose FROM them), `done`
arrives with cause `awaiting-input`, and the process exits 0: asking is a
successful turn. A malformed block is not a question: hcn emits an `error`
event and fails the turn with `failure.class: "task"` (non-retryable,
done cause `failed`, exit 1). Wait for `done` before acting on any turn.

1. Read the `question` event's fields; render them through your own
   question tool, or ask in prose when a human is present without that tool.
   Without a human, use the recommended answer only for reversible work
   already within the caller's authority, and record it as machine-made
   wherever the caller's decisions live (the caller's existing decision
   ledger at its known path, when it keeps one), and say where. Shared writes or
   missing authority wait; do not turn a recommendation into permission.
2. Resume with the chosen answer:
   `hcn run <harness> --resume <id> --prompt "<answer>"`. The id came
   from the `identity` event of the asking turn; use that confirmed id
   rather than inferring it from the launch arguments.
3. Pass the user's answer verbatim as the resume prompt. hcn prepends
   the preamble again automatically; never re-compose it yourself.
   There is no answer timer: the asking process has already exited and
   the id stays resumable for as long as the harness keeps the session.
   hcn does not validate the answer against `options`, and a resumed turn
   may ask again; cap the ask cycles you are willing to serve (three is a
   sane default). At that cap, return an unresolved owner action or a
   request for new authority to the caller.
4. `--questions assume` (or config `"questions": "assume"`) flips the
   contract to: never ask, state the assumption, continue. Use it only for
   decisions the caller has already authorized the worker to make
   unattended. No `question` event fires in that mode. `--questions none`
   injects no preamble and disables detection; use it when the caller owns
   the prompt protocol.

Escalation is independent of `--autonomy` by design: autonomy covers
interrupts the harness raises (permission gates), escalation covers
interrupts the model raises (judgment gaps). "Tools free, judgment
supervised" is `--autonomy --questions ask`; fully unattended is
`--autonomy --questions assume`. Never read a question event as a
permission request.

In a live session (`hcn session <harness>`, harnesses listed by
`hcn session --help`), one process serves the whole conversation and a
worker's ask does not exit it. The turn ends `awaiting-input` and the
answer goes in as the next message (`{"op":"answer"}` on the `--json`
machine surface): no exit, no resume. The process waits with no idle
budget of hcn's own; the caller owns any timeout. Take the live channel
when you have it; the run/resume protocol is the cross-harness baseline.

## When a flag refuses

A refusal is a diagnostic that names its remedy. Read the `hint:` line
first - the nearest control on YOUR current harness - then
`supported on:` for the cross-harness list. A native spelling typed before
`--` gets recognized and redirected (`--allowedTools` on codex points back
to `--tools`). Do not switch harnesses on a refusal unless the work
genuinely needs the other harness.

## Output

**Artifact:** one completed harness turn. **Where:** stdout carries the
NDJSON event stream (`--json`) or rendered text; stderr carries the
provenance lines and divergence reports; the exit code carries the
verdict. **Contains:** the events above, ending in `done` with its cause,
and the session id in the `identity` event for resumes. **Not:** any
judgment on the worker's answer, and no conversation state of hcn's own
between runs - session continuity belongs to the harness, reached through
`--resume`, `--resume-last`, or `hcn session`. hcn keeps only a diagnostic
command ledger: every invocation appends a start and an end line to
`hcn/commands.jsonl` under `$HCN_STATE_DIR`, else `$XDG_STATE_HOME`, else
`~/.local/state`. A start with no end is the trace of a killed invocation.

## Load on demand

| Read | Before |
|---|---|
| [references/reference.md](references/reference.md) | Choosing flags, defaults, config, tool grants, skills, memory or context window; parsing the event schema, failure classes or the `hcn session --json` surface; using `--resume-last`; runtime or context inspection. |
| [references/harness-notes.md](references/harness-notes.md) | Relying on one harness's native behavior: Claude model aliases, Pi providers, native approval and input requests, Cursor trust and effort, Antigravity results. |
| [references/transcripts.md](references/transcripts.md) | `hcn transcript ls` or `hcn transcript read`, choosing a native source, or consuming bookmarks. |
| [references/interactive.md](references/interactive.md) | `hcn interactive` (native terminal resume, launch provenance), or inspecting and fingerprint-checking saved native settings. |
| [references/native-approvals.md](references/native-approvals.md) | Permission-preserving headless continuation, or answering a live native approval. |

The installed CLI wins over this skill's copy: verify with
`hcn <cmd> --help` and the descriptor dump `hcn inspect <harness>`.
