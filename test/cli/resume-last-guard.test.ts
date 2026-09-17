/**
 * RFC-06 Phase 3: the resume-last CLI guard - store-root and scope-dir
 * resolution plus the emitted notice lines. Roots resolve through the
 * descriptor's precedence table first (`resolveStoreRoot`: cursor) else
 * the shared transcript-style roots (claude, codex, pi - the same
 * directory `transcript.ts` reads). The per-cwd scope directory derives
 * from the store template, never a name: templates without `{cwdSlug}`
 * (codex, muse) carry no check. Real temp dirs for the existence check;
 * never runs a real harness CLI.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resumeLastNoticesFor,
  resumeLastScopeDir,
  resumeLastStoreRoot,
} from "../../src/cli/resume-last-guard.js";
import { transcriptStoreRoot } from "../../src/cli/store-root.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { piCli } from "../../src/knowledge/pi.js";

const cwd = "/tmp/ws-main";

describe("RFC-06 Phase 3: store-root and scope-dir resolution", () => {
  const home = "/tmp/fake-home";

  test("claude resolves CLAUDE_CONFIG_DIR/projects, else home/.claude/projects", () => {
    expect(resumeLastStoreRoot(claudeCode, { env: {}, cwd, home })).toBe(
      "/tmp/fake-home/.claude/projects",
    );
    expect(
      resumeLastStoreRoot(claudeCode, { env: { CLAUDE_CONFIG_DIR: "/tmp/cfg" }, cwd, home }),
    ).toBe("/tmp/cfg/projects");
  });

  test("codex resolves CODEX_HOME, else home/.codex, with no scope dir", () => {
    expect(resumeLastStoreRoot(codexCli, { env: {}, cwd, home })).toBe("/tmp/fake-home/.codex");
    expect(resumeLastStoreRoot(codexCli, { env: { CODEX_HOME: "/tmp/ch" }, cwd, home })).toBe(
      "/tmp/ch",
    );
    expect(resumeLastScopeDir(codexCli, { root: "/tmp/ch", cwd, home })).toBeNull();
  });

  test("pi resolves the sessions dir with the slug, which is its own scope dir", () => {
    const root = resumeLastStoreRoot(piCli, { env: {}, cwd, home });
    expect(root).toBe("/tmp/fake-home/.pi/agent/sessions/--tmp-ws-main--");
    expect(resumeLastScopeDir(piCli, { root, cwd, home })).toBe(root);
    expect(resumeLastStoreRoot(piCli, { env: { PI_CODING_AGENT_DIR: "/tmp/ps" }, cwd, home })).toBe(
      "/tmp/ps/sessions/--tmp-ws-main--",
    );
  });

  test("cursor resolves the first set rootEnv entry, else the default root", () => {
    expect(resumeLastStoreRoot(cursorCli, { env: {}, cwd, home })).toBe("/tmp/fake-home/.cursor");
    expect(
      resumeLastStoreRoot(cursorCli, { env: { CURSOR_CONFIG_DIR: "/tmp/cc" }, cwd, home }),
    ).toBe("/tmp/cc");
    const root = resumeLastStoreRoot(cursorCli, { env: {}, cwd, home });
    expect(resumeLastScopeDir(cursorCli, { root, cwd, home })?.startsWith(`${root}/chats/`)).toBe(
      true,
    );
  });

  test("claude scope dir joins the dash slug under the root", () => {
    expect(resumeLastScopeDir(claudeCode, { root: "/tmp/cfg/projects", cwd, home })).toBe(
      "/tmp/cfg/projects/-tmp-ws-main",
    );
  });

  test("relative store-root env values anchor at the spawn cwd, empty counts as unset", () => {
    expect(
      resumeLastStoreRoot(claudeCode, { env: { CLAUDE_CONFIG_DIR: ".alt" }, cwd: "/repo", home }),
    ).toBe("/repo/.alt/projects");
    expect(
      resumeLastStoreRoot(claudeCode, { env: { CLAUDE_CONFIG_DIR: "" }, cwd: "/repo", home }),
    ).toBe("/tmp/fake-home/.claude/projects");
  });

  test("the legacy transcript anchor is unchanged: process cwd, empty counts as set", () => {
    expect(
      transcriptStoreRoot("claude", { env: { CLAUDE_CONFIG_DIR: "" }, cwd: "/repo", home }),
    ).toBe(resolve(process.cwd(), "projects"));
    expect(
      transcriptStoreRoot("claude", { env: { CLAUDE_CONFIG_DIR: ".alt" }, cwd: "/repo", home }),
    ).toBe(resolve(process.cwd(), ".alt", "projects"));
  });

  test("cursor never falls through to a pi root", () => {
    expect(() => transcriptStoreRoot("cursor", { env: {}, cwd, home })).toThrow();
  });
});

describe("RFC-06 Phase 3: guard notice lines", () => {
  test("a fresh cwd yields warning, diagnostic, and absent-directory warn in order", () => {
    const scope = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-cwd-`));
    const home = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-home-`));
    const {
      cwd: resolved,
      root,
      messages,
    } = resumeLastNoticesFor(claudeCode, {
      env: { HOME: home },
      cwd: scope,
    });
    expect(resolved).toBe(scope);
    expect(root).toBe(`${home}/.claude/projects`);
    expect(messages.length).toBe(3);
    expect(messages[0]).toContain("hcn: --resume-last forks the most-recent claude session");
    expect(messages[0]).toContain(scope);
    expect(messages[1]).toBe(`hcn: --resume-last store root ${root} for scope ${scope}`);
    expect(messages[2]).toContain("hcn: --resume-last found no store directory");
  });

  test("--env CLAUDE_CONFIG_DIR moves the diagnostic root with the child", () => {
    const home = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-home-`));
    const cfg = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-cfg-`));
    const scope = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-cwd-`));
    const { messages } = resumeLastNoticesFor(claudeCode, {
      env: { HOME: home, CLAUDE_CONFIG_DIR: cfg },
      cwd: scope,
    });
    const diagnostic = messages.find((m) => m.startsWith("hcn: --resume-last store root "));
    expect(diagnostic).toBe(`hcn: --resume-last store root ${cfg}/projects for scope ${scope}`);
  });

  test("an existing per-cwd scope directory clears the absent-directory warn", () => {
    const home = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-pi-home-`));
    const store = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-pi-store-`));
    const scope = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-cwd-`));
    const first = resumeLastNoticesFor(piCli, {
      env: { HOME: home, PI_CODING_AGENT_DIR: store },
      cwd: scope,
    });
    expect(first.messages.some((m) => m.includes("found no store directory"))).toBe(true);
    // File the per-cwd scope directory the way the harness does (the
    // root already is the per-cwd directory on pi) and re-run: warning
    // plus diagnostic stay, the absent warn goes.
    mkdirSync(first.root, { recursive: true });
    const second = resumeLastNoticesFor(piCli, {
      env: { HOME: home, PI_CODING_AGENT_DIR: store },
      cwd: scope,
    });
    expect(second.messages.some((m) => m.startsWith("hcn: --resume-last resumes"))).toBe(true);
    expect(second.messages.some((m) => m.startsWith("hcn: --resume-last store root "))).toBe(true);
    expect(second.messages.some((m) => m.includes("found no store directory"))).toBe(false);
  });

  test("codex carries no absent-directory check through data, not a name check", () => {
    const scope = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-cwd-`));
    const home = realpathSync.native(mkdtempSync(`${tmpdir()}/hcn-rl-home-`));
    const { messages } = resumeLastNoticesFor(codexCli, {
      env: { HOME: home },
      cwd: scope,
    });
    expect(messages.length).toBe(2);
    expect(messages.some((m) => m.includes("found no store directory"))).toBe(false);
  });
});
