# Raw `--` passthrough for harness-native flags

A bare `--` splits the hcn command line: everything before it is hcn's normalized surface and refuses unknown flags, everything after it passes verbatim to the harness. The separator itself is never rendered into the harness argv: each descriptor declares where its tail goes (`launch.passthrough` - `after-argv`, `before-prompt`, or `prompt-joins`; absent means `after-argv`). A wrong-harness flag after `--` fails in the harness itself and surfaces as a native error (exit 1), never as an hcn refusal. Descriptor-validated passthrough that would refuse wrong-harness flags before spawn was considered and deferred; the placement needs no new per-flag data.

## Root cause (probes 2026-09-17): the separator was forwarded into the harness argv

`buildSpawnArgv` used to render `[...base, "--", ...tail]`, forwarding hcn's own bare `--` INTO the harness argv. Most CLIs treat `--` as end-of-options, which explains the three behaviors the earlier note recorded: pi and muse folded the tail into the prompt, codex rejected the now-positional tokens as unexpected arguments, and claude dropped them as operands.

Re-probed on launch with the tail rendered WITHOUT the literal `--` (first appended past hcn's own argv, then before the prompt only on failure), using a real flag with an observable effect and `--hcn-bogus-flag`, prompt "Reply with exactly OK", scrubbed env. Appended placement parses on all five harnesses, on launch and resume alike - no harness needed before-prompt, and the earlier `prompt-joins` verdicts (RFC-05 cursor, pi/muse) were the separator's doing, not the harnesses':

- claude 2.1.274: appended `--session-id <uuid>` honored as the session id; bogus rejected natively (unknown option). `after-argv`.
- codex 0.154.0: appended `-c model_reasoning_effort="medium"` accepted (exit 0); bogus rejected natively (unexpected argument). A repeated `--sandbox` errors "cannot be used multiple times" - parsed as a flag, not a positional. `after-argv`.
- pi 0.85.1: appended `--session-id <uuid>` honored; bogus rejected natively. `after-argv`.
- muse 1.3.0: appended `--session-id <uuid>` honored; bogus rejected natively. `after-argv`.
- cursor 2026.09.15-d2fe57e: appended `--model gpt-5-mini` switched the run's model; bogus rejected natively. `after-argv`.

`prompt-joins` stays in the vocabulary (with its before-spawn refusal) for harnesses where no placement parses; none declare it today.
