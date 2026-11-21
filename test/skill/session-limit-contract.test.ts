import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Session-limit contract gate (round-6 panel A finding 1, spec X1, tests
 * J1-r6 - a repeat of the AGENTS.md requirement to audit the hcn skill's
 * event contracts when hcn changes): a refusal whose text classifies as a
 * rate-limit, usage-limit or quota wall now ends the turn it refused with
 * `done` cause `limit` and closes the session `limit`, and the
 * session-level limit cause persists even if later turns succeed. The
 * de7584c refusal sentences still promised `failed`/`clean` unconditionally.
 * The checker reads ONLY the `closed.cause` bullet of docs/reference.md and
 * the refusals row of the hcn skill reference - not the whole files, where
 * unrelated limit mentions (stderr walls, stall budgets) would mask a stale
 * refusal claim - and requires each formerly unconditional
 * refused-opener / refused-session-open claim to carry its own limit
 * exception, plus the sticky session limit cause on the refused-opener
 * claim. The negative cases replay the exact de7584c phrasing and
 * single-clause drops, so a checker that finds nothing to check can never
 * pass this gate. This is session-mode behavior only; run mode's own limit
 * classification is not claimed here.
 */

const repoRoot = resolve(import.meta.dirname, "../..");

const DOCS_PATH = resolve(repoRoot, "docs/reference.md");
const SKILL_PATH = resolve(repoRoot, "skills/hcn/references/reference.md");

/** Word gaps accept the documents' hard line wrapping. */
const wrapped = (phrase: string): RegExp => new RegExp(phrase.split(/ /).join("\\s+"));

const LIMIT_CLASSES = wrapped("rate-limit, usage-limit or quota");
const LIMIT_PRECEDENCE = wrapped("takes limit precedence");
const SESSION_PERSISTENCE = wrapped("persists even if later turns succeed");

/** The `closed.cause` bullet of docs/reference.md: the line that opens it,
 * through to the bullet list's next blank line. Nothing else is read. */
const closedCauseBullet = (text: string): string | null => {
  const start = /^- `closed\.cause` is one of/m.exec(text);
  if (start === null) return null;
  const rest = text.slice((start.index ?? 0) + start[0].length);
  const end = /\n\n/.exec(rest);
  return rest.slice(0, end === null ? rest.length : end.index);
};

/** The refusals row of the skill reference: one physical table line. */
const refusalsRow = (text: string): string | null => {
  const row = /^\| refusals \|.*/m.exec(text);
  return row === null ? null : row[0];
};

const sentencesOf = (text: string): readonly string[] =>
  text
    .split(/\.\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

/** The sentence that carries one refusal claim, so the limit exception is
 * checked inside the claim's own sentence, not against the whole bullet -
 * where unrelated limit mentions would mask a stale refusal claim. */
const sentenceWith = (text: string, anchor: RegExp): string | null => {
  for (const sentence of sentencesOf(text)) {
    if (anchor.test(sentence)) return sentence;
  }
  return null;
};

/** Issues in the docs bullet's two refusal claims. */
const docsIssues = (bullet: string | null): readonly string[] => {
  if (bullet === null) {
    return [
      "docs/reference.md: no `closed.cause` bullet found. Restore it so the refused-command outcomes stay defined in one place.",
    ];
  }
  const issues: string[] = [];
  const sessionOpen = sentenceWith(bullet, wrapped("refused hcn's session open"));
  if (sessionOpen === null) {
    issues.push(
      "docs/reference.md: the `closed.cause` bullet no longer states the refused session open outcome. Restore the sentence naming `failed` for a refused hcn session open.",
    );
  } else if (
    !/unless/.test(sessionOpen) ||
    !LIMIT_CLASSES.test(sessionOpen) ||
    !LIMIT_PRECEDENCE.test(sessionOpen) ||
    !wrapped("cause `limit`").test(sessionOpen)
  ) {
    issues.push(
      "docs/reference.md: the refused session open sentence in the `closed.cause` bullet promises cause `failed` with no limit exception. Qualify that sentence itself: a rate-limit, usage-limit or quota refusal takes limit precedence and `closed` reports cause `limit` (exit 1).",
    );
  }
  const refusedPrompt = sentenceWith(bullet, wrapped("A refused prompt"));
  if (refusedPrompt === null) {
    issues.push(
      "docs/reference.md: the `closed.cause` bullet no longer states the refused prompt (refused opener) outcome. Restore the sentence naming `done` cause `failed` for pi's refused `prompt`.",
    );
  } else if (
    !/unless/.test(refusedPrompt) ||
    !LIMIT_CLASSES.test(refusedPrompt) ||
    !LIMIT_PRECEDENCE.test(refusedPrompt) ||
    !wrapped("cause `limit`").test(refusedPrompt) ||
    !SESSION_PERSISTENCE.test(refusedPrompt)
  ) {
    issues.push(
      "docs/reference.md: the refused prompt sentence in the `closed.cause` bullet promises `done` cause `failed` and `closed` cause `clean` with no limit exception. Qualify that sentence itself: a rate-limit, usage-limit or quota refusal takes limit precedence (turn `done` cause `limit`, session closes `limit`), and the session-level limit cause persists even if later turns succeed.",
    );
  }
  return issues;
};

/** Issues in the skill row's two refusal claims. */
const skillIssues = (row: string | null): readonly string[] => {
  if (row === null) {
    return [
      "skills/hcn/references/reference.md: no refusals row found. Restore it so the session refusal outcomes stay defined in one place.",
    ];
  }
  const issues: string[] = [];
  const opener = sentenceWith(row, wrapped("refuses the command that opened a turn"));
  if (opener === null) {
    issues.push(
      "skills/hcn/references/reference.md: the refusals row no longer states the refused-opener outcome. Restore the sentence naming `done` cause `failed` for a refused command that opened a turn.",
    );
  } else if (
    !/unless/.test(opener) ||
    !LIMIT_CLASSES.test(opener) ||
    !LIMIT_PRECEDENCE.test(opener) ||
    !wrapped("cause `limit`").test(opener) ||
    !SESSION_PERSISTENCE.test(opener)
  ) {
    issues.push(
      "skills/hcn/references/reference.md: the refusals row's refused-opener sentence promises `done` cause `failed` with no limit exception. Qualify that sentence itself: a rate-limit, usage-limit or quota refusal takes limit precedence (turn `done` cause `limit`, session closes `limit`), and the session-level limit cause persists even if later turns succeed.",
    );
  }
  const sessionOpen = sentenceWith(row, wrapped("A refused session open"));
  if (sessionOpen === null) {
    issues.push(
      "skills/hcn/references/reference.md: the refusals row no longer states the refused session open outcome. Restore the sentence naming `closed` cause `failed` for a refused session open.",
    );
  } else if (
    !/unless/.test(sessionOpen) ||
    !LIMIT_CLASSES.test(sessionOpen) ||
    !LIMIT_PRECEDENCE.test(sessionOpen) ||
    !wrapped("cause `limit`").test(sessionOpen)
  ) {
    issues.push(
      "skills/hcn/references/reference.md: the refusals row's refused session open sentence promises `closed` cause `failed` (exit 1) with no limit exception. Qualify that sentence itself: a rate-limit, usage-limit or quota refusal takes limit precedence and `closed` reports cause `limit` (exit 1).",
    );
  }
  return issues;
};

/** The exact de7584c `closed.cause` bullet refusal claims, kept here so the
 * gate can never pass by finding nothing to check. */
const DE7584_DOCS_BULLET = `- \`closed.cause\` is one of \`clean\`, \`limit\`, \`crash\`, \`stall\`, \`killed\`,
  \`failed\`. \`failed\` is the cause when the harness refused hcn's
  session open (codex answering \`thread/start\` with an error, popeye
  refusing \`create\`) and then exited cleanly; codex rejects the waiting
  send with reason \`native-rejected\`, and popeye ends the waiting send's
  turn with the failure. A limit wall on stderr still ends the turn as
  \`limit\`. A refused prompt (pi's
  \`prompt\` answered \`success: false\`) ends its turn with \`done\` cause
  \`failed\` carrying the failure; the closed event that follows has
  cause \`clean\` when the harness then exits 0 on stdin EOF.`;

/** The exact de7584c refusals row of the skill reference. */
const DE7584_SKILL_ROW =
  "| refusals | from hcn 0.9.6. A harness that refuses the command that opened a turn, before acknowledging it (pi `prompt` with `success:false`, a popeye prompt error), ends that turn with the classified failure and `done` cause `failed`; a refused later send, even one reusing the id, leaves the turn running. A refused session open (codex `thread/start` error, popeye `create` error) ends the session: codex rejects the waiting sends with `native-rejected`, popeye ends the first waiting send's turn with the failure, and `closed` reports cause `failed` (exit 1) with the failure. A refusal is classified like a terminal error, except that a generic one is `native`, not `task`. A codex app-server that never answers still waits on the caller |";

/** The corrected wording this gate pins, per document. */
const FIXED_DOCS_SESSION_OPEN = `\`failed\` is the cause when the harness refused hcn's
  session open (codex answering \`thread/start\` with an error) and then
  exited cleanly, unless the refusal
  classifies as a rate-limit, usage-limit or quota wall, which takes limit
  precedence: \`closed\` reports cause \`limit\` instead, and hcn exits 1; codex
  rejects the waiting send with reason \`native-rejected\`.`;

const FIXED_DOCS_REFUSED_PROMPT = `A refused prompt (pi's
  \`prompt\` answered \`success: false\`) ends its turn with \`done\` cause
  \`failed\` carrying the failure; the closed event that follows has
  cause \`clean\` when the harness then exits 0 on stdin EOF, unless the
  refusal classifies as a rate-limit, usage-limit or quota wall, which
  takes limit precedence: that refusal ends its turn \`done\` cause
  \`limit\` carrying the failure, and the session closes \`limit\` and hcn exits 1;
  the session-level limit cause, once set, persists even if later turns
  succeed.`;

const FIXED_SKILL_ROW =
  "| refusals | from hcn 0.9.6. A harness that refuses the command that opened a turn, before acknowledging it (pi `prompt` with `success:false`), ends that turn with the classified failure and `done` cause `failed`, unless the refusal classifies as a rate-limit, usage-limit or quota wall, which takes limit precedence: the turn ends `done` cause `limit` and the session closes `limit` and hcn exits 1, a session-level limit cause that persists even if later turns succeed; a refused later send, even one reusing the id, leaves the turn running. A refused session open (codex `thread/start` error) ends the session: codex rejects the waiting sends with `native-rejected`, and `closed` reports cause `failed` (exit 1) with the failure, unless the refusal is a rate-limit, usage-limit or quota wall, which takes limit precedence: `closed` reports cause `limit` instead, and hcn exits 1. A refusal is classified like a terminal error, except that a generic one is `native`, not `task`. A codex app-server that never answers still waits on the caller |";

describe("session limit contract", () => {
  it("docs/reference.md qualifies both refusal claims with the limit exception", () => {
    const issues = docsIssues(closedCauseBullet(readFileSync(DOCS_PATH, "utf8")));
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("the hcn skill reference qualifies both refusal claims with the limit exception", () => {
    const issues = skillIssues(refusalsRow(readFileSync(SKILL_PATH, "utf8")));
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("rejects the exact de7584c docs bullet", () => {
    const issues = docsIssues(DE7584_DOCS_BULLET);
    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("refused session open sentence");
    expect(issues.join("\n")).toContain("refused prompt sentence");
  });

  it("rejects the exact de7584c skill row", () => {
    const issues = skillIssues(DE7584_SKILL_ROW);
    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("refused-opener sentence");
    expect(issues.join("\n")).toContain("refused session open sentence");
  });

  it("rejects docs that drop only the session-open limit qualifier", () => {
    const bullet = `${FIXED_DOCS_SESSION_OPEN.replace(
      ", unless the refusal\n  classifies as a rate-limit, usage-limit or quota wall, which takes limit\n  precedence: `closed` reports cause `limit` instead, and hcn exits 1",
      "",
    )}\n\n${FIXED_DOCS_REFUSED_PROMPT}`;
    const issues = docsIssues(bullet);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refused session open sentence");
  });

  it("rejects docs that drop only the session-persistence clause", () => {
    const bullet = `${FIXED_DOCS_SESSION_OPEN}\n\n${FIXED_DOCS_REFUSED_PROMPT.replace(
      ";\n  the session-level limit cause, once set, persists even if later turns\n  succeed",
      "",
    )}`;
    const issues = docsIssues(bullet);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refused prompt sentence");
  });

  it("rejects the skill row that drops only the refused-opener qualifier", () => {
    const dropped = FIXED_SKILL_ROW.replace(
      ", unless the refusal classifies as a rate-limit, usage-limit or quota wall, which takes limit precedence: the turn ends `done` cause `limit` and the session closes `limit` and hcn exits 1, a session-level limit cause that persists even if later turns succeed",
      "",
    );
    const issues = skillIssues(dropped);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refused-opener sentence");
  });

  it("rejects the skill row that drops only the session-open qualifier", () => {
    const dropped = FIXED_SKILL_ROW.replace(
      ", unless the refusal is a rate-limit, usage-limit or quota wall, which takes limit precedence: `closed` reports cause `limit` instead, and hcn exits 1",
      "",
    );
    const issues = skillIssues(dropped);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refused session open sentence");
  });

  it("accepts the corrected wording", () => {
    expect(docsIssues(`${FIXED_DOCS_SESSION_OPEN}\n\n${FIXED_DOCS_REFUSED_PROMPT}`)).toEqual([]);
    expect(skillIssues(FIXED_SKILL_ROW)).toEqual([]);
  });
});
