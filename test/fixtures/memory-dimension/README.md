# Memory-dimension probes (live evidence)

Truthfulness-rule discharge for the `memory` turn option (ratified
2026-08-26): every descriptor fact about harness persistent memory and
its off switch, verified against the installed CLIs on 2026-08-26.
Fixtures are evidence, not a test suite - they need credentials and
live CLIs, so they stay out of CI.

Re-capture: `sh capture.sh` (claude facts), plus the codex/muse/pi
probes recorded below in PROBES.md.

## What is proven here

1. **claude 2.1.241** - `init.memory_paths` present on a bare run
   (`claude-bare-init.ndjson`), absent under
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`claude-disabled-init.ndjson`),
   and PRESENT under `=false` (`claude-false-init.ndjson`) - the var is
   boolean-parsed, so `1` is the unambiguous disable spelling.
2. **hcn wiring (same machine, same day)** - `ps eww` on spawned
   children:
   - one-shot `hcn run claude`: child env carries
     `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`hcn-run-spawn-env.txt`).
   - `hcn session claude --json`: session child env carries it too
     (`hcn-session-spawn-env.txt`).
   - `hcn run codex`: spawn line carries `--disable memories`
     (`codex-exec-disable-memories.txt`).
   - `hcn run pi`: spawn line is byte-identical to a memory-less bare
     run - pi has no built-in memory, the render is vacuous
     (`pi-run-spawn.txt`).
3. **codex 0.149.1** - `codex features list` shows `memories: stable,
   true` (`codex-features.txt`); `--disable memories` accepted on
   launch AND resume grammars (`codex-exec-disable-memories.txt`,
   `codex-resume-disable-memories.txt`, both exit 0 with model reply).
4. **muse 0.2.1** - no memory disable flag in `--help`, no settings
   key, memory data dir exists (`muse-absence-probes.txt`). The
   descriptor's MEMORY GAP comment cites this file.
5. **pi 0.84.3** - no built-in memory capability; `session_recall`
   observed on this machine is a user extension
   (`~/.pi/extensions/session-memory`), not a pi feature
   (`pi-absence-probes.txt`).

Descriptor comments cite this directory; the version evidence lives
with the facts, not in `verifiedAgainst` (which tracks the full
re-verification pipeline).
