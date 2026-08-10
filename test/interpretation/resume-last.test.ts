import { describe, expect, test } from "vitest";
import { rankResumeLast } from "../../src/interpretation/resume-last.js";

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
