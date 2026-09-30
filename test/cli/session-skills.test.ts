/**
 * hcn session --skills (issue #332): the CLI surface. Names resolve
 * against $HCN_SKILLS_ROOT through the same code path hcn run uses, so
 * unknown names refuse with exit 2 before spawn; a session harness that
 * cannot enforce an allowlist (antigravity, popeye - descriptor skills
 * null) refuses at the render, also exit 2, rather than opening with the
 * full set. The positive spawn path is pinned by the interpretation and
 * execution suites (buildSessionArgv / openSession); live evidence lives
 * with the fixtures.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { session } from "../../src/cli/session.js";

const collect = () => {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  });
  return { out, err, outSpy, errSpy };
};

describe("hcn session --skills (#332)", () => {
  const prevRoot = process.env.HCN_SKILLS_ROOT;
  let dir: string;

  const withRegistry = (): void => {
    dir = mkdtempSync(join(tmpdir(), "hcn-session-skills-"));
    mkdirSync(join(dir, "wayfinder"), { recursive: true });
    process.env.HCN_SKILLS_ROOT = dir;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    if (prevRoot === undefined) delete process.env.HCN_SKILLS_ROOT;
    else process.env.HCN_SKILLS_ROOT = prevRoot;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("unknown names refuse with exit 2 and the failure/closed pair, before spawn", async () => {
    withRegistry();
    const { out, err } = collect();
    const before = process.exitCode ?? 0;
    process.exitCode = 0;
    try {
      await session("pi", ["--json", "--skills", "bogus-name"]);
    } finally {
      expect(process.exitCode).toBe(2);
      process.exitCode = before;
    }
    const events = out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { raw: l };
        }
      });
    expect(events[0]).toMatchObject({ kind: "failure" });
    expect(events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
    expect(events[0]).toMatchObject({ issue: "invalid-option-value", option: "skills" });
    expect(err.join("")).toMatch(/unknown skill name\(s\): bogus-name/);
  });

  test("antigravity cannot enforce an allowlist: exit 2, nothing opens", async () => {
    withRegistry();
    const { out, err } = collect();
    const before = process.exitCode ?? 0;
    process.exitCode = 0;
    try {
      await session("antigravity", ["--json", "--skills", "wayfinder"]);
    } finally {
      expect(process.exitCode).toBe(2);
      process.exitCode = before;
    }
    const events = out
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { raw: l };
        }
      });
    expect(events[0]).toMatchObject({ kind: "failure", issue: "unsupported-option" });
    expect(events.at(-1)).toMatchObject({ kind: "closed", cause: "failed" });
    expect(err.join("")).toMatch(/caller-directed skill sets/);
    expect(err.join("")).toMatch(/supported on: .*pi/);
  });

  test("popeye refuses with its plugin-name hint", async () => {
    withRegistry();
    const { err } = collect();
    const before = process.exitCode ?? 0;
    process.exitCode = 0;
    try {
      await session("popeye", ["--json", "--skills", "wayfinder"]);
    } finally {
      expect(process.exitCode).toBe(2);
      process.exitCode = before;
    }
    expect(err.join("")).toMatch(/plugin names/);
  });

  test("no-session-mode harnesses refuse before skills are even resolved", async () => {
    withRegistry();
    const { err } = collect();
    const before = process.exitCode ?? 0;
    process.exitCode = 0;
    try {
      await session("muse", ["--json", "--skills", "wayfinder"]);
    } finally {
      expect(process.exitCode).toBe(2);
      process.exitCode = before;
    }
    expect(err.join("")).toMatch(/session mode/);
  });
});
