import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { DiscoveryOptions, TurnOptions } from "../interpretation/argv.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";

export type ParsedPromptSource =
  | { kind: "positional"; prompt: string }
  | { kind: "prompt-flag"; prompt: string }
  | { kind: "prompt-file"; prompt: string }
  | { kind: "none" };

export interface CliTurnOptions extends TurnOptions {
  // TurnOptions already has prompt, model, effort, etc.
}

export interface CliRunOptions extends CliTurnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly resume?: string;
  readonly json?: boolean;
}

export interface ParseCommonResult {
  prompt: string | undefined;
  promptSource: ParsedPromptSource["kind"];
  turnOptions: TurnOptions;
  runOptions: { cwd?: string; env?: Record<string, string>; resume?: string };
}

const _DISCOVERY_FLAGS = {
  tools: "no-tools",
  instructionFiles: "no-instruction-files",
  extensions: "no-extensions",
  skills: "no-skills",
} as const;

/**
 * Parse --env KEY=VAL entries into env record. "" value means delete.
 */
export const parseEnvEntries = (
  entries: string[] | string | undefined,
): Record<string, string> | undefined => {
  if (entries === undefined) return undefined;
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of list) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new ArgvRefusalError({
        issue: "invalid-env",
        harness: "claude",
        supported: ["KEY=VAL"],
        detail: entry,
      });
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0") || key.includes("\0")) {
      throw new ArgvRefusalError({
        issue: "invalid-env",
        harness: "claude",
        supported: ["keys must match ^[A-Za-z_][A-Za-z0-9_]*$ and contain no NUL"],
        detail: entry,
      });
    }
    env[key] = value;
  }
  return env;
};

export const resolvePrompt = (args: {
  positionalPrompt?: string;
  promptFlag?: string;
  promptFile?: string;
}): { prompt: string; source: ParsedPromptSource["kind"] } => {
  const hasPositional = args.positionalPrompt !== undefined && args.positionalPrompt !== "";
  const hasPrompt = args.promptFlag !== undefined;
  const hasFile = args.promptFile !== undefined;

  const count = Number(hasPositional) + Number(hasPrompt) + Number(hasFile);
  if (count === 0) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: "claude",
      supported: ["provide prompt via positional, --prompt, or --prompt-file"],
      detail: "missing prompt",
    });
  }
  if (count > 1) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: "claude",
      supported: ["use one of positional, --prompt, or --prompt-file"],
      detail: "mutual exclusion",
    });
  }
  if (hasPositional) return { prompt: args.positionalPrompt!, source: "positional" };
  if (hasPrompt) return { prompt: args.promptFlag!, source: "prompt-flag" };
  // --prompt-file
  const file = args.promptFile!;
  if (file === "-") {
    // read from stdin sync - caller may provide content differently for async path.
    // For sync path, read stdin fd 0.
    const content = readFileSync(0, "utf8");
    return { prompt: content, source: "prompt-file" };
  }
  const content = readFileSync(file, "utf8");
  return { prompt: content, source: "prompt-file" };
};

export const resolvePromptAsync = async (args: {
  positionalPrompt?: string;
  promptFlag?: string;
  promptFile?: string;
}): Promise<{ prompt: string; source: ParsedPromptSource["kind"] }> => {
  const hasPositional = args.positionalPrompt !== undefined && args.positionalPrompt !== "";
  const hasPrompt = args.promptFlag !== undefined;
  const hasFile = args.promptFile !== undefined;

  const count = Number(hasPositional) + Number(hasPrompt) + Number(hasFile);
  if (count === 0) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: "claude",
      supported: ["provide prompt via positional, --prompt, or --prompt-file"],
      detail: "missing prompt",
    });
  }
  if (count > 1) {
    throw new ArgvRefusalError({
      issue: "invalid-option-value",
      harness: "claude",
      supported: ["use one of positional, --prompt, or --prompt-file"],
      detail: "mutual exclusion",
    });
  }
  if (hasPositional) return { prompt: args.positionalPrompt!, source: "positional" };
  if (hasPrompt) return { prompt: args.promptFlag!, source: "prompt-flag" };
  const file = args.promptFile!;
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return { prompt: Buffer.concat(chunks).toString("utf8"), source: "prompt-file" };
  }
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(file, "utf8");
  return { prompt: content, source: "prompt-file" };
};

/**
 * Build TurnOptions from parsed flag values. Shared between run and inspect --argv.
 */
export const parseTurnOptions = (values: Record<string, unknown>): TurnOptions => {
  const opts: Record<string, unknown> = {};

  if (values.model !== undefined) opts.model = values.model;
  if (values.effort !== undefined) opts.effort = values.effort;
  if (values.sandbox !== undefined) opts.sandbox = values.sandbox;
  if (values.provider !== undefined) opts.provider = values.provider;
  if (values.tools !== undefined) {
    const raw = String(values.tools);
    opts.tools = raw.length === 0 ? [] : raw.split(",").map((s) => s.trim());
  }
  if (values["exclude-tools"] !== undefined) {
    const raw = String(values["exclude-tools"]);
    opts.excludeTools = raw.length === 0 ? [] : raw.split(",").map((s) => s.trim());
  }
  if (values.skills !== undefined) {
    const raw = String(values.skills);
    (opts as Record<string, unknown>).skills =
      raw.length === 0 ? [] : raw.split(",").map((s) => s.trim());
  }
  if (values.autonomy === true) opts.autonomy = true;
  else if (values["no-autonomy"] === true) opts.autonomy = false;
  else if (values.autonomy === false) opts.autonomy = false; // for completeness

  if (values.write === true) opts.write = true;
  else if (values["no-write"] === true) opts.write = false;
  if (values.shell === true) opts.shell = true;
  else if (values["no-shell"] === true) opts.shell = false;
  if (values["escalate-questions"] === true) opts.escalateQuestions = true;
  else if (values["no-escalate-questions"] === true) opts.escalateQuestions = false;
  if (values["system-prompt"] !== undefined) opts.systemPrompt = String(values["system-prompt"]);
  if (values["append-system-prompt"] !== undefined)
    opts.appendSystemPrompt = String(values["append-system-prompt"]);

  if (values["max-steps"] !== undefined) {
    const n = Number(values["max-steps"]);
    if (!Number.isFinite(n)) {
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: "claude",
        option: "maxSteps",
        supported: ["integer 1-10000"],
        detail: String(values["max-steps"]),
      });
    }
    opts.maxSteps = n;
  }

  // discovery facets: --no-* means false, otherwise undefined (no-op)
  const discovery: Record<string, boolean> = {};
  let hasDiscovery = false;
  if (values["no-tools"] === true) {
    discovery.tools = false;
    hasDiscovery = true;
  }
  if (values["no-instruction-files"] === true) {
    discovery.instructionFiles = false;
    hasDiscovery = true;
  }
  if (values["no-extensions"] === true) {
    discovery.extensions = false;
    hasDiscovery = true;
  }
  if (values["no-skills"] === true) {
    discovery.skills = false;
    hasDiscovery = true;
  }
  if (hasDiscovery) (opts as Record<string, unknown>).discovery = discovery as DiscoveryOptions;

  // prompt will be set by caller after resolvePrompt
  return opts as unknown as TurnOptions;
};

export const parseRunExtra = (
  values: Record<string, unknown>,
): {
  cwd?: string;
  env?: Record<string, string>;
  resume?: string;
  timeoutSeconds?: number;
} => {
  const extra: {
    cwd?: string;
    env?: Record<string, string>;
    resume?: string;
    timeoutSeconds?: number;
  } = {};
  if (values.timeout !== undefined) {
    const n = Number(values.timeout);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: "claude",
        option: "maxSteps",
        supported: ["whole seconds, >= 0 (0 disables)"],
        detail: String(values.timeout),
      });
    }
    extra.timeoutSeconds = n;
  }
  if (values.cwd !== undefined) extra.cwd = String(values.cwd);
  if (values.resume !== undefined) extra.resume = String(values.resume);
  if (values["session-id"] !== undefined) extra.resume = String(values["session-id"]);
  if (values.env !== undefined) {
    // parseArgs with multiple:true gives string[] ; else string
    const list = values.env as string | string[];
    extra.env = parseEnvEntries(list);
  }
  return extra;
};

export interface CommonParseConfig {
  allowPrompt: boolean;
  allowPromptFile: boolean;
}

const KNOWN_FLAGS = new Set([
  "--prompt",
  "--prompt-file",
  "--model",
  "--effort",
  "--sandbox",
  "--provider",
  "--tools",
  "--exclude-tools",
  "--autonomy",
  "--no-autonomy",
  "--write",
  "--no-write",
  "--shell",
  "--no-shell",
  "--escalate-questions",
  "--no-escalate-questions",
  "--system-prompt",
  "--append-system-prompt",
  "--max-steps",
  "--no-tools",
  "--no-instruction-files",
  "--no-extensions",
  "--no-skills",
  "--cwd",
  "--env",
  "--resume",
  "--session-id",
  "--json",
  "--argv",
  "--help",
  "-h",
  "--version",
  "-V",
]);

const FLAGS_WITH_VALUE = new Set([
  "--prompt",
  "--prompt-file",
  "--model",
  "--effort",
  "--sandbox",
  "--provider",
  "--tools",
  "--exclude-tools",
  "--max-steps",
  "--cwd",
  "--env",
  "--resume",
  "--session-id",
  "--timeout",
]);

export const detectPositionalPromptInjection = (argv: string[]): string | null => {
  const hasExplicitPrompt = argv.some(
    (a) =>
      a === "--prompt" ||
      a.startsWith("--prompt=") ||
      a === "--prompt-file" ||
      a.startsWith("--prompt-file="),
  );
  if (hasExplicitPrompt) return null;
  let expectValue = false;
  for (const token of argv) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(token)) {
      expectValue = true;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      continue;
    }
    if (KNOWN_FLAGS.has(token)) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    // Only single-dash tokens are considered prompt injection candidates
    // Double-dash unknown flags (e.g. --unknown) are handled as unknown flag errors by parseArgs
    if (token.startsWith("-") && !token.startsWith("--")) {
      return token;
    }
  }
  return null;
};

const preprocessPromptArgs = (argv: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--prompt" && i + 1 < argv.length) {
      const next = argv[i + 1] as string;
      // If next starts with '-' and isn't '--', convert to --prompt=-value form so parseArgs accepts it
      if (next.startsWith("-") && next !== "--" && !next.startsWith("--prompt")) {
        out.push(`--prompt=${next}`);
        i++;
        continue;
      }
    }
    if (token.startsWith("--prompt=")) {
      out.push(token);
      continue;
    }
    out.push(token);
  }
  return out;
};

/**
 * Wrapper around node:util parseArgs for the common flag table.
 * Throws with exit code 2 on unknown flag.
 */
export interface SplitPassthrough {
  /** Tokens before the separator - hcn's normalized surface. */
  readonly normalized: string[];
  /** Tokens after the separator - verbatim passthrough to the harness,
   * empty when no separator was present. */
  readonly passthrough: readonly string[];
}

/** D6: split argv at the first bare `--`. Everything after it belongs to
 * the harness, not to hcn - wrong-harness flags there fail in the harness
 * itself and surface as native errors, never as hcn refusals. */
export const splitPassthrough = (argv: readonly string[]): SplitPassthrough => {
  const idx = argv.indexOf("--");
  if (idx === -1) return { normalized: [...argv], passthrough: [] };
  return {
    normalized: argv.slice(0, idx),
    passthrough: argv.slice(idx + 1),
  };
};

export const parseCommonFlags = (
  argv: string[],
  opts: { strict?: boolean } = {},
): ReturnType<typeof parseArgs> => {
  // The separator itself never reaches parseArgs: passthrough tokens may
  // be unknown to hcn by design (that is their purpose).
  const { normalized: withoutPassthrough } = splitPassthrough(argv);
  const normalized = preprocessPromptArgs(withoutPassthrough);
  const config = {
    allowPositionals: true,
    strict: opts.strict ?? true,
    options: {
      prompt: { type: "string" as const },
      "prompt-file": { type: "string" as const },
      model: { type: "string" as const },
      effort: { type: "string" as const },
      sandbox: { type: "string" as const },
      provider: { type: "string" as const },
      tools: { type: "string" as const },
      "exclude-tools": { type: "string" as const },
      skills: { type: "string" as const },
      autonomy: { type: "boolean" as const },
      "no-autonomy": { type: "boolean" as const },
      write: { type: "boolean" as const },
      "no-write": { type: "boolean" as const },
      shell: { type: "boolean" as const },
      "no-shell": { type: "boolean" as const },
      "escalate-questions": { type: "boolean" as const },
      "no-escalate-questions": { type: "boolean" as const },
      "system-prompt": { type: "string" as const },
      "append-system-prompt": { type: "string" as const },
      "max-steps": { type: "string" as const },
      "no-tools": { type: "boolean" as const },
      "no-instruction-files": { type: "boolean" as const },
      "no-extensions": { type: "boolean" as const },
      "no-skills": { type: "boolean" as const },
      cwd: { type: "string" as const },
      env: { type: "string" as const, multiple: true },
      resume: { type: "string" as const },
      "session-id": { type: "string" as const },
      timeout: { type: "string" as const },
      json: { type: "boolean" as const },
      argv: { type: "boolean" as const },
      help: { type: "boolean" as const },
      version: { type: "boolean" as const },
    },
  } as const;
  // parseArgs throws on unknown flag when strict true - we let it bubble and caller maps to exit 2
  return parseArgs({ ...config, args: normalized });
};
