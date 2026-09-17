import { describe, expect, test } from "vitest";
import { rankResumeLast, resumeLastWarning } from "../../src/interpretation/resume-last.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { UUID_SHAPE } from "../../src/knowledge/descriptor.js";
import { piCli } from "../../src/knowledge/pi.js";

const a = { id: "aaaa1111-0000-0000-0000-000000000001", mtimeMs: 60_000, cwd: "/repo" };
const b = { id: "bbbb2222-0000-0000-0000-000000000002", mtimeMs: 1_000, cwd: "/repo" };
const elsewhere = { id: "cccc3333-0000-0000-0000-000000000003", mtimeMs: 90_000, cwd: "/other" };

describe("rankResumeLast (codex --last race)", () => {
  test("ranks by cwd corroboration first, then recency", () => {
    const verdict = rankResumeLast([elsewhere, b, a], { cwd: "/repo" });
    expect(verdict).toEqual({ kind: "chosen", id: a.id, ranked: [a.id, b.id, elsewhere.id] });
  });

  test("two candidates it cannot tell apart is a refusal, never a guess", () => {
    const twin = { ...b, mtimeMs: a.mtimeMs + 100 }; // same cwd, near-same mtime
    const verdict = rankResumeLast([a, twin], { cwd: "/repo" });
    expect(verdict.kind).toBe("ambiguous");
    if (verdict.kind === "ambiguous") {
      expect([...verdict.candidates].sort()).toEqual([a.id, twin.id].sort());
    }
  });

  test("no candidates is none, one candidate is chosen without ceremony", () => {
    expect(rankResumeLast([], { cwd: "/repo" })).toEqual({ kind: "none" });
    expect(rankResumeLast([a], { cwd: "/x" })).toMatchObject({ kind: "chosen", id: a.id });
  });
});

describe("M2.3 boundary-review regression pins", () => {
  test("trailing-slash cwd skew never demotes the true session", () => {
    const verdict = rankResumeLast([elsewhere, a], { cwd: "/repo/" });
    expect(verdict).toMatchObject({ kind: "chosen", id: a.id });
  });

  test("duplicate rows for one id are one candidate, not an ambiguity", () => {
    const dup = { ...a, mtimeMs: a.mtimeMs + 500 };
    expect(rankResumeLast([a, dup], { cwd: "/repo" })).toMatchObject({ kind: "chosen", id: a.id });
  });

  test("N-way ambiguity reports every contender, not just two", () => {
    const c2 = { ...b, id: "dddd4444-0000-0000-0000-000000000004", mtimeMs: a.mtimeMs + 100 };
    const c3 = { ...b, id: "eeee5555-0000-0000-0000-000000000005", mtimeMs: a.mtimeMs - 100 };
    const verdict = rankResumeLast([a, c2, c3], { cwd: "/repo" });
    expect(verdict.kind).toBe("ambiguous");
    if (verdict.kind === "ambiguous") expect(verdict.candidates).toHaveLength(3);
  });

  test("non-finite mtimes refuse rather than win by sort accident", () => {
    const broken = { ...a, mtimeMs: Number.NaN };
    expect(rankResumeLast([broken], { cwd: "/repo" }).kind).toBe("ambiguous");
    // A finite candidate still beats a broken one.
    expect(rankResumeLast([broken, b], { cwd: "/repo" })).toMatchObject({ kind: "ambiguous" });
  });
});

/**
 * RFC-06 Phase 3: the resume-last warning texts, rendered purely from
 * descriptor data. The per-harness texts are normative and verbatim from
 * the RFC; this file pins every byte. The render substitutes the
 * realpath scope for `{cwd}` with no harness-name branch - the wording
 * lives on `resumeLast.warning` in the knowledge layer. Parse-only
 * harnesses (muse: `headless: false`) carry no warning, so none is
 * pinned for them here.
 */
const cwd = "/tmp/ws-main";

describe("RFC-06 Phase 3: pinned resume-last warning texts", () => {
  test("claude warns it forks under a new id, with the stranger and fresh clauses", () => {
    expect(resumeLastWarning(claudeCode, cwd)).toBe(
      `hcn: --resume-last forks the most-recent claude session in ${cwd} under a new fork id; the most recent session may be a killed, failed, or unrelated run's session; claude starts a fresh session with exit 0 when no session is resumable in ${cwd}`,
    );
  });

  test("codex warns it resumes, with the stranger, fresh, and parent-session clauses", () => {
    expect(resumeLastWarning(codexCli, cwd)).toBe(
      `hcn: --resume-last resumes the most-recent codex session in ${cwd}; the most recent session may be a killed, failed, or unrelated run's session; codex starts a fresh session with exit 0 when no session is resumable in ${cwd}; a run from inside a live codex session in the same directory re-enters that session`,
    );
  });

  test("pi warns it resumes, with the stranger, fresh, and parent-session clauses", () => {
    expect(resumeLastWarning(piCli, cwd)).toBe(
      `hcn: --resume-last resumes the most-recent pi session in ${cwd}; the most recent session may be a killed, failed, or unrelated run's session; pi starts a fresh session with exit 0 when no session is resumable in ${cwd}; a run from inside a live pi session in the same directory re-enters that session`,
    );
  });

  test("cursor warns it resumes, with the error-meaning and parent-session clauses", () => {
    expect(resumeLastWarning(cursorCli, cwd)).toBe(
      `hcn: --resume-last resumes the most-recent cursor session in ${cwd}; the most recent session may be a killed, failed, or unrelated run's session; cursor errors with exit 1 when no session is resumable, and the same error means the store root resolved away from the session; a run from inside a live cursor session in the same directory re-enters that session`,
    );
  });

  test("the warning carries no session id on any renderable harness", () => {
    // The renderer substitutes only the scope cwd into a fixed template,
    // so no UUID-shaped token can appear unless the cwd itself carries
    // one - the fixed cwd here carries none.
    for (const h of [claudeCode, codexCli, piCli, cursorCli]) {
      expect(resumeLastWarning(h, cwd)).not.toMatch(UUID_SHAPE);
    }
  });
});
