export const TOP_LEVEL_HELP = `hcn - One stable interface to four coding-agent CLIs

Usage: hcn <command> [options] [prompt]

Commands:
  run <harness> [prompt]    One-shot headless turn (streamTurn)
  session <harness>         Interactive session (openSession, Claude-only)
  inspect <harness>         Descriptor / argv / capability inspection (no spawn)
  ls                        List harnesses with verifiedAgainst versions
  check                     Drift check (published version vs verifiedAgainst)

Options:
  -h, --help                Show help
  -V, --version             Show version

Run 'hcn <command> --help' for command-specific help.
`;

export const RUN_HELP = `hcn run - One-shot headless turn

Usage: hcn run <harness> [prompt] [options]

Arguments:
  <harness>                 claude | codex | pi | muse
  [prompt]                  Prompt text (positional). Must not start with '-'.
                            Use --prompt or --prompt-file for leading '-' or multi-line.

Options:
  --prompt <text>           Prompt text (alternative to positional)
  --prompt-file <path|->    Read prompt from file, or stdin when '-'
  --model <id>              Model id (validated per harness)
  --effort <value>          Effort level (validated per harness/model)
  --sandbox <value>         Sandbox mode (codex only)
  --provider <value>        Provider (pi only)
  --tools <a,b>             Tool grant allowlist (claude, pi; a bare name
                            matching a configured toolset expands to it)
  --exclude-tools <a,b>     Complement over known tools (claude, pi;
                            mutually exclusive with --tools)
  --autonomy                Enable autonomy flag (claude/codex/muse)
  --no-autonomy             Disable autonomy
  --write                   Enable write (muse)
  --no-write                Disable write
  --shell                   Enable shell (muse)
  --no-shell                Disable shell
  --escalate-questions      Let the worker ask the caller's user when a
                            genuine decision blocks progress (DEFAULT;
                            prompt-preamble transport, question event +
                            done cause "awaiting-input", exit 0)
  --no-escalate-questions   Worker never asks: it states the assumption it
                            proceeded under and continues
  --max-steps <n>           Max steps (muse, 1-10000)
  --timeout <seconds>       Wall-clock budget for the run (all harnesses,
                            hcn-enforced; 0 disables; no default)
  --no-tools                Disable tools discovery facet
  --no-instruction-files    Disable instructionFiles discovery facet
  --no-extensions           Disable extensions discovery facet
  --no-skills               Disable skills discovery facet
  --cwd <path>              Working directory for spawn
  --env KEY=VAL             Environment (repeatable; KEY= deletes)
  --resume <uuid>           Resume session id (UUID). The answer path for
                            question escalation: resume with the chosen
                            answer as the prompt; id continuity per
                            harness (claude stable, pi/muse caller-assigned,
                            codex minted via identity event)
  --                        Passthrough: native harness args verbatim
                            (failures surface as labeled native errors)
  --json                    NDJSON HarnessEvent to stdout
  -h, --help                Show help
  -V, --version             Show version

Defaults with no flags:
  Every launch resolves args > project config (.hcn/config.json at the
  git root) > user config (~/.config/hcn/config.json) > built-in profile
  > harness default. The profile pins: effort medium, sandbox
  workspace-write (codex only; other harnesses report divergence),
  discovery on, autonomy off, write/shell on. timeout and max-steps have
  no default. Question escalation defaults ON (config key
  "escalateQuestions"; it is a prompt preamble, never a harness flag).
  Provenance prints to stderr on every run; see
  'hcn inspect <harness>' for the resolved argv of a bare run.
`;

export const SESSION_HELP = `hcn session - Interactive session (Claude-only)

Usage: hcn session <harness> [options]

Arguments:
  <harness>                 Must be 'claude' (other harnesses have no sessionMode)

Options:
  --model <id>              Model for the session
  --session-id <uuid>       Session id (UUID, else random)
  --cwd <path>              Working directory
  --help                    Show help
  --version                 Show version
`;

export const INSPECT_HELP = `hcn inspect - Descriptor / argv inspection

Usage: hcn inspect <harness> [options]

Arguments:
  <harness>                 claude | codex | pi | muse

Options:
  --argv                    Preview argv that would be spawned
  --prompt <text>           Prompt for argv preview
  --prompt-file <path|->    Read prompt from file
  --model <id>              Model
  --effort <value>          Effort
  --sandbox <value>         Sandbox
  --provider <value>        Provider
  --tools <a,b>             Tools
  --autonomy / --no-autonomy
  --write / --no-write
  --shell / --no-shell
  --max-steps <n>
  --no-tools, --no-instruction-files, --no-extensions, --no-skills
  --escalate-questions / --no-escalate-questions
                            Accepted; renders nothing in argv (the mode
                            rides the run prompt, not a harness flag)
  --cwd <path>
  --env KEY=VAL
  --resume <uuid>
  -h, --help                Show help
`;

export const LS_HELP = `hcn ls - List harnesses

Usage: hcn ls

Prints each harness name with its verifiedAgainst version and versionSource.
`;

export const CHECK_HELP = `hcn check - Drift check

Usage: hcn check [--json]

Compares each harness's verifiedAgainst against the latest published version.
Exits 0 when no drift, 1 when drift found, 1 on network failure with partial results.

Options:
  --json                    Machine-readable output
  -h, --help                Show help
`;
