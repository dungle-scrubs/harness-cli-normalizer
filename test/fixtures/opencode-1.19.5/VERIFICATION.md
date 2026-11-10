# OpenCode CLI 1.19.5 fixtures

Captured 2026-11-10 from the installed `opencode` 1.19.5 (npm package
`opencode-ai`) on macOS. Every capture ran in an empty temporary working
directory with `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
`XDG_STATE_HOME` pointed at empty temporary directories, `OPENCODE_API_KEY`
unset, and `--pure` on. No API key was ever set and no account was used: the
model is a free-tier one, so the captures prove the keyless path.

- `version.txt`: `opencode --version` at capture time.
- `tool-use.jsonl`: a turn that reads `note.txt` and answers with its
  content. The stream carries `step_start`, one `tool_use` line (the tool
  and its settled state together), a `step_finish` with reason
  `tool-calls`, then a second `step_start`, the `text` part and a final
  `step_finish` with reason `stop`.
- `resume.jsonl`: the same session continued with `opencode run --session
  <id>`; the `sessionID` on every line is the one the first capture
  minted.
- `missing-session.jsonl` / `.err` / `.exit`: an unknown session id.
  stdout is empty, stderr carries `Error: Session not found`, exit code 1.
  This is a refusal, not a fresh session.
- `bad-model.jsonl` / `.err` / `.exit`: an unknown model. One `error` line
  (`UnknownError`, "Unexpected server error..."), empty stderr, exit code 1.

The absolute paths inside `tool-use.jsonl` are the capture's own temporary
working directory; they are evidence of where the harness ran and are kept
as captured.

## The exact commands

```sh
ROOT=$(mktemp -d /tmp/oc-fixture-XXXXXX)
mkdir -p "$ROOT/work" "$ROOT/data" "$ROOT/config" "$ROOT/cache" "$ROOT/state"
printf 'hello\n' > "$ROOT/work/note.txt"
cd "$ROOT/work"

env -u OPENCODE_API_KEY \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" \
  opencode run --format json --pure -m opencode/big-pickle \
  "Read the file note.txt and reply with only its content." \
  > tool-use.jsonl 2> tool-use.err          # exit code in tool-use.exit

# resume: the session id is the one tool-use.jsonl announced
env -u OPENCODE_API_KEY \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" \
  opencode run --format json --pure -m opencode/big-pickle -s <sessionID> \
  "Reply with only the word resumed." \
  > resume.jsonl 2> resume.err              # exit code in resume.exit

# an unknown session id (no model call)
env -u OPENCODE_API_KEY \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" \
  opencode run --format json --pure -m opencode/big-pickle \
  -s ses_00000000000000000000000000 "hi" \
  > missing-session.jsonl 2> missing-session.err

# an unknown model
env -u OPENCODE_API_KEY \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" \
  opencode run --format json --pure -m opencode/no-such-model-xyz "hi" \
  > bad-model.jsonl 2> bad-model.err
```

## Model choice

The settled spec named `opencode/glm-5.3-flash-free`. These captures use
`opencode/big-pickle`, another free model, because the capturing session read
a model listing that did not include it. That listing matched what opencode
1.17.10 reported earlier the same day, so it was most likely a stale models
cache. A fresh 1.19.5 listing on 2026-11-10 does include
`opencode/glm-5.3-flash-free`. Either way the free roster rotates between
releases, which is why the descriptor carries no model list and the
vocabulary stays extensible.

## Not captured

The free-tier and Go-plan usage walls (`FreeUsageLimitError`,
`GoUsageLimitError`) are not in these captures: provoking them would spend
the free allowance. The matchers that read them come from the 1.19.5
bundle, and the descriptor records that provenance.
