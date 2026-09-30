# hcn session --skills on pi (issue #332)

Captured 2026-09-30 against installed `pi 0.99.1`, free route
`--model zai/glm-5.2`, cwd `/tmp/hcn332-probe-pi` (an empty scratch
directory, so no project context loads). Driven by a Node client through
`node dist/cli.js session pi --json --skills wayfinder --model zai/glm-5.2`:
three `send` commands, each waited to its turn `done`, then `close`. The
rendered spawn argv (the same `buildSessionArgv` render the unit tests pin,
and the same render `hcn run --skills` uses):

```text
pi --mode rpc --session-id <uuid> --model zai/glm-5.2 -ns --skill /Users/kevin/.agents/skills/wayfinder
```

`session-skills.ndjson` is that stream's full stdout (701 lines):
`session` opens, the three turns each carry `disposition started` and end
`done clean`, and `closed cause clean` ends the stream. Turn texts:

1. `in-1` "Reply with exactly the single word READY" -> assistant text
   `READY`. A send into an allowlisted session is accepted and consumed
   like any other send.
2. `in-2` "Use your skill tool to load the skill named 'wayfinder' ..." ->
   assistant text `# Wayfinder` (wayfinder's first heading; the content is
   reachable in-session).
3. `in-3` "List the names of the skills you can load ... attempt to load
   the skill named 'hcn' ..." -> the model `ls`'d `~/.agents/skills/` with
   its bash tool and read `hcn/SKILL.md` with the read tool, then reported
   the hcn skill loaded. pi 0.99.1 has NO runtime skill tool: skills
   advertise through the `<available_skills>` block of the system prompt
   and "load" by file read, so the model's file tools bypass any argv
   allowlist exactly as they do on `hcn run` (the documented semantics:
   the allowlist governs the harness's skill-loading surface, not
   filesystem access).

`session-skills.stderr.txt` is that stream's stderr: the skills
provenance line plus the questions/memory lines.

## What the allowlist actually constrains (pi-side mechanism)

pi's model-visible skill surface is the `<available_skills>` block
(`formatSkillsForPrompt` in pi's `src/core/skills.ts`); `-ns` sets
`includeDefaults: false`, and explicit `--skill <path>` loads are the only
remaining source. Raw-pi rpc probes the same day (one trivial turn each so
pi persists the session file, then reading the system message sections out
of `~/.pi/sessions/...`; digests only, the section content itself is
operator configuration and is not committed):

| Probe argv (after `--mode rpc`) | `<available_skills>` in the system prompt |
| --- | --- |
| `-ns --skill .../wayfinder` (the hcn render) | absent - empty visible set |
| `-ns --skill .../hcn` | exactly `["hcn"]` |
| bare (no flags) | 54 skills - the whole discovered catalog |

`--skills wayfinder` on a bare session shows no catalog entry because
wayfinder's own frontmatter carries `disable-model-invocation: true` - pi
deliberately keeps it out of the model-visible catalog in every mode
(bare sessions included); it is invocable by file read and `/skill:name`,
never by catalog advertisement. The `-ns + --skill` pair is the exact-set
allowlist for every normally-frontmattered skill, which is what the
descriptor render relies on (verified against 0.99.1 here; the same
render served the run-side verification since #38).

Secret scan at capture: no token/key/email content; the stream carries
model replies, tool calls against skill paths, and session ids only.
