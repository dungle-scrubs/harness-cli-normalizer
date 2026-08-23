import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resumeStore } from "../../src/cli/resume-guard.js";
import { storePath } from "../../src/interpretation/store.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const id = "01a02409-89f6-73fc-9781-78aac1bcfa60";

describe("resumeStore resolves the cwd the harness actually slugged", () => {
  test("a cwd reached through a symlink finds the store filed under its real path", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-home-"));
    const realCwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-cwd-")));
    const linkCwd = join(mkdtempSync(join(tmpdir(), "hcn-link-")), "work");
    symlinkSync(realCwd, linkCwd);
    // pi files the session under the slug of the REAL directory.
    const filed = storePath(piCli, { home, cwd: realCwd, sessionId: id });
    mkdirSync(filed, { recursive: true });
    // pi files the session as <timestamp>_<id>.jsonl inside that dir.
    writeFileSync(join(filed, `2026-08-23T00-00-00-000Z_${id}.jsonl`), "");

    const viaLink = resumeStore(piCli, { home, cwd: linkCwd, sessionId: id });
    expect(viaLink.path).toBe(filed);
    expect(viaLink.exists).toBe(true);
  });

  test("a session that was never filed is reported as absent", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-cwd-"));
    const check = resumeStore(piCli, { home, cwd, sessionId: id });
    expect(check.exists).toBe(false);
    expect(check.path).toContain(home);
  });

  test("a cwd that does not exist resolves to itself", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-home-"));
    const check = resumeStore(piCli, { home, cwd: "/nonexistent/hcn-dir", sessionId: id });
    expect(check.path).toContain("--nonexistent-hcn-dir--");
    expect(check.exists).toBe(false);
  });
});

describe("issue #103: a directory-shaped store is searched as deep as the harness files it", () => {
  test("muse files <root>/YYYY/MM/DD/<id>/ - three levels down - and is found", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-103-"));
    const id = "8384f1ba-8a39-491f-be82-2a774f8212ff";
    const root = storePath(museCode, { home, cwd: "/any", sessionId: id });
    mkdirSync(join(root, "2026", "08", "23", id), { recursive: true });
    writeFileSync(join(root, "2026", "08", "23", id, "session.jsonl"), "");
    expect(resumeStore(museCode, { home, cwd: "/any", sessionId: id }).exists).toBe(true);
    expect(
      resumeStore(museCode, {
        home,
        cwd: "/any",
        sessionId: "00000000-0000-4000-8000-000000000000",
      }).exists,
    ).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("the walk is depth-capped: an id buried deeper than any harness files it is not found", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-103-deep-"));
    const id = "8384f1ba-8a39-491f-be82-2a774f8212ff";
    const root = storePath(museCode, { home, cwd: "/any", sessionId: id });
    mkdirSync(join(root, "a", "b", "c", "d", "e", "f", id), { recursive: true });
    expect(resumeStore(museCode, { home, cwd: "/any", sessionId: id }).exists).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
