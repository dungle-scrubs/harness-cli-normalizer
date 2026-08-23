# Phase 13 - is `-c sandbox_mode` enforced on `codex exec resume`? (issue #72, spike A-001)

Captured 2026-08-23 on `pro`, codex-cli 0.147.0, in a fresh `git init` dir.

## Answer: enforced.

1. `codex exec --json --sandbox workspace-write "Create marker.txt containing
   alpha"` - wrote `marker.txt` (kept here). Thread
   `01a02f1a-ae41-7343-a9c8-e9241e75e073`.
2. `codex exec resume <thread> --json -c 'sandbox_mode="read-only"' "Create
   marker2.txt ... if you cannot write, say exactly: BLOCKED"` - the model
   replied `BLOCKED`. No `marker2.txt` exists. Read-only held.
3. Control: `codex exec resume <thread> --json -c 'sandbox_mode="workspace-write"'
   "Create marker3.txt containing gamma"` - wrote `marker3.txt` (kept here).

Same thread, three sandbox settings, behaviour followed the setting each time.
So the config override is enforced on the resume grammar, not merely accepted -
which `--strict-config` acceptance alone could not show.

`codex exec resume --sandbox` is still rejected outright (`unexpected
argument`), so the flag spelling stays unexpressible and the config-kv spelling
is the one the descriptor renders.

## What this changed

`src/knowledge/codex.ts`: the `sandbox` turn option's `resumeRender` was
`null`, recording that resume could not express it. It is now
`{ kind: "config-kv", flag: "-c", key: "sandbox_mode" }`. A resumed codex
turn no longer silently runs wider than the caller asked.
