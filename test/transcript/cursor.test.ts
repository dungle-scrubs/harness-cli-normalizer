import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { sha256Hex } from "../../src/interpretation/sha256.js";
import {
  frameCursorStore,
  normalizeCursor,
  parseCursorHistory,
} from "../../src/interpretation/transcript/cursor.js";
import { blobId, writeCursorStore, writeDatabase } from "./cursor-store.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const key = "ab".repeat(32);
const system = { role: "system", content: "synthetic system", providerOptions: {} };
const user = { role: "user", content: [{ type: "text", text: "synthetic question" }] };
const assistant = {
  role: "assistant",
  id: "1",
  content: [
    { type: "reasoning", text: "thinking", signature: "sig", providerOptions: {} },
    { type: "redacted-reasoning", data: "opaque", providerOptions: {} },
    { type: "text", text: "calling" },
    { type: "tool-call", toolCallId: "call-1", toolName: "Read", args: { path: "a" } },
  ],
};
const tool = {
  role: "tool",
  id: "2",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "Read",
      result: "contents",
      experimental_content: [],
    },
  ],
};

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "hcn-cursor-store-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

async function store(
  messages: readonly unknown[],
  earlierRoots?: readonly (readonly number[])[],
): Promise<{ bytes: Uint8Array; ids: string[]; path: string }> {
  const path = join(directory(), "store.db");
  const ids = await writeCursorStore(path, { agentId, messages, earlierRoots, encryptionKey: key });
  return { bytes: readFileSync(path), ids, path };
}

test("Cursor projects latest-root messages in order with exact originals and no encryption key", async () => {
  const exact = { role: "user", content: "x", large: 0 };
  const { bytes, ids } = await store(
    [system, user, assistant, tool, exact],
    [
      [0, 1],
      [0, 1, 2],
    ],
  );
  expect(new TextDecoder().decode(frameCursorStore(bytes))).not.toContain(key);
  const history = parseCursorHistory(frameCursorStore(bytes));
  expect(history.identityRecord).toEqual({ agentId });
  expect(history.entries.map((entry) => String(entry.original.blobId))).toEqual(ids);
  const records = history.entries.map((entry) => normalizeCursor(entry, agentId));
  expect(records.map((record) => record.normalized.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  expect(records[2]?.normalized.parts.map((part) => [part.kind, part.contentStatus])).toEqual([
    ["thinking", "included"],
    ["thinking", "not-included"],
    ["text", "included"],
    ["tool-call", "included"],
  ]);
  expect(records[3]?.normalized.kind).toBe("tool-result");
  expect(records[3]?.normalized.parts[0]?.text).toBe("contents");
  expect(records[3]?.normalized.relationships["tool-call"].targets[0]?.nativeId).toBe("call-1");
  expect(records[3]?.nativeId).toBe(ids[3]);
  expect(JSON.stringify(records[2]?.original)).toBe(JSON.stringify(assistant));
});

test("Cursor reads overflow payloads and multi-level b-trees written by SQLite", async () => {
  const large = { role: "user", content: "☀".repeat(20000) };
  const many = Array.from({ length: 400 }, (_, index) => ({ role: "user", content: `m${index}` }));
  const { bytes } = await store([large, ...many]);
  const history = parseCursorHistory(frameCursorStore(bytes));
  expect(history.entries).toHaveLength(401);
  expect(history.entries[0]?.original.message).toEqual(large);
  expect(history.entries[400]?.original.message).toEqual({ role: "user", content: "m399" });
});

test("Cursor refuses an earlier root the latest root does not extend", async () => {
  const { bytes } = await store([system, user, assistant], [[0, 2]]);
  expect(() => frameCursorStore(bytes)).toThrow("earlier Cursor root");
});

test("pure SHA-256 matches node:crypto across padding boundaries", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 255);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});

test("Cursor keeps repeated identical messages as separate occurrences", async () => {
  const again = { role: "user", content: "again" };
  const { bytes } = await store([again, { role: "assistant", content: "ok" }, again]);
  const history = parseCursorHistory(frameCursorStore(bytes));
  expect(history.entries.map((entry) => entry.original.message)).toEqual([
    again,
    { role: "assistant", content: "ok" },
    again,
  ]);
});

test("Cursor rejects a blob whose content no longer matches its ID", async () => {
  const { bytes } = await store([system, user]);
  const text = new TextEncoder().encode("synthetic question");
  const at = Buffer.from(bytes).indexOf(Buffer.from(text));
  const torn = Uint8Array.from(bytes);
  torn[at] = "S".charCodeAt(0);
  expect(() => frameCursorStore(torn)).toThrow("does not match its ID");
});

test("Cursor classifies earlier roots by parsing, not by leading bytes", async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const reference = (data: Uint8Array) => [0x0a, 0x20, ...Buffer.from(blobId(data), "hex")];
  const first = encode(JSON.stringify(system));
  // A later message whose JSON starts with whitespace, referenced by an earlier
  // root that leads with another field: the latest root drops it.
  const spaced = encode(` ${JSON.stringify(user)}`);
  const earlier = Uint8Array.from([0x50, 0x01, ...reference(first), ...reference(spaced)]);
  const dropped = join(directory(), "store.db");
  await writeCursorStore(dropped, { agentId, messages: [system], extraBlobs: [spaced, earlier] });
  expect(() => frameCursorStore(readFileSync(dropped))).toThrow("earlier Cursor root");
  const missing = join(directory(), "store.db");
  const absent = Uint8Array.from([...reference(first), ...reference(encode("absent"))]);
  await writeCursorStore(missing, { agentId, messages: [system], extraBlobs: [absent] });
  expect(() => frameCursorStore(readFileSync(missing))).toThrow("unresolved root reference");
});

test("Cursor honors a current in-header page count", async () => {
  const { bytes } = await store([system]);
  const lying = Uint8Array.from(bytes);
  new DataView(lying.buffer).setUint32(28, 100);
  expect(() => frameCursorStore(lying)).toThrow("declared page count");
});

test("Cursor refuses sources that are not an established chat store", async () => {
  expect(() => frameCursorStore(new TextEncoder().encode("{}\n"))).toThrow("not a SQLite");
  const { bytes } = await store([system]);
  expect(() => frameCursorStore(bytes.subarray(0, bytes.length - 100))).toThrow("truncated page");
  const path = join(directory(), "other.db");
  await writeDatabase(path, [
    "CREATE TABLE blobs (id TEXT, data BLOB)",
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
  ]);
  expect(() => frameCursorStore(readFileSync(path))).toThrow("chat store schema");
});

beforeAll(() => {
  const built = spawnSync("node", [resolve("scripts/build-native.ts"), "--stage"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(built.status, built.stderr).toBe(0);
});

function command(args: string[], env: Record<string, string> = {}) {
  const home = directory();
  const run = spawnSync("bun", [resolve("src/cli/index.ts"), ...args], {
    encoding: "utf8",
    env: { HOME: home, TMPDIR: home, PATH: process.env.PATH, ...env },
  });
  if (run.error) throw run.error;
  const lines = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { code: run.status, err: run.stderr, lines, result: lines.at(-1) };
}

test("Cursor ID lookup reads the chat store and continues after an appended turn", async () => {
  const root = directory();
  const chat = join(root, "chats", "0123456789abcdef0123456789abcdef", agentId);
  mkdirSync(chat, { recursive: true });
  const path = join(chat, "store.db");
  await writeCursorStore(path, { agentId, messages: [system, user] });
  const env = { CURSOR_CONFIG_DIR: root };
  const first = command(["transcript", "read", "cursor", "--id", agentId], env);
  expect(first.code, first.err).toBe(0);
  expect(first.lines[0].methodId).toBe("cursor-store-v1");
  expect(first.lines[0].selection.storeRoots).toEqual([join(root, "chats")]);
  expect(first.result.recordsReturned).toBe(2);
  rmSync(path);
  await writeCursorStore(path, { agentId, messages: [system, user, assistant, tool] });
  const next = command(
    ["transcript", "read", "cursor", "--id", agentId, "--since", first.result.bookmark],
    env,
  );
  expect(next.code, next.err).toBe(0);
  expect(next.result.continuation).toEqual({ input: "verified", output: "advanced" });
  expect(next.lines.filter((line) => line.kind === "record").map((line) => line.original)).toEqual([
    assistant,
    tool,
  ]);
  rmSync(path);
  await writeCursorStore(path, { agentId, messages: [system, assistant] });
  const rewritten = command(
    ["transcript", "read", "cursor", "--id", agentId, "--since", first.result.bookmark],
    env,
  );
  expect(rewritten.result.failure.issue).toBe("fresh-read-required");
});

test("Cursor transcript inspection reports the store method and its evidence", () => {
  const { code, result } = command(["inspect", "cursor", "--transcript"]);
  expect(code).toBe(0);
  expect(result.methods.map((method: { id: string }) => method.id)).toEqual(["cursor-store-v1"]);
  expect(result.capabilities.history.status).toBe("available");
  expect(result.capabilities["active-branch"].status).toBe("unknown");
});

test("Cursor refuses a store whose write-ahead log holds uncheckpointed writes", async () => {
  const { path } = await store([system, user]);
  writeFileSync(`${path}-wal`, "frames");
  const live = command(["transcript", "read", "cursor", "--file", path]);
  expect(live.code).toBe(1);
  expect(live.result.failure.issue).toBe("guarantee-unmet");
  expect(live.result.failure.requirement).toBe("consistency");
  writeFileSync(`${path}-wal`, "");
  const closed = command(["transcript", "read", "cursor", "--file", path]);
  expect(closed.code, closed.err).toBe(0);
  expect(closed.result.recordsReturned).toBe(2);
  writeFileSync(`${path}-wal`, "frames");
  const alias = join(directory(), "store.db");
  symlinkSync(path, alias);
  const linked = command(["transcript", "read", "cursor", "--file", alias]);
  expect(linked.result.failure.issue).toBe("guarantee-unmet");
});
