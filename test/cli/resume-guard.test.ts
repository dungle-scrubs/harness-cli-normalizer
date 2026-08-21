import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resumeStore } from "../../src/cli/resume-guard.js";
import { storePath } from "../../src/interpretation/store.js";
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
