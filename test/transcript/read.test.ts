import { readerForMethod } from "../../src/interpretation/transcript/readers.js";
import { CODEX_TRANSCRIPT_METHOD } from "../../src/knowledge/transcript/codex.js";
import { PI_TRANSCRIPT_METHOD } from "../../src/knowledge/transcript/pi.js";

const reader = readerForMethod(PI_TRANSCRIPT_METHOD);
if (!reader) throw new Error("Missing Pi reader");

import { expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";
import type { TranscriptFiles } from "../../src/execution/transcript/files.js";
import { readTranscript } from "../../src/execution/transcript/read.js";

const bytes = new TextEncoder().encode(
  '{"type":"session","version":3,"id":"synthetic","cwd":"/synthetic"}\n',
);
const request: import("../../src/execution/transcript/read.js").ReadTranscriptRequest = {
  acceptedLimits: [],
  selection: { kind: "file", path: "/synthetic/history.jsonl" },
  harness: "pi",
  hcnVersion: "test",
  workspace: "/synthetic",
};

test("a snapshot read uses its finite cloned view and cleans it before terminal success", async () => {
  let cleaned = false;
  const lines: string[] = [];
  const code = await readTranscript(request, {
    reader: { ...reader, consistency: "snapshot" },
    clock: nodeRunnerDeps().clock,
    files: {
      async open() {
        throw new Error("Live source must not be read");
      },
      async version() {
        throw new Error("Live source can be rewritten after acquisition");
      },
      async snapshot() {
        return {
          close: async () => {
            cleaned = true;
          },
          read: async (length, start = 0) => bytes.subarray(start, start + length),
          version: async () => ({ identity: "snapshot", size: bytes.length }),
        };
      },
    },
    write: async (line) => {
      expect(cleaned).toBe(true);
      lines.push(line);
    },
  });
  expect(code).toBe(0);
  const final = JSON.parse(lines.at(-1) ?? "{}");
  expect(final.status).toBe("complete");
  expect(final.consistency.method).toBe("native-snapshot");
  expect(final.consistency.assumptions.join(" ")).not.toContain("append-only");
});

test("a multi-source export scans each namespace once and closes every contributing source", async () => {
  const codex = readerForMethod(CODEX_TRANSCRIPT_METHOD);
  if (!codex) throw new Error("Missing Codex reader");
  const encode = (rows: unknown[]) =>
    new TextEncoder().encode(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const parent = encode([
    {
      ordinal: 0,
      type: "session_meta",
      payload: { id: "parent", cli_version: "0.147.0", history_mode: "paginated" },
    },
    { ordinal: 1, type: "event_msg", payload: { type: "synthetic" } },
  ]);
  const child = encode([
    {
      ordinal: 2,
      type: "session_meta",
      payload: {
        id: "child",
        cli_version: "0.147.0",
        history_mode: "paginated",
        history_base: {
          thread_id: "parent",
          end_byte_offset: parent.length,
          end_ordinal_exclusive: 2,
        },
      },
    },
    { ordinal: 3, type: "event_msg", payload: { type: "synthetic" } },
  ]);
  const sources: Record<string, Uint8Array> = {
    "/synthetic/sessions/rollout-test-parent.jsonl": parent,
    "/synthetic/sessions/rollout-test-child.jsonl": child,
  };
  const scans: string[] = [];
  const closed: string[] = [];
  const files: TranscriptFiles = {
    async *list(path) {
      scans.push(path);
      if (path.endsWith("/sessions"))
        yield* ["rollout-test-parent.jsonl", "rollout-test-child.jsonl"];
    },
    async open(path) {
      const bytes = sources[path];
      if (!bytes) throw new Error("Unexpected source");
      return {
        close: async () => {
          closed.push(path);
        },
        read: async (length, offset = 0) => bytes.subarray(offset, offset + length),
        version: async () => ({ identity: path, size: bytes.length }),
      };
    },
    version: async (path) => ({ identity: path, size: sources[path]?.length ?? 0 }),
  };
  const output: string[] = [];
  const code = await readTranscript(
    {
      ...request,
      harness: "codex",
      nativeStoreRoot: "/synthetic",
      selection: { kind: "id", nativeId: "child" },
    },
    {
      reader: codex,
      files,
      clock: nodeRunnerDeps().clock,
      write: async (line) => {
        output.push(line);
      },
    },
  );
  expect(code).toBe(0);
  expect(JSON.parse(output.at(-1) ?? "{}").recordsReturned).toBe(2);
  expect(scans).toEqual(["/synthetic/sessions", "/synthetic/archived_sessions"]);
  expect(closed.sort()).toEqual(Object.keys(sources).sort());
});

test("an interrupted read closes its native file and cannot return successful progress", async () => {
  const abort = new AbortController();
  let closed = false;
  const files: TranscriptFiles = {
    open: async () => ({
      close: async () => {
        closed = true;
      },
      read: async () => {
        abort.abort();
        return bytes;
      },
      version: async () => ({ identity: "synthetic-inode", size: bytes.length }),
    }),
    version: async () => ({ identity: "synthetic-inode", size: bytes.length }),
  };
  const lines: string[] = [];
  const result = await readTranscript(request, {
    reader,
    clock: nodeRunnerDeps().clock,
    files,
    signal: abort.signal,
    write: async (line) => {
      lines.push(line);
    },
  });
  expect(result).toBe(1);
  expect(closed).toBe(true);
  const final = JSON.parse(lines.at(-1) ?? "{}");
  expect(final.failure.issue).toBe("interrupted");
  expect(final.bookmark).toBeNull();
  expect(final.continuation.output).toBe("unavailable");
});

test("cleanup has a bounded deadline and cannot publish an advancing bookmark after that deadline", async () => {
  const files: TranscriptFiles = {
    open: async () => ({
      close: () => new Promise<void>(() => {}),
      read: async () => bytes,
      version: async () => ({ identity: "synthetic-inode", size: bytes.length }),
    }),
    version: async () => ({ identity: "synthetic-inode", size: bytes.length }),
  };
  const lines: string[] = [];
  const result = await readTranscript(request, {
    reader,
    clock: {
      clearTimeout: () => {},
      now: () => 0,
      setTimeout: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
    },
    files,
    write: async (line) => {
      lines.push(line);
    },
  });
  expect(result).toBe(1);
  const final = JSON.parse(lines.at(-1) ?? "{}");
  expect(final.failure.issue).toBe("cleanup-failed");
  expect(final.continuation.output).toBe("unavailable");
  expect(final.bookmark).toBeNull();
}, 1000);

test("an in-call prefix change takes precedence over malformed source data", async () => {
  const malformed = new TextEncoder().encode("not-json\n");
  let reads = 0;
  const files: TranscriptFiles = {
    open: async () => ({
      close: async () => {},
      read: async () => (++reads === 1 ? malformed : new TextEncoder().encode("changed!\n")),
      version: async () => ({ identity: "synthetic", size: malformed.length }),
    }),
    version: async () => ({ identity: "synthetic", size: malformed.length }),
  };
  const lines: string[] = [];
  await readTranscript(request, {
    reader,
    clock: nodeRunnerDeps().clock,
    files,
    write: async (line) => {
      lines.push(line);
    },
  });
  const final = JSON.parse(lines.at(-1) ?? "{}");
  expect(final.failure.issue).toBe("source-changed");
  expect(final.consistency.ruleIds).toEqual(["pi-prefix-v1"]);
  expect(final.consistency.checks[0].outcome).toBe("failed");
});

test("interruption during output cannot deliver a successful result", async () => {
  const abort = new AbortController();
  const files: TranscriptFiles = {
    open: async () => ({
      close: async () => {},
      read: async () => bytes,
      version: async () => ({ identity: "synthetic", size: bytes.length }),
    }),
    version: async () => ({ identity: "synthetic", size: bytes.length }),
  };
  const lines: string[] = [];
  await expect(
    readTranscript(request, {
      reader,
      clock: nodeRunnerDeps().clock,
      files,
      signal: abort.signal,
      write: async (line) => {
        lines.push(line);
        abort.abort();
      },
    }),
  ).rejects.toMatchObject({ issue: "interrupted" });
  expect(lines).toHaveLength(1);
});

test("large-prefix verification reads bounded chunks and honors the selected cleanup deadline", async () => {
  const content = new TextEncoder().encode(
    `${new TextDecoder().decode(bytes) + JSON.stringify({ type: "custom_message", id: "large", parentId: null, content: "x".repeat(2200000) })}\n`,
  );
  const reads: { length: number; start: number }[] = [];
  const deadlines: number[] = [];
  const selected = { ...reader, method: { ...reader.method, cleanupTimeoutMs: 37 } };
  const code = await readTranscript(request, {
    reader: selected,
    clock: {
      now: () => 0,
      clearTimeout: () => {},
      setTimeout: (_, ms) => {
        deadlines.push(ms);
        return 1;
      },
    },
    files: {
      open: async () => ({
        close: async () => {},
        read: async (length, start = 0) => {
          reads.push({ length, start });
          return content.subarray(start, start + length);
        },
        version: async () => ({ identity: "synthetic", size: content.length }),
      }),
      version: async () => ({ identity: "synthetic", size: content.length }),
    },
    write: async () => {},
  });
  expect(code).toBe(0);
  expect(deadlines).toEqual([37]);
  expect(reads[0]?.length).toBe(content.length);
  expect(reads.slice(1).every((call) => call.length <= 1024 * 1024)).toBe(true);
  expect(reads.at(-1)?.start).toBe(2 * 1024 * 1024);
});
