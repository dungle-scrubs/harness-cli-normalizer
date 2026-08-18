# Phase 0 evidence: claude tool-list interplay and skills-off switch

Verified against claude 2.1.233, live runs, 2026-08-18, cwd /tmp/claude-probe.

## Probe 1: --allowedTools + --disallowedTools together

Legal. No warning, exit 0. The variadic flags swallow following tokens, so
the prompt MUST come after `--` when either flag is used - claude itself
prints `tip: to pass '--allowedTools' as a value, use '-- ...'` on the
mistake. hcn's own buildLaunchArgv places the prompt positionally BEFORE
grants (tools last), so hcn-constructed argv is unaffected; the trap only
bites raw passthrough.

## Probe 2: interplay semantics

`--allowedTools "Bash" --disallowedTools "Bash"` then "run echo probe-ok":
the command still ran - via the Monitor tool. Claude's native model is
**filter, not strict allowlist**: --allowedTools removes non-matching tools
from the model's visible set (probe 3), --disallowedTools removes matching
tools; other routes (Monitor in headless) can still execute commands. Tool
denial is prompt-level surface control, not a security boundary.

## Probe 3: deny removes from effective set

`--disallowedTools "Bash,Monitor,Read"` -> model reports 33 tools, none of
them Bash, Monitor, or Read (only ReadMcpResource*Tool names, which are
different tools). So deny IS enforced against the model's tool set.

## Probe 4: --disable-slash-commands is a real skills-off switch

With flag: model reports "No Skill tool is available, and no skills appear
loaded."
Control without flag: "Yes, I have a Skill tool, and skills appear listed"
(30 skills enumerated).

So claude's normalized discovery.skills=false facet maps cleanly to
`--disable-slash-commands` (removes Skill tool + listing), NOT only to
`--setting-sources project` (which isolates settings scope but keeps
built-in discovery). The artifact's "verify" marker on this cell resolves.

## Consequences for the plan

1. D1 mutual exclusivity holds for claude too: both flags together are
   accepted and compose as allow-then-deny (deny wins on overlap) - pi's
   intersection semantics match claude's. Parity confirmed across both
   list-capable harnesses; the mutual-exclusion restriction is hcn's
   curation on top of two compatible natives.
2. Claude patterns (`Bash(git *)`) work in both lists (typo warnings on
   stderr for unknown names - the silent-acceptance hazard is for exact
   names, pattern typos DO warn).
3. The descriptor's claude turnOptions should grow:
   - discovery.skills facet -> `--disable-slash-commands`
   - tool lists already exist in the descriptor surface (--allowedTools)
4. Claude's effective-tool-model nuance (Monitor can run commands when Bash
   is denied) belongs in descriptor comments as a documented caveat, and in
   the D3 hint curation later: "denying a tool removes it from the model's
   set; it is not a sandbox control."
