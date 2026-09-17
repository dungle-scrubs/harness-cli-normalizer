/**
 * RFC-06 Phase 3: the resume-last warning texts, rendered purely from
 * descriptor data. The per-harness texts are normative and verbatim from
 * the RFC; this file pins every byte. The render substitutes the
 * realpath scope for `{cwd}` with no harness-name branch - the wording
 * lives on `resumeLast.warning` in the knowledge layer.
 */
import { describe, expect, test } from "vitest";
import { resumeLastWarning } from "../../src/interpretation/resume-last.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

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

  test("muse carries the same generic shape (stored data; parse-only, never emitted)", () => {
    expect(resumeLastWarning(museCode, cwd)).toBe(
      `hcn: --resume-last resumes the most-recent muse session in ${cwd}; the most recent session may be a killed, failed, or unrelated run's session; muse starts a fresh session with exit 0 when no session is resumable in ${cwd}; a run from inside a live muse session in the same directory re-enters that session`,
    );
  });

  test("the warning carries no session id", () => {
    for (const h of [claudeCode, codexCli, piCli, cursorCli, museCode]) {
      expect(resumeLastWarning(h, cwd)).not.toContain("eb04301d");
    }
  });
});
