# Resume and failures

A caller can distinguish verified resume targets, task/provider failures and native process failure.

## Sub-features

- `guard`: known sessions resume; checkable missing sessions are refused before spawn.
- `uncertain`: an uncheckable create-on-missing resume remains an uncertainty, not proof of failure.
- `transport`: transient native provider messages are retryable without matching ordinary model prose.
- `exit`: distinguish native terminal output from process termination, preserving native diagnostics.

## How to get to it (user POV)

Run `hcn run pi --resume <uuid> --json --prompt <text>` or alias `--session-id`; `--resume-last` is a separate native selection path. Fresh runs expose the same failure and process-exit events. Human output must remain intelligible.

## Driving it with CLI integration tests

Preconditions: current build and disposable native store fixtures only.

- Discover CLI cases with `rg -n 'resume|nonzero|crash|terminated|processing your request' test/cli` and run the matching files via `pnpm exec vitest run <files>` and `bun test --timeout=20000 <files>`.
- Supplement CLI proof with `pnpm exec vitest run test/execution/stream-turn.test.ts test/execution/failure-classes.test.ts test/execution/terminal-error.test.ts test/interpretation/limits.test.ts` and the Bun equivalents.
- Record event ordering, child spawn count, native exit code and selected error line. For completed-work claims require the harness's terminal marker, not merely a text chunk or tool output.
- Re-run new regressions against the pre-fix implementation and retain exact red/green output. Exercise recovered provider errors as well as terminal errors.

## Gotchas

Use the repository's resume/store resolver and environment precedence, never a hardcoded personal store root. A successful process exit alone does not prove a successful turn, and a final-looking text chunk alone does not prove native completion. Do not rerun write work after a transport failure merely to test retryability.
