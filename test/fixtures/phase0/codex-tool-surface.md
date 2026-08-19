# Phase 0 evidence: codex tool-selection surface

Verified against codex-cli 0.146.1, live `--help`, live `features list`, and the
official config reference (learn.chatgpt.com/docs/config-file/config-reference),
2026-08-18.

## Facts

1. **No per-tool name list exists** - not on the CLI (`codex exec --help` has no
   allow/deny flags) and not in config.toml.
2. **Config-level tool control is feature-boolean shaped:**
   - `features.shell_tool` (bool) - the shell tool, on by default
   - `features.unified_exec` (bool) - the unified PTY exec tool, default on
   - `features.web_search` (deprecated) / top-level `web_search =
     "disabled|cached|indexed|live"` - `"disabled"` removes the tool entirely
   - `tools.view_image` (bool) - image tool
   - `tools.web_search` - search config (context size, domains), not enablement
3. **MCP tools are per-tool configurable** - `mcp_servers.<id>.tools.<tool>`
   exists for approval_mode (observed live in ~/.codex/config.toml for
   tool-proxy); per-tool enable/disable for MCP servers is app-level
   (`apps.<id>.tools.<tool>.enabled` per reference) but no analogous key exists
   for built-in tools.
4. **`-c key=value` reaches every one of these** from the command line,
   per-call, TOML-typed.

## Consequence for the descriptor (Phase 1)

Codex's tool surface for hcn purposes:

- include list: none
- exclude list: none
- category switches: yes - via `-c features.shell_tool=false` style config-kv
  and `web_search="disabled"`; plus `--enable/--disable <FEATURE>` for feature
  classes (browser_use, computer_use, ...)
- normalized tool-list dimensions refuse on codex (correct as designed);
  a future "category switch" pass-through could normalize the three or four
  documented booleans, but that is curation, not list mapping

Matches the artifact's capability matrix row ("no list flag;
`--enable/--disable <FEATURE>` toggles feature classes; generic `-c key=value`
reaches config.toml") - no correction needed.
