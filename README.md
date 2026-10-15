# harness-cli-normalizer

[![CI](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dungle-scrubs/harness-cli-normalizer/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@dungle-scrubs/harness-cli-normalizer.svg)](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A unified interface across multiple coding agents.

hcn is a command-line tool for scripts and agents that hand work to coding-agent CLIs. hcn calls
each of these CLIs a harness. It currently supports Claude Code, Codex, pi, Muse, Cursor CLI,
Antigravity CLI, and popeye. You choose the harness and model for each task and pass the same
options to any of them. hcn translates the options into that harness's flags and reports the result
as the same JSON events and exit codes. If a harness has no equivalent for an option, hcn exits
without starting it and lists the harnesses that do.

```console
$ hcn inspect claude --argv --access read --context-window 200000 --prompt "find bugs in src/"
...
argv: claude -p --effort medium --autocompact 200000 ... --allowedTools Read,Grep,Glob,WebFetch,WebSearch --disallowedTools Bash,Edit,Write,...

$ hcn inspect codex --argv --access read --context-window 200000 --prompt "find bugs in src/"
...
argv: codex exec --json ... -c model_context_window=200000 --disable memories --sandbox read-only ...

$ hcn inspect pi --argv --access read --context-window 200000 --prompt "find bugs in src/"
pi cannot express option "contextWindow" (200000); supported: effort, provider, ... - drop the option or route this work to a harness that supports it
supported on: claude (--autocompact), codex (-c), popeye (--context-window)
```

`hcn inspect --argv` prints the command hcn would run. `hcn run` takes the same flags and runs it.
To have the harness and model chosen for you, put model-router in front of hcn, as described in
[How the three packages fit](#how-the-three-packages-fit).

## Install

hcn needs Node 24 or newer and at least one harness CLI, installed and signed in. The CLIs are
linked under [Thanks](#thanks). hcn uses each CLI's own login.

```sh
npm install -g @dungle-scrubs/harness-cli-normalizer
```

`hcn ls` lists the harnesses and the CLI version hcn was verified against for each:

```console
$ hcn ls
claude@2.1.296 (npm:@anthropic-ai/claude-code)
codex@0.162.1 (npm:@openai/codex)
pi@1.1.0 (npm:@earendil-works/pi-coding-agent)
muse@1.4.2 (installed:muse)
cursor@2026.10.01-e373342 (installed:agent)
antigravity@1.3.3 (installed:agy)
popeye@0.2.0 (npm:@dungle-scrubs/popeye)
```

To teach your coding agents hcn's flags, events and refusals, install its agent skill:

```sh
npx skills add dungle-scrubs/harness-cli-normalizer --skill hcn -g
```

## Usage

### Run a turn

```console
$ hcn run claude "name three primes, nothing else" --model haiku
provenance: effort = "medium" (profile)
...
divergence: profile "sandbox" not expressible on claude; harness default applies
env: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
spawn: claude -p --effort medium [prompt:969ch] --output-format stream-json --verbose --include-partial-messages --model claude-haiku-5-5
provenance: questions = ask (default)
  ● session d8b139a5-14d4-40dc-852e-3ae87d23b221 (harness-minted)
2, 3, 5
  ○ clean (exit 0)
```

To use another harness, replace `claude` with `codex`, `pi`, `muse`, `cursor`, `antigravity`, or
`popeye` and keep the other flags. hcn checks `--model` and `--effort` against the harness first.
For example, `--model haiku` on codex exits 2 and lists the codex models. The stderr lines show where
each setting came from (`provenance:`), what the harness cannot express (`divergence:`), and the
command hcn ran (`spawn:`). The prompt is longer than what you typed because hcn adds a preamble
that tells the model how to ask you a question. See
[Answer a question from the model](#answer-a-question-from-the-model).

### Limit tools and access

```sh
hcn run codex "find bugs in src/" --access read
hcn run claude "find bugs in src/" --tools read,grep,glob
hcn run claude "find bugs in src/" --context-window 200000
```

`--access read` becomes `--allowedTools` and `--disallowedTools` on Claude Code,
`--sandbox read-only` on Codex, and `--tools` on pi. `--tools` and `--exclude-tools` use the same
tool names on every harness: `read`, `write`, `edit`, `shell`, `grep`, `glob`, `list`, `web-fetch`,
`web-search`, `subagent`, and `skill`. `--skills` limits skills in the same way.

On Cursor, `--access read` selects native ask mode. **Cursor write access is unconfined**:
`--access write` renders `--force`, allowing commands and bypassing workspace trust. It does not
provide a workspace sandbox; native explicit denials still apply.

### Read results as JSON

```console
$ hcn run claude "name three primes, nothing else" --model haiku --json
{"kind":"identity","sessionId":"7e3712eb-76cf-4c00-a72a-ba08ab1f78db","authority":"harness-minted","capabilities":{...}}
...
{"kind":"message","role":"assistant","text":"2, 3, 5"}
{"kind":"done","exitCode":0,"cause":"clean","escalation":{"mode":"ask","detection":"none"}}
```

`--json` prints one JSON event per line. Native tool outputs arrive as `tool-result` events,
including structured extension results and error flags when reported. Native token counts and
cost estimates arrive as scoped `usage` events. A clean `done` does not mean every tool succeeded;
check the tool results. See the [event contract](docs/reference.md#tool-results-and-usage).
The format is the same for every harness, and the last line is always `done`.
On a nonzero run exit, `done.completion` preserves output evidence:
`native-terminal` means the harness reported successful turn completion;
`message-delivered` means assistant text arrived without confirmed turn completion.
The process failure remains in `cause`/`failure`, and `exitCode` keeps the harness's actual status.
If the run failed, `done.failure.retryable` says whether a retry can help,
and `done.failure.class` gives the reason, such as `rate-limit`, `auth`, `transport`, or
`rejected`. A refusal also lists the harnesses that support the option:

```console
$ hcn run pi "find bugs in src/" --context-window 200000 --json
{"kind":"failure","class":"rejected","retryable":false,...,"supportedBy":[{"harness":"claude","spelling":"--autocompact"},{"harness":"codex","spelling":"-c"},{"harness":"popeye","spelling":"--context-window"}]}
{"kind":"done","exitCode":null,"cause":"failed","failure":{...}}
```

### Run a route from model-router

```console
$ model-router '{"task":"code-review","stakes":"normal","privacy":"normal"}' \
    | jq -c '.routes[0] | {harness, modelId, effort}'
{"harness":"pi","modelId":"zai/glm-5.3","effort":"xhigh"}
$ hcn run pi --model zai/glm-5.3 --effort xhigh --access read "review the diff on this branch"
```

A route has a harness, a model id, an effort, and for some routes a provider. Pass them to
`hcn run` as the harness argument, `--model`, `--effort`, and `--provider`. If the run fails with
`retryable: true`, run the next route in `.routes`. The routes come from your registry, so yours
will differ.

### Keep a session open

```console
$ printf '%s\n' '{"op":"send","id":"in-1","text":"name three primes, nothing else"}' \
    | hcn session claude --model haiku --json
{"kind":"session","sessionId":"230f0d30-47d8-49bd-bcfc-ba2c5008776c","harness":"claude","hcn":"0.9.8","questions":"ask","origin":"fresh"}
{"kind":"disposition","id":"in-1","disposition":"started"}
{"kind":"turn","turnId":"230f0d30-47d8-49bd-bcfc-ba2c5008776c:turn-1","id":"in-1"}
...
{"kind":"message","role":"assistant","text":"2, 3, 5"}
{"kind":"done","exitCode":null,"cause":"clean",...}
{"kind":"closed","exitCode":0,"cause":"clean"}
```

With `--json`, you write commands to stdin, one JSON object per line (`send`, `answer`, `close`),
and read events from stdout. Each `send` gets one `disposition` event, and each turn carries the id
of the `send` that started it. Sessions work with Claude Code, Codex, pi, Antigravity CLI, and
popeye. Without `--json`, `hcn session claude` opens an interactive prompt.

### Read saved sessions

```console
$ hcn transcript ls --limit 1
{"schemaVersion":1,"kind":"session-list-source","hcnVersion":"0.9.8","harnesses":["claude","codex","pi","muse","cursor","antigravity","popeye"],...}
{"schemaVersion":1,"kind":"session","harness":"claude","id":"1daeb0ec-1d9c-4461-8e5c-84ca8c6ee3f6",...,"mode":"interactive","readable":true,"blocked":null}
{"schemaVersion":1,"kind":"session-list-result","exitCode":0,"status":"complete","rowsReturned":1,"more":true,...}
$ hcn transcript read claude --id 1daeb0ec-1d9c-4461-8e5c-84ca8c6ee3f6 > transcript.jsonl
```

`hcn transcript ls` lists the saved sessions of every harness for the current directory, newest
first, in one format. `hcn transcript read` exports the messages and tool results of one session
without starting the harness. Support differs by harness; see
[docs/transcripts.md](docs/transcripts.md).

### Answer a question from the model

```console
$ hcn run claude "Add a database to the new service. Postgres or SQLite are both fine and the choice is mine, not yours." --model haiku --access read --json
...
{"kind":"question","question":"Which database should the new service use, ...","options":["SQLite","Postgres"],"recommended":"SQLite"}
{"kind":"done","exitCode":0,"cause":"awaiting-input","escalation":{"mode":"ask","detection":"block"}}
$ hcn run claude --resume 98ba94a4-f51b-49ef-b515-2e2202a4fc0e --prompt "Postgres"
```

By default, hcn's preamble tells the model how to ask a question when it cannot make a decision
itself. The turn then ends with a `question` event and a `done` event with cause `awaiting-input`
(exit 0). Ask your user, then resume the session with the answer, using the `sessionId` from the
`identity` event. With `--questions assume`, the model states its assumption and continues instead.

## Concepts

### How the three packages fit

```text
task ──▶ model-router ──▶ routes, best first ──▶ hcn run <harness> --model <id> --effort <level>
              ▲                                              │
              │                                              └─ retryable failure: next route
       model-registry
```

Together, the three packages route each job to a model and harness automatically, following your
preferences. [model-registry](https://github.com/dungle-scrubs/model-registry) defines the
registry file: the models you can use, the harnesses that reach them, and ratings for each.
[model-router](https://github.com/dungle-scrubs/model-router) reads the registry, takes a task, and
returns routes ranked best first. Each route is a harness, a model, and an effort. hcn runs the
route. If the run fails with `retryable: true`, run the next route.
[popeye](https://github.com/dungle-scrubs/popeye) is a harness built for hcn to drive, and a
registry can list routes through it like any other harness. Each package also works on its own.
hcn runs any harness and model you give it, and model-router ranks routes without running anything.

### Refusal and divergence

If you pass an option the harness cannot express, hcn exits 2 without starting the harness and
lists the harnesses that support the option. If the option comes from hcn's defaults instead of
from you, hcn prints a `divergence:` line to stderr, and the harness uses its own default.

## Reference

### Commands

```text
hcn run <harness> [prompt]     Run one headless turn
hcn session <harness>          Keep one process open across turns (--json for programs)
hcn interactive <harness>      Resume a native session in your terminal, with a control pipe
hcn inspect <harness>          Preview argv, capabilities, runtime, context, or saved settings
hcn transcript ls              List saved native sessions, newest first
hcn transcript read <harness>  Export one saved session as JSONL
hcn ls                         List harnesses and the CLI version each was verified against
hcn check                      Compare those versions with the latest releases
```

`<harness>` is one of `claude`, `codex`, `pi`, `muse`, `cursor` (binary `agent`), `antigravity`
(binary `agy`), or `popeye`. `hcn <command> --help` lists every flag.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The turn finished, including a turn that ends with a question |
| 1 | The harness or the transport failed; `done.failure` says why |
| 2 | Usage error or refusal; the harness did not start |
| 4 | A bug in hcn; a `--json` stream still ends with `failure` and `done` |

### Config

hcn takes each setting from the first source that sets it:

```text
flags > .hcn/config.json (git root) > ~/.config/hcn/config.json > hcn defaults > harness default
```

```json
{ "version": 1, "effort": "high", "access": "read", "toolsets": { "review": ["read", "grep"] } }
```

Keys: `effort`, `model`, `provider`, `sandbox`, `contextWindow`, `tools`, `excludeTools`,
`autonomy`, `write`, `shell`, `memory`, `maxSteps`, `toolsets`, `timeout`, `questions`,
`systemPrompt`, `appendSystemPrompt`, `toolMap`, and `access`.

hcn's defaults are effort `medium`, autonomy off, memory off, and discovery on. Codex and
Antigravity CLI also get sandbox `workspace-write`, and Codex and popeye get a 272,000-token context
window. In a project config, `tools` also caps what `--tools` can grant, and a request for more
exits 2. An unknown key or invalid JSON exits 2 with the problem in the message.

### Security

- hcn stores no credentials. Each harness signs in with your own account.
- hcn masks secret-like strings from harness stderr in failure messages: `sk-` keys and `token=`,
  `key=`, `secret=`, and `password=` pairs.
- Each invocation appends a start line and an end line to `hcn/commands.jsonl` under
  `$HCN_STATE_DIR`, `$XDG_STATE_HOME`, or `~/.local/state`.
- If `HCN_OBSERVER` is set to an executable, `hcn run` sends its events to that program's stdin.
  See [docs/observer.md](docs/observer.md). If it is not set, hcn sends nothing.

[docs/reference.md](docs/reference.md) has the full flag table, the tool names for each harness, the
event and failure fields, the session protocol, and the native-session commands (terminal resume,
Codex approvals, and saved settings).

## Contributing

You need Node 24 or newer, pnpm, and Bun.

```sh
pnpm install
pnpm check                 # lint, typecheck, build, vitest, bun test, skill check, package check
bun run demo claude "hi"   # run a harness and print its event stream
```

Do not break the layer rules that `test/interpretation/purity.test.ts` and
`test/no-chat-imports.test.ts` enforce, and do not edit `test/fixtures/`. Commits follow
Conventional Commits. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest, and
[docs/harness-updates.md](docs/harness-updates.md) for how to verify a harness against a new CLI
version.

## Status

hcn is pre-1.0. It is not a harness and does not run a model itself. It adds a layer between your
program and the harness, so if you use only one CLI, you may prefer to call that CLI directly.
[ROADMAP.md](ROADMAP.md) lists planned work, including new harnesses. Support differs by harness:

- Sessions work with Claude Code, Codex, pi, Antigravity CLI, and popeye. Muse and Cursor CLI run
  single turns only.
- `hcn interactive` supports Codex only.
- `--native-approvals` supports Codex only. Saved-settings inspection supports Codex and pi.
- The weekly version check in CI covers the harnesses published to npm. Muse, Cursor CLI, and
  Antigravity CLI are checked locally with their own version commands.

## Thanks

hcn runs these CLIs: [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code),
[Codex](https://www.npmjs.com/package/@openai/codex),
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), Muse (installed from source,
not on a registry), Cursor CLI (installed via script, binary `agent`, not on a registry),
[Antigravity CLI](https://antigravity.google/docs/cli/), and
[popeye](https://www.npmjs.com/package/@dungle-scrubs/popeye).

## License

MIT. See [LICENSE](LICENSE).
