import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Interruption-contract gate (round-5 Quality Q1, a repeat of the AGENTS.md
 * requirement to audit the hcn skill's event contracts when hcn changes):
 * the GENERAL interruption definitions in docs/reference.md and the hcn
 * skill reference must state the SDK-era receipt semantics, because the
 * f821996 wording defined `interrupted` as an aborted run only and read a
 * normal completion before the acknowledgement as `not-active` without
 * an accepted acknowledgement. The checker reads only the general
 * "Delivery and interruption" section of each document - not the whole
 * file - so harness-specific notes (harness-notes.md carries the Cursor
 * startup explanation) cannot make a stale general definition pass. The
 * definition paragraph is anchored to its known lead-in (not "first
 * paragraph naming both states"), and each state is checked against the
 * semicolon-separated clause that defines it, so neither a preceding
 * correct note nor a label swap can pass a stale definition (round-6
 * hardening, tests J2 and panel A finding 3). The negative cases replay
 * the exact f821 paragraphs, so a checker that finds nothing can never
 * pass this gate.
 */

const repoRoot = resolve(import.meta.dirname, "../..");

/** Word gaps accept the documents' hard line wrapping. */
const wrapped = (phrase: string): RegExp => new RegExp(phrase.split(/ /).join("\\s+"));

/** The documents whose general interruption definitions this gate reads.
 * The anchor pins the definition paragraph to its known lead-in, so a
 * correct harness note placed before a stale definition cannot be checked
 * in its place. */
const DOCUMENTS = [
  {
    label: "docs/reference.md",
    path: resolve(repoRoot, "docs/reference.md"),
    anchor: wrapped("Exactly one terminal receipt"),
  },
  {
    label: "skills/hcn/references/reference.md",
    path: resolve(repoRoot, "skills/hcn/references/reference.md"),
    anchor: wrapped("Wait for its terminal state"),
  },
] as const;

type DocumentSpec = (typeof DOCUMENTS)[number];

const DOCS: DocumentSpec = DOCUMENTS[0];
const SKILL: DocumentSpec = DOCUMENTS[1];

const RUNNER_PATH = resolve(repoRoot, "src/execution/open-session.ts");

/** The general interruption section: the heading names it, the next
 * heading of any level ends it. */
const generalInterruptionSection = (text: string): string | null => {
  const heading = /^#{2,4} +Delivery and interruption[^\n]*$/m.exec(text);
  if (heading === null) return null;
  const rest = text.slice((heading.index ?? 0) + heading[0].length);
  const next = /^#{2,4} +[^\n]*$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};

/** The paragraph that defines the terminal receipt states, pinned to its
 * known lead-in (the document's anchor above), not to "first paragraph
 * naming both states": a preceding harness note that happens to name both
 * states cannot stand in for a stale definition. Splitting on blank lines
 * keeps harness tables and exception paragraphs beside the definition out
 * of the check. */
const definitionParagraph = (section: string, anchor: RegExp): string | null => {
  for (const paragraph of section.split(/\n\n+/)) {
    if (anchor.test(paragraph)) {
      return paragraph;
    }
  }
  return null;
};

/** The definition's first sentence is a list of semicolon-separated state
 * clauses. Splitting on periods AND semicolons keeps each state bound to
 * the clause that defines it, so swapping two state labels cannot satisfy
 * the other state's check. */
const clausesOf = (paragraph: string): readonly string[] =>
  paragraph
    .split(/[.;]\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");

const hasClause = (paragraph: string, need: readonly RegExp[]): boolean =>
  clausesOf(paragraph).some((clause) => need.every((re) => re.test(clause)));

/** Issues in one document's general interruption definition. Each issue
 * names the document and says how to fix the definition. */
const interruptionDefinitionIssues = (doc: DocumentSpec, text: string): readonly string[] => {
  const label = doc.label;
  const issues: string[] = [];
  const section = generalInterruptionSection(text);
  if (section === null) {
    return [
      `${label}: no "Delivery and interruption" section found. Restore the general interruption section heading so the receipt states stay defined in one place.`,
    ];
  }
  const paragraph = definitionParagraph(section, doc.anchor);
  if (paragraph === null) {
    return [
      `${label}: the "Delivery and interruption" section has no definition paragraph carrying its lead-in. Restore the general terminal-receipt definition paragraph so the receipt states stay defined in one place.`,
    ];
  }
  if (
    !hasClause(paragraph, [/`interrupted`/, /abort/, /cancel/, wrapped("before any run started")])
  ) {
    issues.push(
      `${label}: the general interruption definition does not say that \`interrupted\` also covers a deferred input cancelled before any run started. Fix the definition paragraph in the "Delivery and interruption" section so the \`interrupted\` clause names the aborted run and the deferred-input cancellation.`,
    );
  }
  if (
    !hasClause(paragraph, [
      /`not-active`/,
      /acknowledgement/,
      wrapped("an accepted acknowledgement"),
    ])
  ) {
    issues.push(
      `${label}: the general interruption definition reads a normal completion before the acknowledgement as \`not-active\` without requiring the acknowledgement to be accepted. Qualify the normal-completion \`not-active\` rule with an accepted acknowledgement.`,
    );
  }
  if (!hasClause(paragraph, [/`not-active`/, /(?:no-target\s+idle|idle\s+decline)/])) {
    issues.push(
      `${label}: the general interruption definition does not keep a worker's explicit no-target idle decline in \`not-active\`. Name the idle decline inside the \`not-active\` definition clause.`,
    );
  }
  if (!hasClause(paragraph, [/refus/, /`rejected`/, /first/])) {
    issues.push(
      `${label}: the general interruption definition does not state the refusal-order rule. Add the sentence keeping a refused request \`rejected\` even when the run's completion arrives first.`,
    );
  }
  return issues;
};

/** The doc comment above SessionInterruptReceipt must carry the same
 * definition the documents state. */
const receiptCommentIssues = (label: string, source: string): readonly string[] => {
  const issues: string[] = [];
  const anchor = source.indexOf("export interface SessionInterruptReceipt");
  if (anchor === -1) {
    return [`${label}: SessionInterruptReceipt is gone; restore it with its documented states.`];
  }
  const before = source.slice(0, anchor);
  const start = before.lastIndexOf("/**");
  // Comment continuation lines carry " * " markers; fold them so word-gap
  // checks see one flowing sentence.
  const comment = (start === -1 ? "" : before.slice(start)).replace(/\n\s*\*\s?/g, " ");
  if (
    !wrapped("before any run started").test(comment) ||
    !/abort/.test(comment) ||
    !/cancel/.test(comment)
  ) {
    issues.push(
      `${label}: the SessionInterruptReceipt doc comment does not say \`interrupted\` also covers deferred input cancelled before any run started. Fix the comment in src/execution/open-session.ts to match the general definition.`,
    );
  }
  if (!/accepted/.test(comment) || !/idle/.test(comment) || !/no[ -]target/.test(comment)) {
    issues.push(
      `${label}: the SessionInterruptReceipt doc comment does not qualify \`not-active\` with an accepted acknowledgement and the worker's explicit no-target idle decline. Fix the comment in src/execution/open-session.ts to match the general definition.`,
    );
  }
  if (!/refus[\s\S]*`rejected`[\s\S]*first/.test(comment)) {
    issues.push(
      `${label}: the SessionInterruptReceipt doc comment does not state that a refused request stays \`rejected\` even when the run's completion arrives first. Fix the comment in src/execution/open-session.ts.`,
    );
  }
  return issues;
};

/** The exact f821996 definition paragraph from docs/reference.md, kept
 * here so the gate can never pass by finding nothing to check. */
const F821_DOCS_PARAGRAPH = `Exactly one terminal receipt follows \`requested\`: \`interrupted\` when the harness
reports an aborted run, \`not-active\` when work settled normally or no run was
active, or \`rejected\` with reason \`closed\` or \`native-rejected\`. The receipt
describes the turn that was running when hcn wrote the request, never a later
one: a request written while idle reports \`not-active\`, and a target turn that
settled normally before its acknowledgement reports \`not-active\` even if another turn
is running or aborted when the acknowledgement arrives. An already closed session,
unsupported interruption or failed write is rejected immediately, with reason
\`closed\`, \`unsupported\` or \`write-failed\`. A successful native command response alone is not confirmation
of interruption. Interrupt rejection logs carry correlation metadata, without native error text.
An interrupt carrying \`text\` is malformed; send the replacement
as a new \`send\` after the terminal receipt.`;

/** The exact f821996 definition paragraph from the skill reference. */
const F821_SKILL_PARAGRAPH = `Send \`{"op":"interrupt","id":"stop-1"}\` without replacement text. A written
request emits \`interruption\` state \`requested\`. Wait for its terminal state:
\`interrupted\` confirms a native aborted run; \`not-active\` means work settled
normally or none was active; \`rejected\` carries \`unsupported\`, \`closed\`,
\`write-failed\` or \`native-rejected\`. An immediate refusal has no \`requested\`
phase. A native success response alone does not confirm interruption. The
receipt describes the turn running when the request was written: a request
written while idle, or whose turn settled normally before the acknowledgement, is
\`not-active\` even if a later turn is running or aborted by then.`;

const asSection = (paragraph: string): string =>
  `## Delivery and interruption\n\n${paragraph}\n\n## After\n`;

const STANDARDIZED_PARAGRAPH = `Exactly one terminal receipt follows \`requested\`: \`interrupted\` when the
harness aborted the active run, or when a deferred input was cancelled
before any run started; \`not-active\` when the worker reports an explicit
no-target idle decline, or when an accepted request cancelled no run because
the target had settled normally or was idle; or \`rejected\` with reason
\`closed\` or \`native-rejected\`. The receipt
describes the turn that was running when hcn wrote the request, never a later
one: an accepted request written while idle reports \`not-active\`, and a target turn that
settled normally before an accepted acknowledgement reports \`not-active\` even if another turn
is running or aborted when the acknowledgement arrives. A request the harness
refused stays \`rejected\` even when the run's completion arrives first.`;

const STANDARDIZED_COMMENT = `/** The terminal outcome of an interrupt request (issue #426). \`interrupted\`
 * is the harness's own report that the active run was aborted, or that a
 * deferred input was cancelled before any run started; command acceptance
 * alone is never read as one. \`not-active\` means an accepted request
 * cancelled no run (the target had settled or was idle), or the worker
 * explicitly declined because it had no target. A refused request
 * stays \`rejected\` even when the run's completion arrives first. */`;

describe("interruption contract", () => {
  for (const { label, path, anchor } of DOCUMENTS) {
    it(`defines the receipt states for deferred input and refusal order (${label})`, () => {
      const issues = interruptionDefinitionIssues(
        { label, path, anchor },
        readFileSync(path, "utf8"),
      );
      expect(issues, issues.join("\n")).toEqual([]);
    });
  }

  it("the SessionInterruptReceipt comment matches the general definition", () => {
    const issues = receiptCommentIssues(
      "src/execution/open-session.ts",
      readFileSync(RUNNER_PATH, "utf8"),
    );
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("rejects the exact f821 docs paragraph", () => {
    const issues = interruptionDefinitionIssues(DOCS, asSection(F821_DOCS_PARAGRAPH));
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.join("\n")).toContain("deferred input cancelled before any run started");
    expect(issues.join("\n")).toContain("accepted acknowledgement");
    expect(issues.join("\n")).toContain("idle decline");
    expect(issues.join("\n")).toContain("refusal-order");
  });

  it("rejects the exact f821 skill paragraph", () => {
    expect(
      interruptionDefinitionIssues(SKILL, asSection(F821_SKILL_PARAGRAPH)).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("rejects the f821 definition even beside a separate exception paragraph", () => {
    // The exception may not live in a different paragraph: the definition
    // paragraph itself must carry the deferred-input coverage.
    const withException = asSection(
      `${F821_DOCS_PARAGRAPH}\n\nDuring SDK startup an interrupt cancels the deferred input before any run started and reports \`interrupted\`.`,
    );
    expect(interruptionDefinitionIssues(DOCS, withException).join("\n")).toContain(
      "deferred input cancelled before any run started",
    );
  });

  it("rejects a definition that swaps the interrupted and not-active labels", () => {
    // Round-6 hardening (tests J2): with period-only sentence splitting,
    // swapping the two state labels inside the real definition sentence
    // still passed every check, because the sentence kept all keywords.
    // Each state must be bound to the clause that defines it.
    const swapped = STANDARDIZED_PARAGRAPH.replace(
      "`interrupted` when the\nharness aborted the active run",
      "`not-active` when the\nharness aborted the active run",
    ).replace(
      "`not-active` when the worker reports an explicit\nno-target idle decline",
      "`interrupted` when the worker reports an explicit\nno-target idle decline",
    );
    const issues = interruptionDefinitionIssues(DOCS, asSection(swapped));
    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("deferred input cancelled before any run started");
    expect(issues.join("\n")).toContain("no-target idle decline");
  });

  it("rejects a stale definition even when a correct note precedes it", () => {
    // Round-6 hardening (panel A finding 3): the definition paragraph is
    // anchored to its lead-in, not "first paragraph naming both states" -
    // a correct harness note before a stale definition must not satisfy
    // the gate for it. The note below passes every check on its own.
    const note =
      "The SDK worker's receipts follow the general rule: `interrupted` covers an aborted run or a deferred input cancelled before any run started; `not-active` covers a worker's no-target idle decline. A target that settled normally before an accepted acknowledgement reports `not-active`, and a refused request stays `rejected` even when the run's completion arrives first.";
    // The note alone satisfies every substantive check (anchored to its
    // own lead-in), so only the docs lead-in anchor keeps it from standing
    // in for the stale definition that follows it.
    const noteDoc: DocumentSpec = {
      label: DOCS.label,
      path: DOCS.path,
      anchor: wrapped("The SDK worker's receipts"),
    };
    expect(interruptionDefinitionIssues(noteDoc, asSection(note))).toEqual([]);
    const issues = interruptionDefinitionIssues(
      DOCS,
      asSection(`${note}\n\n${F821_DOCS_PARAGRAPH}`),
    );
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.join("\n")).toContain("deferred input cancelled before any run started");
  });

  it("rejects a definition that drops only the refusal-order sentence", () => {
    const dropped = STANDARDIZED_PARAGRAPH.replace(
      "refused stays `rejected` even when the run's completion arrives first.",
      "settled without a cancellation.",
    );
    const issues = interruptionDefinitionIssues(DOCS, asSection(dropped));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refusal-order");
  });

  it("rejects a definition that drops only the accepted-acknowledgement qualifier", () => {
    const dropped = STANDARDIZED_PARAGRAPH.replace(
      "an accepted acknowledgement",
      "its acknowledgement",
    );
    const issues = interruptionDefinitionIssues(DOCS, asSection(dropped));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("accepted acknowledgement");
  });

  it("rejects a definition that drops only the deferred-input clause", () => {
    const dropped = STANDARDIZED_PARAGRAPH.replace(
      ", or when a deferred input was cancelled\nbefore any run started;",
      ";",
    );
    const issues = interruptionDefinitionIssues(DOCS, asSection(dropped));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("deferred input cancelled before any run started");
  });

  it("rejects a definition that drops only the idle clause", () => {
    const dropped = STANDARDIZED_PARAGRAPH.replace(
      "the worker reports an explicit\nno-target idle decline, or when ",
      "",
    );
    const issues = interruptionDefinitionIssues(DOCS, asSection(dropped));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("idle decline");
  });

  it("accepts the standardized definition paragraph", () => {
    expect(interruptionDefinitionIssues(DOCS, asSection(STANDARDIZED_PARAGRAPH))).toEqual([]);
  });

  it("rejects a stale SessionInterruptReceipt comment", () => {
    const stale = `/** The terminal outcome of an interrupt request (issue #426). \`interrupted\`
 * is the harness's own report that the active run was cancelled; command
 * acceptance alone is never read as one. \`not-active\` means the harness
 * reported no run cancelled (it had already settled, or was idle). */`;
    expect(
      receiptCommentIssues(
        "src/execution/open-session.ts",
        `${stale}
export interface SessionInterruptReceipt {
`,
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("rejects a comment that drops only the worker's no-target decline", () => {
    // Round-6 hardening (panel A finding 3): the /idle/ check was
    // satisfied by "was idle" alone, so deleting the worker's explicit
    // no-target decline still passed. The decline must be named.
    const dropped = STANDARDIZED_COMMENT.replace(
      ", or the worker\n * explicitly declined because it had no target",
      "",
    );
    const issues = receiptCommentIssues(
      "src/execution/open-session.ts",
      `${dropped}\nexport interface SessionInterruptReceipt {\n`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("no-target");
  });

  it("accepts the standardized SessionInterruptReceipt comment", () => {
    expect(
      receiptCommentIssues(
        "src/execution/open-session.ts",
        `${STANDARDIZED_COMMENT}\nexport interface SessionInterruptReceipt {\n`,
      ),
    ).toEqual([]);
  });
});
