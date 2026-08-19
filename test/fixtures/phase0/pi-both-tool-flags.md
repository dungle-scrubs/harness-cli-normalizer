# Phase 0 evidence: pi --tools + --exclude-tools together

Verified against pi 0.84.2, live run, 2026-08-18.

## Probe 1: legality

`pi -p --mode json --tools read --exclude-tools bash "..."` -> exit 0, no
warning, normal turn. Both flags together are legal.

## Probe 2: combined semantics

`pi -p --mode json --tools read,bash,write --exclude-tools bash "list your
available tool names"` -> model answered:

`read, write, mcp__tool-proxy__discover_tools, mcp__tool-proxy__execute_tool,
mcp__tool-proxy__list_apps, mcp__tool-proxy__get_app_context,
mcp__tool-proxy__execute_code`

Facts established:

1. **Intersection semantics**: exclude subtracts from include. bash was in the
   include and absent from the effective set. NOT an error, NOT last-wins.
2. **MCP/extension tools are unaffected by a --tools allowlist of built-in
   names**: the allowlist did not strip the tool-proxy MCP tools. pi's help
   says --tools is an allowlist over "built-in, extension, and custom tools",
   but an include naming only built-ins left MCP tools enabled. Treat the
   include as additive-grant over defaults + MCP registrations, not a strict
   total allowlist. (Needs one more probe to pin down; see below.)
3. Tool names the model sees are lowercase with `mcp__server__tool` shape for
   extensions - matches the extensible-rule pass-through vocabulary.

## Consequence for D1 (mutual exclusivity)

pi natively supports the composable allow-then-deny shape (hcn's option B).
hcn's D1 decision - mutual exclusivity - is a curated restriction on top of
pi's superset. It stays valid (claude-only pairing keeps parity across the
two list-capable harnesses), and claude remains the compatibility constraint
unless/until claude's interplay probe shows it accepts both too.

## Open follow-up

Probe whether `--tools read --exclude-tools mcp__tool-proxy__execute_tool`
can deny an extension tool at all (exclude over non-built-ins), and whether
`--tools` with an MCP name grants a disabled MCP tool. Feeds the descriptor
`tools` field in Phase 1.
