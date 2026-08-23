# Tool names are closed canonical plus `native:` passthrough

The tool vocabulary is a closed canonical set derived from descriptor `builtins` and `categories`. Unknown clean names do not refuse: prefixed `native:<name>` passes through to the harness and is recorded in provenance. Refusing would break every extension and MCP tool that registers at runtime; passing silently would hide typos (Claude ignores unknown grant names without error). Passing plus recording means the run shows what was emitted and which grants hcn could not vouch for.

