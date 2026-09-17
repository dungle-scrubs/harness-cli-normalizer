/**
 * RFC-05 Phase 2: cursor store paths. The chats slug is md5 over the UTF-8
 * bytes of the physical absolute cwd (vendored pure md5, no node: import),
 * and the template root resolves through defaultRoot with {home} expanded
 * unless the caller supplies a root (rootEnv resolution itself is the
 * CLI's impure job in Phase 3).
 */
import { describe, expect, test } from "vitest";
import { storePath } from "../../src/interpretation/store.js";
import { cursorCli } from "../../src/knowledge/cursor.js";

const SID = "0199a4c5-1111-2222-3333-444455556666";

describe("storePath (cursor md5-hex slug)", () => {
  test("md5 over the cwd bytes names the chats directory", () => {
    expect(storePath(cursorCli, { home: "/H", cwd: "/ws-main", sessionId: SID })).toBe(
      "/H/.cursor/chats/867511a5e875949acb734f790a68a624",
    );
  });

  test("a trailing slash normalizes to the same md5 (probe 38)", () => {
    expect(storePath(cursorCli, { home: "/H", cwd: "/ws-main/", sessionId: SID })).toBe(
      "/H/.cursor/chats/867511a5e875949acb734f790a68a624",
    );
  });

  test("a non-ASCII cwd hashes over its UTF-8 bytes", () => {
    expect(storePath(cursorCli, { home: "/H", cwd: "/tmp/café", sessionId: SID })).toBe(
      "/H/.cursor/chats/8da3d2d880a4175f24b0fbedb8e74e33",
    );
  });

  test("a supplied root wins over defaultRoot", () => {
    expect(storePath(cursorCli, { home: "/H", cwd: "/a/b", sessionId: SID, root: "/cfg" })).toBe(
      "/cfg/chats/aee31d71a4dce5fe24481547cc863476",
    );
  });
});
