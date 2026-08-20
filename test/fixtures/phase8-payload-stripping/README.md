# Phase 8 payload-stripping probes (issue #48)

Live evidence for the ratified design (2026-08-20 sitting), all probed on
Kevins-MacBook-Air.

## codex `instructions` accepts literal AND path (design question 5)

- `codex-instructions-literal.ndjson`: `-c instructions="You are a
  counter. You must reply with exactly: LITERAL-OK"` under
  `--strict-config` + `--skip-git-repo-check` -> reply `LITERAL-OK`.
- `codex-instructions-file.ndjson`: `-c instructions=/tmp/nake-probe/sys.txt`
  (file containing the FILE-OK instruction) -> reply `FILE-OK`.
- Both wrong spellings refused by --strict-config (earlier probe):
  `model_instructions`, `experimental_instructions_file`.
- Render decision: config-kv VERBATIM (no TOML quoting) - both forms
  passed unquoted.

## claude / pi replacement changes behavior (e2e bar)

- claude `-p --system-prompt "You are a haiku machine..." 
  --exclude-dynamic-system-prompt-sections "say something"` -> `NAKED-HAIKU`
  (vs `BASELINE-OK` on a bare baseline run).
- pi `-p --system-prompt "You must reply with exactly: PI-NAKED"` ->
  `PI-NAKED`.

## claude --bare boundary (documented, not probed end to end)

`--bare` refuses to run under OAuth login ("Not logged in" - it never
reads OAuth/keychain) and requires ANTHROPIC_API_KEY or an apiKeyHelper
via --settings; the live behavioral probe was not possible without real
API-key auth on this machine. Ratified consequence: no --bare composite;
hcn does not surface it beyond the hint-table boundary note (strips
chrome - hooks, LSP, plugin sync, memory, keychain, CLAUDE.md - but does
NOT replace the system prompt; auth is API-key only).
