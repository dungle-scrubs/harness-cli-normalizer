# Verifying a harness update

This procedure applies to Claude Code, Codex, pi, and Muse. `verifiedAgainst`
records evidence; it does not reject a working invocation when a version changes.
Native operation failures remain authoritative. Never switch the selected model,
truncate the request, or replay it automatically to conceal an incompatibility.

## Detect and reproduce

Run `bun run check:versions` on the machine with the updated harness installed.
The weekly CI check covers published npm versions; Muse requires the local check.
Confirm the executable selected by `hcn inspect <harness> --runtime`, including
the caller's cwd, model, effort, mode, and resume choice. Preserve those choices
in the reproduction. Use a disposable workspace and synthetic sessions.

An update is a verification trigger, not proof of incompatibility. If a native
operation fails, retain its output and identify the changed interface before
editing a descriptor. An unchanged version is not proof that an operation works.

## Re-verify the declared contracts

Run both live suites with `SMOKE_HARNESS`, `SMOKE_MODEL`, `SMOKE_CWD`, and distinct
`SMOKE_CAPTURE_DIR` directories: `bun run smoke:seven` and
`bun run smoke:questions`. Keep `.smoke/seven.json`, `.smoke/questions.json`, and
the native recordings. These cover launch, output, tools, supported persistent
mode, resume recall, interruption, native failure, and escalation.

Also test each context contract the descriptor declares:

| Contract | Required live evidence |
|---|---|
| Native accounting | Full staged prompt and native history on a disposable resume fork; observed model and input limit; no assistant execution; malformed/failed operations remain unavailable. |
| Native compaction | Automatic trigger, successful replacement installation, and recall in a later process. Record the strategy, threshold overrides, and failure outcome. A short successful turn or manual compact acknowledgement is insufficient. |
| No context declaration | Accounting remains unavailable. Investigate new official interfaces before adding a declaration; historical usage and model-window size are not pending-prompt accounting. |

Lowered thresholds can exercise the compaction path. State that limitation;
they do not prove full-capacity behavior or lossless recall. Compaction failure
and oversized incoming content must preserve the native failure. Context
declarations are curated capabilities, not observations of the user's settings.

Completion requires passing applicable probes, an explanation for each skip,
and captured evidence consumed by regression tests. A skipped required probe is
not a verified capability. Failed verification keeps the previous evidence
anchor; it does not impose a blanket version refusal on unrelated operations.

## Update and consume

After verification, update `verifiedAgainst`, `versionSource`, and
`escalation.observedOn` together from the observations. Capture new fixtures;
preserve previous recordings. Change interface descriptions only where evidence
shows changed behavior. Run `pnpm check` and audit the HCN skill and its claim
checks. CI must keep proving that older, newer, and unavailable version metadata
do not reject supported invocations, while unsupported modes/options, missing
executables, malformed accounting, and native failures remain failures.

A compatible installed harness works without waiting for this metadata refresh
to be published. A required HCN correction follows the normal release workflow.
Consumers such as Lucid update their exact HCN package pin, recapture fixtures,
and verify the selected executable and actual operations. Version comparisons,
harness capability tables, and automatic model substitution do not belong in
the consumer. Saved or uncertain user work requires its existing dispatch and
recovery authorization; maintenance probes do not execute it.
