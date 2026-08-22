/**
 * Curated refusal hints (D8), confirmed in review 2026-08-18
 * (test/fixtures/phase0/hints-confirmed.md is the durable record). A hint
 * is the nearest-alternative control for the CURRENT harness, shown before
 * the cross-harness support list so a scanning caller meets the
 * stay-on-harness suggestion first. Wording is locked verbatim; unit tests
 * pin every string.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import type { RefusalOption } from "./refusal.js";

const HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = deepFreezeSafe({
  claude: {
    sandbox:
      "claude has no sandbox modes; approximate with a per-tool allowlist (--tools Read,Bash) or --disallowedTools to keep tools out, and run untrusted work in a disposable directory or container",
    write:
      "claude has no write toggle; keep the Write tool out with --tools that omits it, or --disallowedTools Write for the deny-complement spelling",
    shell:
      "claude has no shell toggle; disallow the Bash tool (--tools without Bash, or --disallowedTools Bash) and note Monitor can still run commands in headless runs",
    maxSteps:
      "claude has no step cap flag; bound the work in the prompt (task size, 'stop after N operations') or impose a wall-clock timeout at the caller",
    provider:
      "claude routes models through Anthropic only (Bedrock/Vertex via settings); use --model to pick within it - there is no separate provider selector",
    "discovery.tools":
      "claude has no tools-discovery toggle (tools are always compiled in); shape the tool set with --tools/--disallowedTools instead",
    "discovery.instructionFiles":
      "claude has no isolated instruction-file toggle; --setting-sources project isolates from user-level settings but also skips hooks, LSP and keychain reads - weigh that before using it as an approximation",
  },
  codex: {
    tools:
      "codex has no per-tool name lists; use --sandbox read-only for a read-only grant or category switches via config keys (features.shell_tool, web_search)",
    excludeTools:
      "codex has no per-tool name lists; use category switches via config keys (features.shell_tool) or --sandbox modes",
    write:
      "codex has no write toggle; use --sandbox read-only (config: sandbox_mode) so shell commands cannot write either",
    // issue #48: the append half has no codex spelling.
    appendSystemPrompt:
      "codex has no append-to-prompt flag; -c instructions=<literal or path> REPLACES the whole prompt (both accepted, live-verified) - there is no additive form",
    shell:
      "codex has no shell toggle; disable the shell tool via config (-c features.shell_tool=false) or use --sandbox read-only",
    maxSteps:
      "codex has no step cap flag; bound via sandbox policy and a caller-side timeout, or prompt-level limits",
    provider:
      "codex routes models through OpenAI (or --oss for local); use --model to pick within it - there is no separate provider selector",
    "discovery.tools":
      "codex has no tools-discovery toggle; disable tool classes via config keys (features.shell_tool, web_search) instead",
    "discovery.instructionFiles":
      "codex always loads AGENTS.md hierarchy; no per-call toggle exists - keep the files out of the tree or work from a directory without them",
    "discovery.extensions":
      "codex loads MCP servers and plugins from config; disable per-server with -c or codex mcp remove rather than a call-time toggle",
    "discovery.skills":
      'codex has no global skills-off switch (skills.enabled is not a key); disable per skill per call with -c skills.config=[{path=".../SKILL.md", enabled=false}] and bundled skills with -c skills.bundled.enabled=false',
  },
  pi: {
    sandbox:
      "pi has no sandbox dimension; approximate with a minimal tool grant (--tools read,grep,find,ls) so the run cannot write or execute, or sandbox the process yourself (container, VM)",
    write:
      "pi has no write toggle; grant without the write tool (--tools read,bash,edit) or use --exclude-tools write",
    shell:
      "pi has no shell toggle; grant without the bash tool (--tools read,edit,write) or use --exclude-tools bash",
    maxSteps:
      "pi has no step cap flag; bound the work in the prompt or impose a wall-clock timeout at the caller",
  },
  muse: {
    tools:
      "muse has no per-tool name lists; gate execution with --disable-write, --disable-shell, --disable-web-tools - there is no allowlist",
    excludeTools:
      "muse has no per-tool name lists; gate execution with --disable-write, --disable-shell, --disable-web-tools category switches",
    sandbox:
      "muse's sandbox is on by default and not selectable per-call; --disable-sandbox exists to turn it OFF, and exposure can be tuned with --disable-write, --disable-shell, --disable-web-tools - there is no mode selector",
    provider:
      "muse routes models through its own API; use --model to pick within it - there is no separate provider selector",
    "discovery.tools":
      "muse has no tools-discovery toggle; gate execution with --disable-write/--disable-shell/--disable-web-tools",
    "discovery.instructionFiles":
      "muse loads rules per workspace trust; --no-foreign-personal-context excludes foreign personal rules, and withholding --trust-workspace keeps workspace rules unloaded",
    "discovery.skills":
      "muse scopes skills by trust like rules; --no-foreign-personal-context drops foreign skills and untrusted workspaces stay unloaded - there is no unconditional skills-off switch",
    // issue #48 (ratified 2026-08-20): muse cannot strip the payload at all.
    systemPrompt:
      "muse has no system-prompt surface; its built-in prompt always applies - there is no replacement or append spelling (structural: nothing to approximate with)",
    appendSystemPrompt:
      "muse has no system-prompt surface; its built-in prompt always applies - there is no replacement or append spelling (structural: nothing to approximate with)",
  },
});

/** deepFreeze without importing the descriptor's (which carries extra
 * machinery); structure is plain JSON so Object.freeze all the way down. */
function deepFreezeSafe<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreezeSafe(v);
    Object.freeze(value);
  }
  return value;
}

/** The confirmed hint for a refused option on a harness, or undefined. */
export const hintFor = (harness: string, option: RefusalOption): string | undefined =>
  HINTS[harness]?.[option];

/** All hints - for the unit test that pins every string against the
 * evidence file's count. */
export const allHints = (): ReadonlyArray<{ harness: string; option: string; text: string }> => {
  const out: { harness: string; option: string; text: string }[] = [];
  for (const [harness, table] of Object.entries(HINTS)) {
    for (const [option, text] of Object.entries(table)) out.push({ harness, option, text });
  }
  return out;
};

/** Convenience for raise sites that already hold the descriptor. */
export const hintForDescriptor = (
  h: HarnessDescriptor,
  option: RefusalOption,
): string | undefined => hintFor(h.name, option);
