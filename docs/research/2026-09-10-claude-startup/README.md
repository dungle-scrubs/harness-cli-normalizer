# Research assets

Planning-only evidence for [Keep Lucid artifact startup working across compatible Claude updates](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/146).

Read [operation findings](operations.md) for HCN support and [native-context findings](native-context.md) for Lucid's admission and history responsibilities. Each distinguishes observed, documented, proposed, and unverified claims.

The two `probe-*.mjs` scripts for HCN call unchanged release internals as research test seams. They are not public HCN integrations or product changes. Run them with Bun from this research worktree. `probe-context.mjs` takes `fresh` or a synthetic native session ID, then the probe cwd, then an optional number of repeated synthetic context lines. It names the inspected native binary explicitly. The release source supplies argv rendering, protocol handling, timers and cleanup. `probe-validation.mjs` uses only synthetic protocol frames and no native process.

`probe-lucid-preflight.mjs` runs the current Lucid preparer at the recorded local path with a fake accounting result. It exercises an existing policy, not a live capacity claim. It makes no model call.

The `recordings/` files are real HCN NDJSON from synthetic turns and CLI inspections. The accounting JSON files are selected observations from the research wrapper, not raw fixtures. The SHA-256 pair brackets forked context inspection only. Later native compaction intentionally continued that disposable test session.

For the task recordings, the selected executable was `/Users/kevin/dev/lucid/node_modules/.bin/hcn`, version 0.6.5. The common arguments were `run claude --json --no-extensions --no-skills --questions none --timeout 45`, the synthetic probe cwd, and a native tail of `--tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Resume used the actual fresh identity. The compaction test selected `claude-opus-5`, allowed 90 seconds, and set `--env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` for that process. Missing-session verification selected the same model and allowed 30 seconds. No installation or persistent setting was changed.

No original user conversation, credentials, native transcript contents, hook output or configuration payloads are included. The prompts and marker are synthetic. A live short-turn success, lowered-threshold compaction, and a deterministic fake-budget failure answer different questions; none substitutes for the final Lucid browser regression.

The oversized transport recording uses a generated input exceeding 11 MiB, a 30-second timeout, the explicit model, and the same native tool restrictions. The generated payload is not committed; it consists of a synthetic probe label followed by repeated `x` characters. The result establishes a stdin transport failure, not its precise native cause.
