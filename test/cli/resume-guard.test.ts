import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { effectiveGuardEnv, resolveStoreRoot, resumeStore } from "../../src/cli/resume-guard.js";
import { storePath } from "../../src/interpretation/store.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
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

describe("cursor store root (RFC-05 rootEnv)", () => {
  test("CURSOR_CONFIG_DIR wins and names the chats parent directly", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-root-cwd-"));
    const cfg = mkdtempSync(join(tmpdir(), "hcn-root-cfg-"));
    const check = resumeStore(cursorCli, {
      home,
      cwd,
      sessionId: id,
      env: { CURSOR_CONFIG_DIR: cfg },
    });
    expect(check.path?.startsWith(`${cfg}/chats/`)).toBe(true);
  });

  test("both variables set: CURSOR_CONFIG_DIR wins with no cursor suffix (probes 44/45)", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-root-cwd-"));
    const cfg = mkdtempSync(join(tmpdir(), "hcn-root-cfg-"));
    const xdg = mkdtempSync(join(tmpdir(), "hcn-root-xdg-"));
    const check = resumeStore(cursorCli, {
      home,
      cwd,
      sessionId: id,
      env: { CURSOR_CONFIG_DIR: cfg, XDG_CONFIG_HOME: xdg },
    });
    expect(check.path?.startsWith(`${cfg}/chats/`)).toBe(true);
  });

  test("set-but-empty counts as unset, so XDG_CONFIG_HOME applies (probe 53)", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-root-cwd-"));
    const xdg = mkdtempSync(join(tmpdir(), "hcn-root-xdg-"));
    const check = resumeStore(cursorCli, {
      home,
      cwd,
      sessionId: id,
      env: { CURSOR_CONFIG_DIR: "", XDG_CONFIG_HOME: xdg },
    });
    expect(check.path?.startsWith(`${join(xdg, "cursor")}/chats/`)).toBe(true);
  });

  test("a relative value resolves against the spawn cwd (probe 54)", () => {
    // Probe 54 ran with process cwd equal to spawn cwd, so the split
    // between the two is unverified: the anchor is the spawn cwd (the cwd
    // hcn spawns with), chosen because probe 55 files the session under
    // the workspace Cursor actually ran in. This test pins the spawn-cwd
    // anchor by passing a cwd that differs from process.cwd().
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-root-cwd-")));
    expect(cwd).not.toBe(process.cwd());
    const check = resumeStore(cursorCli, {
      home,
      cwd,
      sessionId: id,
      env: { CURSOR_CONFIG_DIR: "relcfg" },
    });
    expect(check.path?.startsWith(`${join(cwd, "relcfg")}/chats/`)).toBe(true);
  });

  test("the md5 slug matches an independent digest on probe-shaped inputs", () => {
    // Probe 38's trailing-slash workspace files under
    // 6fd4032ededd13cf85abaa78342f2203 and probe 46's ws-café under
    // 4fe2ebd9c22e4f5f59adc829aef37279 (both re-verified with an
    // independent md5 over the live spike realpaths). Those absolute
    // paths are machine-specific, so this test pins the same rule
    // hermetically: the vendored slug equals node:crypto md5 over the
    // slash-stripped UTF-8 bytes, for a trailing-slash and a café input.
    for (const cwd of ["/ws-main/", "/tmp/ws-café"]) {
      const slug = storePath(cursorCli, { home: "/H", cwd, sessionId: id }).split("/").at(-1);
      const stripped = cwd.endsWith("/") && cwd.length > 1 ? cwd.slice(0, -1) : cwd;
      expect(slug).toBe(createHash("md5").update(stripped, "utf8").digest("hex"));
    }
  });

  test("a relocated store reports the miss with the expected path", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-root-cwd-")));
    const missing = "22222222-2222-4222-8222-222222222222";
    const check = resumeStore(cursorCli, { home, cwd, sessionId: missing, env: {} });
    expect(check.exists).toBe(false);
    expect(check.path).toBe(storePath(cursorCli, { home, cwd, sessionId: missing }));
  });

  test("with neither variable set the defaultRoot fallback applies (probe 45)", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-root-cwd-"));
    const check = resumeStore(cursorCli, { home, cwd, sessionId: id, env: {} });
    expect(check.path?.startsWith(`${join(home, ".cursor")}/chats/`)).toBe(true);
  });

  test("resolveStoreRoot yields undefined where the descriptor has no root table", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "hcn-root-cwd-"));
    expect(
      resolveStoreRoot(piCli, { env: { CURSOR_CONFIG_DIR: "/elsewhere" }, cwd, home }),
    ).toBeUndefined();
  });
});

describe("M1: the guard checks the root the child will file under", () => {
  const fileCursorSession = (home: string, cwd: string, sessionId: string, root: string): void => {
    const filed = storePath(cursorCli, { home, cwd, sessionId, root });
    mkdirSync(join(filed, sessionId), { recursive: true });
  };

  test("--env CURSOR_CONFIG_DIR is honored when the inherited env lacks it", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-m1-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-m1-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-m1-cfg-")));
    fileCursorSession(home, cwd, id, cfg);
    // The child's effective environment merges --env over the inherited
    // one, so the guard finds the session filed under the --env root.
    const childEnv = effectiveGuardEnv({}, { CURSOR_CONFIG_DIR: cfg }, {});
    expect(resumeStore(cursorCli, { home, cwd, sessionId: id, env: childEnv }).exists).toBe(true);
    // The old behavior (inherited env only) misses it and would refuse a
    // valid resume with exit 2.
    expect(resumeStore(cursorCli, { home, cwd, sessionId: id, env: {} }).exists).toBe(false);
  });

  test("--env CURSOR_CONFIG_DIR= deletes an inherited root", () => {
    const home = mkdtempSync(join(tmpdir(), "hcn-m1-"));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-m1-cwd-")));
    const cfg = realpathSync.native(mkdtempSync(join(tmpdir(), "hcn-m1-cfg-")));
    fileCursorSession(home, cwd, id, cfg);
    // The inherited root alone would find the session...
    expect(
      resumeStore(cursorCli, { home, cwd, sessionId: id, env: { CURSOR_CONFIG_DIR: cfg } }).exists,
    ).toBe(true);
    // ...but the child deletes the key, so it files under the default
    // root where the id is stale, and the guard must report the miss
    // instead of passing a session Cursor will silently create.
    const childEnv = effectiveGuardEnv({ CURSOR_CONFIG_DIR: cfg }, { CURSOR_CONFIG_DIR: "" }, {});
    const check = resumeStore(cursorCli, { home, cwd, sessionId: id, env: childEnv });
    expect(check.exists).toBe(false);
    expect(check.path?.startsWith(`${join(home, ".cursor")}/chats/`)).toBe(true);
  });
});
