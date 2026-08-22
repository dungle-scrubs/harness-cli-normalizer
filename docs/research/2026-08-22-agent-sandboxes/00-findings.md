# Sandboxes, and staging a skill subset for one run

Research date: 2026-08-22. Four findings files sit beside this one; this file
carries the conclusion and points at them.

- `01-sandcastle.md` - what sandcastle is and what it can inject.
- `02-alternatives.md` - every other sandbox that can wrap a coding-agent CLI.
- `03-harness-skill-knobs.md` - how claude, codex, pi, and muse discover skills,
  and what a caller can do about it.
- `04-hook-enforcement.md` - whether a pre-tool gate exists per harness.

Every claim below carries a standing word: **documented** (the owning source says
it), **observed** (someone ran it and saw this), or **unverified**.

## The finding that changes the question

The original question paired two things: a sandbox for harnesses that lack one,
and a temporary config directory holding a chosen subset of skills. **The second
does not need the first.** Skill subsetting is an environment-variable problem,
and it is already solvable with what hcn ships today.

Every harness reads a variable that relocates the directory it loads skills from
(**documented**, `03-harness-skill-knobs.md` §1.3, §2.3, §3.3, §4.3):

| harness | variable | what moves |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | all state: settings, skills, plugins, sessions; credentials on Linux and Windows, but macOS Keychain stays put |
| codex | `CODEX_HOME` | all user state: `config.toml`, profiles, `auth.json` on the file backend, history |
| pi | `PI_CODING_AGENT_DIR` | all global state: `settings.json`, `auth.json`, sessions, skills, extensions |
| muse | `XDG_CONFIG_HOME` (partial) | `muse/skills` and `settings.json` only; no full-state variable exists |

And hcn already passes any variable to the child process. `--env KEY=VAL`, with
`KEY=` deleting a variable, merged over the parent environment in
`src/execution/node-deps.ts:94-112`, validated before the spawn in
`src/execution/stream-turn.ts:150-158` (**documented**, repo read).

So this works today, with no new code and no sandbox:

```
hcn run claude --env CLAUDE_CONFIG_DIR=/tmp/run-42/claude --prompt-file brief.md
```

Stage `/tmp/run-42/claude/skills/` with symlinks to the skills the orchestrator
picked. The agent sees those and nothing else. It is an allowlist by
construction: the directory contains what you put in it. That property is what
the per-run flags below fail to deliver.

## Why the per-run flags are not the answer

Each harness has a different, partial mechanism (**documented**,
`03-harness-skill-knobs.md` §6 per harness):

- **pi** has a real allowlist: `--no-skills --skill <path>` repeated. hcn already
  renders it (`src/interpretation/skills-selection.ts:46-51`).
- **codex** can disable per skill for one run through the config override:
  `-c 'skills.config=[{path="...", enabled=false}]'`, plus `--profile` to layer a
  config file. Per-run, and it works in `codex exec`.
- **claude** has no per-run flag at all. The closest is `skillOverrides` with a
  skill set to `"off"`, which hcn renders through `--settings`
  (`src/interpretation/skills-selection.ts:62-73`). `Skill` is **not** a name a
  tool-permission rule can deny (**documented**, §1.6).
- **muse** has nothing per-run. Only `muse skills disable`, which persists.

Two of these are subtractive: you enumerate what to turn OFF. That is the wrong
shape for an orchestrator, which knows what it wants ON and cannot know what
else is installed. A staged directory inverts it.

**Repo-relevant gap.** `src/knowledge/codex.ts:134-137` records `skills: null`
with the comment that codex has "no name lists anywhere - not on the CLI, not in
config.toml." The research contradicts this: `[[skills.config]]` with `path` or
`name` selectors exists, and `-c` reaches it per run (**documented**,
`03-harness-skill-knobs.md` §2.6, citing `cx-config-reference.md` and
`cx-src-skills_config.rs`). The descriptor is out of date. That is a factual
correction to the knowledge layer, and the hint in
`src/interpretation/hints.ts:52` inherits the same error.

## What survives a staged config directory

Relocating the config directory does not hide everything (**documented**,
`03-harness-skill-knobs.md` §3, §4 per harness):

- **Project skills survive.** `.agents/skills`, `.claude/skills`, and
  `.codex/skills` inside the repository are found relative to the working
  directory, not the home directory. Hiding them needs a trust gate, `--no-skills`
  on pi, or a different working directory.
- **`~/.agents/skills` is read by codex, pi, and muse, but not by claude**
  (**documented**, §1.1, §2.1, §3.1, §4.1). It resolves through the home
  directory, so `CODEX_HOME` and `PI_CODING_AGENT_DIR` do not hide it. Only a
  staged `HOME` does.
- **muse has no full-state variable.** `XDG_CONFIG_HOME` covers `muse/skills` but
  not `~/.agents/skills`. Full isolation on muse needs `HOME`, plus
  `--no-foreign-personal-context`, plus withholding `--trust-workspace`.
- **Staging `HOME` is the blunt version.** It hides everything above on all four
  harnesses, and it also moves credentials. On macOS, claude and codex keep auth
  in the Keychain, so a staged HOME does not break their login (**documented**,
  §1.4, §2.4); pi keeps `auth.json` under its own directory, which the variable
  moves anyway.

The precise recipe per harness is in `03-harness-skill-knobs.md` §4.

## Sandcastle is the wrong tool for this half

`@ai-hero/sandcastle` 0.12.0, clone at commit `e99f832`, dated 2026-06-29
(**observed**). It orchestrates agents in Docker, Podman, Vercel, or Daytona
sandboxes, or none.

For the skills question it is a poor fit, on two counts (**documented**,
`01-sandcastle.md` §7):

1. **No skill-selection surface exists.** A grep for skill, `SKILL.md`, `.claude`,
   `.codex`, `.agents`, `AGENTS.md`, and `CLAUDE.md` across the source returns
   session paths and triage documents only. No mount allowlist, no config key.
2. **It forces `HOME=/home/agent`** for the Docker and Podman backends, so
   setting a fake HOME through the environment does not work. The one lever that
   would otherwise give uniform control is closed off.

What it does offer is generic: `docker({ mounts })` bind mounts, a
`copyToWorktree` step, Dockerfile baking, and shell hooks. Composing per-skill
control means one `MountConfig` per skill directory plus a hook to assemble them.
That is building the feature yourself inside someone else's tool.

Sandcastle remains a reasonable answer to the *sandbox* half if the target is
containers. It is not an answer to the skills half.

## The sandbox half, separately

Ranked for a local macOS orchestrator (**documented**, `02-alternatives.md`):

1. **`@anthropic-ai/sandbox-runtime` (`srt`)** - the closest fit. Wraps any
   command, including `claude -p`, with no container: `sandbox-exec` and Seatbelt
   profiles on macOS, bubblewrap on Linux. Filesystem deny-then-allow, network
   allowlist through a local proxy. It is a research preview, and it has **no**
   HOME or config-directory field of its own - the caller sets the variable and
   uses `denyRead: ["~/"]` to hide the real home. That composition is exactly the
   staged-directory approach above, so the two fit together.
2. **Built-in sandboxes** - codex has `--sandbox read-only|workspace-write|danger-full-access`
   (Seatbelt on macOS), and claude has a Bash-tool sandbox on the same primitives.
   hcn already renders codex's. Neither pi nor muse has a mode selector.
3. **`nono`** - Rust, Apache 2.0, Landlock on Linux and Seatbelt on macOS, plus a
   proxy doing CONNECT filtering and credential injection, with per-tool child
   sandboxes and an expressive filesystem policy. The most capable of the
   purpose-built ones found.
4. **Containers** - sandcastle, Docker, Apple `container`, devcontainers,
   microsandbox. Heavier; correct when the isolation needs to be a real boundary
   rather than a policy.

Of the 14 purpose-built projects surveyed, five document a controlled config
directory: `finbarr/yolobox`, `boxlite-ai/boxlite`, `rlaope/agentbox`,
`numtide/claudebox` (home shadowing), and `VishalJ99/claude-docker`. The rest are
silent or offer composition only (**documented**, `02-alternatives.md`, table).

## What this suggests for hcn

Stated as options, not decisions.

1. **Document `--env` for config staging.** It works now and nothing says so. The
   hcn skill reference mentions `--env K=V` once with no semantics.
2. **Correct the codex descriptor.** `skills: null` is wrong; `[[skills.config]]`
   with `-c` is a per-run surface. `src/knowledge/codex.ts:134-137` and
   `src/interpretation/hints.ts:52`.
3. **Consider a staged-config dimension.** A flag that takes a skill list, builds
   a temporary directory, and sets the right variable per harness is a genuine
   normalization: one caller-facing shape over four different variables, with
   muse's partial coverage reported as divergence the way sandbox already is.
   This is what hcn exists to do, and it would make `--skills` uniform instead of
   the current split between pi's load flag and claude's override complement.
4. **`hcn session` carries no `--env`.** RFC 01 defers session flag parity
   explicitly (`docs/rfc/01_…rfc.md:79-80`, `:406-409`, `:626-632`). If staged
   config becomes the mechanism, sessions need it too.
5. **A sandbox dimension beyond codex's** is a separate and much larger question.
   `srt` as an optional wrapper is the cheapest shape, and it does not belong in
   the knowledge layer.

## Open

- Whether a staged `CLAUDE_CONFIG_DIR` breaks hcn's resume store path, which is
  computed from `{home}` (`src/cli/run.ts:380`, `src/interpretation/store.ts:13`).
  Reasoned, not tested. **Unverified.**
- Whether `claude -p` with a staged config directory still authenticates from the
  macOS Keychain. **Unverified**; not run.
- `docker sandbox` and `cagent`: no primary source read. **Unverified.**
- Apple `container`, devcontainers, Modal, Fly.io: **unverified**, no local copy.
- Claude Code's sandbox in `-p` mode: `cc-sandbox.txt` never mentions `-p`.
  **Silent**, per `02-alternatives.md`.
- Per-file open questions are listed in each findings file's own "Open" section.
