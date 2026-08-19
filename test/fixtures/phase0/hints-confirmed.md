# Phase 3 hint confirmations

Confirmed by Kevin in review, 2026-08-18. Wording locked as shipped.

1. pi/autonomy: "pi has no unattended-run flag; approximate with a
   per-tool allowlist (--tools read,bash) if you need unattended behavior
   on pi"
2. codex/tools: "nearest control on codex: category switches via config
   keys (features.shell_tool, web_search) or sandbox modes - see
   `hcn inspect codex`"
3. muse/tools: "nearest control on muse: category switches
   (--disable-write, --disable-shell, --disable-web-tools) gate tool
   execution per session"

Remaining 22 pairs: proposed in harness batches, same confirm cadence.

## Batch 2: remaining 22 instances

Confirmed by Kevin in review (lucid .lucid/hint-curation.html), 2026-08-18.
Wording locked as proposed, with one correction from sandbox discussion:

4. claude/sandbox: "claude has no sandbox modes; approximate with a
   per-tool allowlist (--tools Read,Bash) or --disallowedTools to keep
   tools out, and run untrusted work in a disposable directory or
   container"
5. pi/sandbox: "pi has no sandbox dimension; approximate with a minimal
   tool grant (--tools read,grep,find,ls) so the run cannot write or
   execute, or sandbox the process yourself (container, VM)"
6. muse/sandbox: "muse's sandbox is on by default and not selectable
   per-call; --disable-sandbox exists to turn it OFF, and exposure can
   be tuned with --disable-write, --disable-shell, --disable-web-tools -
   there is no mode selector"   [corrected per sandbox discussion]
7. claude/write: "claude has no write toggle; keep the Write tool out
   with --tools that omits it, or --disallowedTools Write for the
   deny-complement spelling"
8. codex/write: "codex has no write toggle; use --sandbox read-only
   (config: sandbox_mode) so shell commands cannot write either"
9. pi/write: "pi has no write toggle; grant without the write tool
   (--tools read,bash,edit) or use --exclude-tools write"
10. claude/shell: "claude has no shell toggle; disallow the Bash tool
    (--tools without Bash, or --disallowedTools Bash) and note Monitor
    can still run commands in headless runs"
11. codex/shell: "codex has no shell toggle; disable the shell tool via
    config (-c features.shell_tool=false) or use --sandbox read-only"
12. pi/shell: "pi has no shell toggle; grant without the bash tool
    (--tools read,edit,write) or use --exclude-tools bash"
13. claude/maxSteps: "claude has no step cap flag; bound the work in the
    prompt (task size, 'stop after N operations') or impose a
    wall-clock timeout at the caller"
14. codex/maxSteps: "codex has no step cap flag; bound via sandbox
    policy and a caller-side timeout, or prompt-level limits"
15. pi/maxSteps: "pi has no step cap flag; bound the work in the prompt
    or impose a wall-clock timeout at the caller"
16. claude/provider: "claude routes models through Anthropic only
    (Bedrock/Vertex via settings); use --model to pick within it -
    there is no separate provider selector"
17. codex/provider: "codex routes models through OpenAI (or --oss for
    local); use --model to pick within it - there is no separate
    provider selector"
18. muse/provider: "muse routes models through its own API; use --model
    to pick within it - there is no separate provider selector"
19. claude/discovery.tools: "claude has no tools-discovery toggle (tools
    are always compiled in); shape the tool set with
    --tools/--disallowedTools instead"
20. claude/discovery.instructionFiles: "claude has no isolated
    instruction-file toggle; --setting-sources project isolates from
    user-level settings but also skips hooks, LSP and keychain reads -
    weigh that before using it as an approximation"
21. codex/discovery.tools: "codex has no tools-discovery toggle; disable
    tool classes via config keys (features.shell_tool, web_search)
    instead"
22. codex/discovery.instructionFiles: "codex always loads AGENTS.md
    hierarchy; no per-call toggle exists - keep the files out of the
    tree or work from a directory without them"
23. codex/discovery.extensions: "codex loads MCP servers and plugins
    from config; disable per-server with -c or codex mcp remove rather
    than a call-time toggle"
24. codex/discovery.skills: "codex discovers skills from its skills
    directory; no call-time toggle - remove or move the skill files
    instead"
25. muse/discovery.tools: "muse has no tools-discovery toggle; gate
    execution with --disable-write/--disable-shell/--disable-web-tools"
26. muse/discovery.instructionFiles: "muse loads rules per workspace
    trust; --no-foreign-personal-context excludes foreign personal
    rules, and withholding --trust-workspace keeps workspace rules
    unloaded"
27. muse/discovery.skills: "muse scopes skills by trust like rules;
    --no-foreign-personal-context drops foreign skills and untrusted
    workspaces stay unloaded - there is no unconditional skills-off
    switch"

## Defaults roadmap ratifications (round 2)

Approved in review (.lucid/next-five-defaults.html, v3), 2026-08-19:

- D9: profile write = true (emit-nothing ratification, names current
  behavior)
- D10: profile shell = true (same shape)
- D11: timeout dimension ADDED as opt-in only - --timeout <seconds> arg
  and "timeout" config key, NO profile default. Grounding: no harness
  ships a wall-clock run cap; one prompt expands into an unbounded turn
  loop; a fixed default kills legitimate work. --timeout 0 = disable.
  Process-group signalling; timeout failure class; done cause "killed".
- D12: maxSteps opt-in only (config key), NO profile default - same
  argument as D11; arg already exists (muse-only).
- D13: tools ratification deferred to its own design sitting.
- Model: permanently out of profile scope (recorded in profile doc
  comment + README).
