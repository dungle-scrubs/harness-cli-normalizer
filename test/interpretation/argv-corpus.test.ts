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
  buildSpawnArgv,
  type SessionOptions,
  type SpawnArgvOptions,
  type TurnOptions,
} from "../../src/interpretation/argv.js";
import { buildContextInspectionArgv } from "../../src/interpretation/context-inspection.js";
import {
  type ConfigTiers,
  FloorExceededError,
  resolveEffectiveOptions,
} from "../../src/interpretation/resolve-options.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

// Cursor rows pin the launch shape (-p placement, prompt-first order,
// effort rendering zero tokens because slug resolution lives at the
// plan-turn step, autonomy as --force) and resume argv; the effort
// matrix itself lives at the resolver and plan-turn seams.
const HARNESSES: readonly HarnessDescriptor[] = [
  claudeCode,
  codexCli,
  piCli,
  museCode,
  cursorCli,
  antigravityCli,
  popeyeCli,
];
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
  ["tool-free", { prompt: "hi", isolation: "tool-free" }],
  [
    "tool-free-conflict",
    { prompt: "hi", isolation: "tool-free", discovery: { extensions: false } },
  ],
  ["model", { prompt: "hi", model: modelFor(h) }],
  ["effort-high", { prompt: "hi", effort: "high" }],
  ["effort-with-model", { prompt: "hi", model: modelFor(h), effort: "high" }],
  ["effort-unknown", { prompt: "hi", effort: "bogus" }],
  ["model-unknown", { prompt: "hi", model: "no-such-model" }],
  ["sandbox-read-only", { prompt: "hi", sandbox: "read-only" }],
  ["context-window", { prompt: "hi", contextWindow: 100000 }],
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

/** Resume-last cases (RFC-06 Phase 2): the observed grammars byte-for-byte
 * in turnTail order with the before-prompt segment in builder order. The
 * codex sandbox row pins the --sandbox/-s negatives (the resume spelling
 * is -c sandbox_mode, never --sandbox); the claude rows pin prompt before
 * the tool grant (probe 12b: prompt-after-tools is invalid); the muse and
 * cursor rows pin the unsupported-option refusal; the claude isolation row
 * pins the resume-phase refusal. */
const resumeLastCases = (
  h: HarnessDescriptor,
): ReadonlyArray<readonly [string, SpawnArgvOptions]> => {
  const base: ReadonlyArray<readonly [string, SpawnArgvOptions]> = [
    ["bare", { prompt: "hi", resumeLast: true }],
    ["model", { prompt: "hi", model: modelFor(h), resumeLast: true }],
  ];
  if (h.name === "claude") {
    return [
      ...base,
      ["tools", { prompt: "hi", tools: ["read", "shell"], resumeLast: true }],
      ["autonomy", { prompt: "hi", autonomy: true, resumeLast: true }],
      ["isolation-refuses", { prompt: "hi", isolation: "tool-free", resumeLast: true }],
    ];
  }
  if (h.name === "codex") {
    return [
      ...base,
      ["sandbox-read-only", { prompt: "hi", sandbox: "read-only", resumeLast: true }],
    ];
  }
  if (h.name === "pi") {
    return [...base, ["tools", { prompt: "hi", tools: ["read", "shell"], resumeLast: true }]];
  }
  if (h.name === "cursor") {
    // RFC-06 Phase 5: autonomy renders --force after the model per
    // turnTail; Phase 4 re-verifies the position live (probe 14 carried
    // --force before --continue).
    return [...base, ["autonomy", { prompt: "hi", autonomy: true, resumeLast: true }]];
  }
  return base;
};

/** Passthrough-tail cases (ADR 0003): a tail after hcn's bare `--`
 * reaches buildSpawnArgv on launch and resume alike. All six harnesses
 * declare after-argv placement, so every row carries the tail verbatim
 * past hcn's own argv; a prompt-joins harness would refuse instead (none
 * declares it today - that refusal is pinned in
 * argv-passthrough-placement). */
const passthroughCases = (): ReadonlyArray<readonly [string, SpawnArgvOptions]> => [
  ["empty", { prompt: "hi", passthrough: [] }],
  ["tail", { prompt: "hi", passthrough: ["--native-flag"] }],
  [
    "tail-resume",
    {
      prompt: "hi",
      resume: "0199a4c5-1111-2222-3333-444455556666",
      passthrough: ["--native-flag"],
    },
  ],
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
  const corpus: {
    launch: Record<string, Record<string, Outcome>>;
    resume: Record<string, Record<string, Outcome>>;
    resumeLast: Record<string, Record<string, Outcome>>;
    passthrough: Record<string, Record<string, Outcome>>;
    session: Record<string, Record<string, Outcome>>;
    resolve: Record<string, Record<string, Outcome>>;
  } = {
    launch: {},
    resume: {},
    resumeLast: {},
    passthrough: {},
    session: {},
    resolve: {},
  };
  for (const h of HARNESSES) {
    const launch: Record<string, Outcome> = {};
    const resume: Record<string, Outcome> = {};
    const resumeLast: Record<string, Outcome> = {};
    const passthrough: Record<string, Outcome> = {};
    const session: Record<string, Outcome> = {};
    const resolve: Record<string, Outcome> = {};
    corpus.launch[h.name] = launch;
    corpus.resume[h.name] = resume;
    corpus.resumeLast[h.name] = resumeLast;
    corpus.passthrough[h.name] = passthrough;
    corpus.session[h.name] = session;
    corpus.resolve[h.name] = resolve;
    for (const [label, opts] of turnCases(h)) {
      launch[label] = outcomeOf(() => ({ argv: buildLaunchArgv(h, opts) }));
      resume[label] = outcomeOf(() => ({
        argv: buildResumeArgv(h, { ...opts, sessionId: SESSION_ID }),
      }));
    }
    for (const [label, opts] of resumeLastCases(h)) {
      resumeLast[label] = outcomeOf(() => ({ argv: buildSpawnArgv(h, opts) }));
    }
    // Most-recent and a named id refuse together, through the same owner.
    resumeLast["id-and-last-refuse"] = outcomeOf(() => ({
      argv: buildSpawnArgv(h, { prompt: "hi", resume: SESSION_ID, resumeLast: true }),
    }));
    if (h.name === "claude") {
      // inspect --context --resume-last carries exactly one --fork-session:
      // the resume-last builder renders it and context inspection appends
      // nothing on the id-less path.
      resumeLast["inspect-context"] = outcomeOf(() => ({
        argv: buildContextInspectionArgv(h, { prompt: "hi", resumeLast: true }),
      }));
    }
    for (const [label, opts] of passthroughCases()) {
      passthrough[label] = outcomeOf(() => ({ argv: buildSpawnArgv(h, opts) }));
    }
    for (const [label, opts] of sessionCases(h)) {
      session[label] = outcomeOf(() => ({ argv: buildSessionArgv(h, opts) }));
    }
    for (const [label, args, tiers] of resolveCases()) {
      resolve[label] = outcomeOf(() => {
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
