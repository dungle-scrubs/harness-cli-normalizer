# Phase 9 native-ask probes (issue #75)

Do the harnesses' own question mechanisms surface on a headless stream? The
docs were silent, so this is a live run. Captured 2026-08-23 on `pro`
(claude 2.1.239, codex-cli 0.147.0).

Prompt: `native-probe-prompt.md` - the phase 7 task half only, with **no hcn
preamble**. The point is what each harness does natively.

## Answer: no, on both.

**codex** (`native-codex-readonly.jsonl`, `native-codex-workspace-write.jsonl`)

Run with `tools.experimental_request_user_input={enabled=true}`, which is the
real spelling - `--strict-config` rejects the bare
`experimental_request_user_input_enabled` that earlier desk research reported,
and the key takes a struct (`ExperimentalRequestUserInput { enabled }`), not a
boolean.

codex asked the question. It arrived as an ordinary `item.completed` of type
`agent_message`. Zero `request_user_input` anywhere on the stream. The turn
ended `turn.completed`, exit 0. Both sandbox modes behave identically, so the
read-only default is not the cause - the workspace-write control could have
written the file and did not.

**claude** (`native-claude-stream-json.jsonl`)

`claude -p --output-format stream-json --verbose --permission-mode acceptEdits`.

claude asked the question, in prose, in the `result`. Zero `AskUserQuestion` on
the stream - and the `system/init` event lists 50 tools with `AskUserQuestion`
absent. The tool is not offered in `-p` at all, so this is not a visibility gap
but an availability one.

## What this establishes

Both models correctly recognised an unrecoverable decision and chose to ask
rather than guess, unprompted. The models are willing. What is missing is
structure: the ask is prose in a successful turn, indistinguishable from a
completion, with exit 0 and no distinct cause.

That is the gap hcn's escalation protocol fills, and these captures are the
evidence that it is not duplicating a native mechanism.
