/**
 * The argv snapshot corpus (RFC-02, Testing Strategy item 1). Every
 * harness, launch and resume and session, across a matrix of turn
 * options, plus option resolution with config tiers - compared against a
 * committed snapshot captured before the one-owner-per-rule refactor.
 *
 * A refusal is part of the contract too, so a case that refuses records
 * the structured refusal instead of an argv.
 *
 * Regenerate deliberately, never by accident:
 *   HCN_UPDATE_ARGV_CORPUS=1 pnpm vitest run test/interpretation/argv-corpus.test.ts
 * and explain every changed line in the commit that carries it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ArgvRefusalError,
  buildLaunchArgv,
  buildResumeArgv,
  buildSessionArgv,
  type SessionOptions,
  type TurnOptions,
} from "../../src/interpretation/argv.js";
import {
  type ConfigTiers,
  FloorExceededError,
  resolveEffectiveOptions,
} from "../../src/interpretation/resolve-options.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const HARNESSES: readonly HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];
const SESSION_ID = "0199a4c5-1111-2222-3333-444455556666";
const SNAPSHOT = join(import.meta.dirname, "argv-corpus.snapshot.json");

/** A curated model per harness, spelled the way a caller would type it. */
const modelFor = (h: HarnessDescriptor): string =>
  h.name === "claude" ? "sonnet" : (h.vocabulary.models[0] as string);

/** The merged shape a turn option carries (RFC-02 change 8). */
const TOOL_MAP = {
  pi: { "web-search": { native: "web_search", tier: "user-config" } },
  muse: { "web-search": { native: "web_search", tier: "user-config" } },
} as const;

/** Turn-option cases, one per dimension at a non-default value. */
const turnCases = (h: HarnessDescriptor): ReadonlyArray<readonly [string, TurnOptions]> => [
  ["bare", { prompt: "hi" }],
  ["model", { prompt: "hi", model: modelFor(h) }],
  ["effort-high", { prompt: "hi", effort: "high" }],
  ["effort-with-model", { prompt: "hi", model: modelFor(h), effort: "high" }],
  ["effort-unknown", { prompt: "hi", effort: "bogus" }],
  ["model-unknown", { prompt: "hi", model: "no-such-model" }],
  ["sandbox-read-only", { prompt: "hi", sandbox: "read-only" }],
  ["provider", { prompt: "hi", provider: "zai" }],
  ["no-tools", { prompt: "hi", discovery: { tools: false } }],
  ["no-instruction-files", { prompt: "hi", discovery: { instructionFiles: false } }],
  ["no-extensions", { prompt: "hi", discovery: { extensions: false } }],
  ["no-skills", { prompt: "hi", discovery: { skills: false } }],
  ["discovery-all-on", { prompt: "hi", discovery: { tools: true, skills: true } }],
  ["write-off", { prompt: "hi", write: false }],
  ["shell-off", { prompt: "hi", shell: false }],
  ["max-steps", { prompt: "hi", maxSteps: 5 }],
  ["system-prompt", { prompt: "hi", systemPrompt: "you are terse" }],
  ["append-system-prompt", { prompt: "hi", appendSystemPrompt: "and polite" }],
  ["access-read", { prompt: "hi", access: "read" }],
  ["access-write", { prompt: "hi", access: "write" }],
  ["access-read-no-tools", { prompt: "hi", access: "read", discovery: { tools: false } }],
  ["tools-include", { prompt: "hi", tools: ["read", "shell"] }],
  ["tools-include-native", { prompt: "hi", tools: ["read", "native:web_search"] }],
  ["tools-include-empty", { prompt: "hi", tools: [] }],
  ["tools-exclude", { prompt: "hi", excludeTools: ["shell"] }],
  ["tools-exclude-native", { prompt: "hi", excludeTools: ["native:web_search"] }],
  ["tools-both", { prompt: "hi", tools: ["read"], excludeTools: ["shell"] }],
  ["tools-via-toolmap", { prompt: "hi", tools: ["web-search"], toolMap: TOOL_MAP }],
  ["tools-unknown-name", { prompt: "hi", tools: ["frobnicate"] }],
  ["skills-pick", { prompt: "hi", skills: { picks: ["/registry/hcn"], known: ["hcn", "other"] } }],
  ["autonomy", { prompt: "hi", autonomy: true }],
  ["explicit-dash-prompt", { prompt: { text: "-x", explicit: true } }],
  ["implicit-dash-prompt", { prompt: "-x" }],
];

const sessionCases = (h: HarnessDescriptor): ReadonlyArray<readonly [string, SessionOptions]> => [
  ["fresh", { sessionId: SESSION_ID }],
  ["model", { sessionId: SESSION_ID, model: modelFor(h) }],
  ["effort", { sessionId: SESSION_ID, effort: "high" }],
  ["model-effort", { sessionId: SESSION_ID, model: modelFor(h), effort: "high" }],
  ["provider", { sessionId: SESSION_ID, provider: "zai" }],
  ["resume", { sessionId: SESSION_ID, isResume: true }],
  ["bad-id", { sessionId: "../etc" }],
];

const resolveCases = (): ReadonlyArray<readonly [string, TurnOptions, ConfigTiers]> => [
  ["bare", { prompt: "hi" }, {}],
  ["access-read", { prompt: "hi", access: "read" }, {}],
  ["access-read-explicit-sandbox", { prompt: "hi", access: "read", sandbox: "read-only" }, {}],
  [
    "access-read-config-sandbox",
    { prompt: "hi", access: "read" },
    { user: { sandbox: "read-only" } },
  ],
  ["access-and-tools", { prompt: "hi", access: "read", tools: ["read"] }, {}],
  ["access-from-project", { prompt: "hi" }, { project: { access: "read" } }],
  ["access-invalid", { prompt: "hi", access: "rw" as "read" }, {}],
  [
    "tools-within-floor",
    { prompt: "hi", tools: ["read"] },
    { project: { tools: ["read", "grep"] } },
  ],
  [
    "tools-exceeds-floor",
    { prompt: "hi", tools: ["read", "shell"] },
    { project: { tools: ["read"] } },
  ],
  ["tools-empty-floor", { prompt: "hi", tools: ["read"] }, { project: { tools: [] } }],
  [
    "toolset",
    { prompt: "hi", tools: ["review"] },
    { user: { toolsets: { review: ["read", "grep"] } } as ConfigTiers["user"] },
  ],
  [
    "toolmap-tiers",
    { prompt: "hi" },
    {
      user: { toolMap: { pi: { "web-search": "ws_user" } } } as ConfigTiers["user"],
      project: { toolMap: { pi: { "web-search": "ws_project" } } } as ConfigTiers["project"],
    },
  ],
  ["discovery-tools-off", { prompt: "hi", discovery: { tools: false } }, {}],
  ["effort-tiers", { prompt: "hi" }, { user: { effort: "high" }, project: { effort: "low" } }],
  ["effort-arg-wins", { prompt: "hi", effort: "max" }, { user: { effort: "high" } }],
  [
    "behaviour-keys",
    { prompt: "hi" },
    { user: { questions: "assume", timeout: 30 } as ConfigTiers["user"] },
  ],
];

type Outcome =
  | { readonly argv: readonly string[] }
  | { readonly refusal: Record<string, unknown> }
  | { readonly resolved: Record<string, unknown> };

const outcomeOf = (work: () => Outcome): Outcome => {
  try {
    return work();
  } catch (e) {
    if (e instanceof ArgvRefusalError) {
      return {
        refusal: {
          issue: e.issue,
          harness: e.harness,
          option: e.option,
          facet: e.facet,
          supported: e.supported,
          supportedBy: e.supportedBy,
          hint: e.hint,
          message: e.message,
        },
      };
    }
    if (e instanceof FloorExceededError) {
      return { refusal: { name: e.name, excess: e.excess, floor: e.floor, message: e.message } };
    }
    throw e;
  }
};

const buildCorpus = (): Record<string, unknown> => {
  const corpus: Record<string, Record<string, Record<string, Outcome>>> = {
    launch: {},
    resume: {},
    session: {},
    resolve: {},
  };
  for (const h of HARNESSES) {
    corpus.launch![h.name] = {};
    corpus.resume![h.name] = {};
    corpus.session![h.name] = {};
    corpus.resolve![h.name] = {};
    for (const [label, opts] of turnCases(h)) {
      corpus.launch![h.name]![label] = outcomeOf(() => ({ argv: buildLaunchArgv(h, opts) }));
      corpus.resume![h.name]![label] = outcomeOf(() => ({
        argv: buildResumeArgv(h, { ...opts, sessionId: SESSION_ID }),
      }));
    }
    for (const [label, opts] of sessionCases(h)) {
      corpus.session![h.name]![label] = outcomeOf(() => ({ argv: buildSessionArgv(h, opts) }));
    }
    for (const [label, args, tiers] of resolveCases()) {
      corpus.resolve![h.name]![label] = outcomeOf(() => {
        const r = resolveEffectiveOptions(h, args, tiers);
        const { prompt: _prompt, ...options } = r.options;
        return { resolved: { options, provenance: r.provenance, unrenderable: r.unrenderable } };
      });
    }
  }
  return corpus;
};

describe("argv corpus", () => {
  test("every harness, phase, and option renders exactly as the committed snapshot", () => {
    const actual = buildCorpus();
    if (process.env.HCN_UPDATE_ARGV_CORPUS === "1") {
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as unknown;
    expect(actual).toEqual(expected);
  });
});
