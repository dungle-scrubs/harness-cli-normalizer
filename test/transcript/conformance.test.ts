import { readerForMethod } from "../../src/interpretation/transcript/readers.js";
import { PI_TRANSCRIPT_METHOD } from "../../src/knowledge/transcript/pi.js";

const reader = (() => {
  const value = readerForMethod(PI_TRANSCRIPT_METHOD);
  if (!value) throw new Error("Missing Pi reader");
  return value;
})();

import { expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";
import type { ReadTranscriptRequest } from "../../src/execution/transcript/read.js";
import { readTranscript } from "../../src/execution/transcript/read.js";
import { encodeJson, parseNativeJson } from "../../src/interpretation/transcript/json.js";
import { parseTranscriptOptions } from "../../src/interpretation/transcript/options.js";

const header = '{"type":"session","version":3,"id":"synthetic","cwd":"/synthetic"}\n';
async function read(text: string | Uint8Array, options: Partial<ReadTranscriptRequest> = {}) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const lines: string[] = [];
  const code = await readTranscript(
    {
      acceptedLimits: [],
      selection: { kind: "file", path: "/synthetic/file" },
      harness: "pi",
      hcnVersion: "test",
      workspace: "/synthetic",
      ...options,
    },
    {
      reader,
      clock: nodeRunnerDeps().clock,
      files: {
        open: async () => ({
          close: async () => {},
          read: async () => bytes,
          version: async () => ({ identity: "synthetic", size: bytes.length }),
        }),
        version: async () => ({ identity: "synthetic", size: bytes.length }),
      },
      write: async (line) => {
        lines.push(line);
      },
    },
  );
  return { code, lines, result: JSON.parse(lines.at(-1) ?? "{}") };
}

test("a native identity that cannot fit in a bookmark leaves full retrieval usable and continuation unavailable", async () => {
  const large = header.replace('"synthetic"', JSON.stringify("s".repeat(70000)));
  const output = await read(large);
  expect(output.code).toBe(0);
  expect(output.result.bookmark).toBeNull();
  expect(output.result.capabilities.incremental.status).toBe("unavailable");
  expect(output.result.continuation.output).toBe("unavailable");
});

test("empty and EOF reads provide usable same-boundary bookmarks", async () => {
  const first = await read(header);
  expect(first.result.continuation.output).toBe("same-boundary");
  expect(typeof first.result.bookmark).toBe("string");
  const next = await read(header, { since: first.result.bookmark });
  expect(next.code).toBe(0);
  expect(next.result.recordsReturned).toBe(0);
  expect(next.result.more).toBe(false);
  expect(next.result.continuation).toEqual({ input: "verified", output: "same-boundary" });
  expect(
    next.result.consistency.checks.every(
      (check: { outcome: string }) => check.outcome === "passed",
    ),
  ).toBe(true);
});

test("an unfinished UTF-8 framing unit stays before progress and can finish on a later call", async () => {
  const entry = '{"type":"custom_message","id":"a","parentId":null,"content":"synthetic ☀"}\n';
  const prefix = new TextEncoder().encode(header + entry);
  const first = await read(prefix.subarray(0, prefix.length - 5));
  expect(first.code).toBe(0);
  expect(first.result.incompleteTail.position.value).toBe(
    String(new TextEncoder().encode(header).length),
  );
  expect(first.result.more).toBe(false);
  const next = await read(prefix, { since: first.result.bookmark });
  expect(next.code).toBe(0);
  expect(next.result.recordsReturned).toBe(1);
  expect(next.result.continuation.output).toBe("advanced");
});

test.each([
  '{"type":"custom","id":"a","parentId":null,"data":{"a":1,"\\u0061":2}}\n',
  '{"type":"custom","id":"a","parentId":null}\nmalformed\n',
  '{"type":"custom","id":"a","parentId":null}\n{"type":"custom","id":"a","parentId":null}\n',
])("stable corrupt entries fail without progress (%#)", async (tail) => {
  const output = await read(header + tail);
  expect(output.code).toBe(1);
  expect(output.result.failure.issue).toBe("source-malformed");
  expect(output.result.bookmark).toBeNull();
});

test("unrecognized bookmark versions fail after native source validation", async () => {
  const token = btoa('{"bookmarkVersion":99}').replace(/=/g, "");
  const output = await read(header, { since: token });
  expect(output.code).toBe(1);
  expect(output.result.failure.issue).toBe("fresh-read-required");
  expect(output.result.continuation.input).toBe("invalid");
});

test("exact decimal values and escaped Unicode survive the wire", () => {
  const original =
    '{"large":9007199254740993,"decimal":1.234567890123456789,"huge":1e9000,"zero":-0,"surrogate":"\\ud800","object":{"__proto__":true}}';
  const encoded = encodeJson(parseNativeJson(original));
  expect(encoded).toBe(original);
});

test.each(["0", "-1", "1.5", "9007199254740992", "1e2"])(
  "invalid entry limit %s is refused",
  (limit) => {
    expect(() =>
      parseTranscriptOptions(["read", "pi", "--file", "/synthetic", "--limit", limit]),
    ).toThrow();
  },
);

test.each(["all", "history,invalid", "", "embeddedContent"])(
  "invalid opt-in %s is refused",
  (limits) => {
    expect(() =>
      parseTranscriptOptions(["read", "pi", "--file", "/synthetic", "--accept-limits", limits]),
    ).toThrow();
  },
);

test("named opt-ins are canonical and do not weaken source integrity", async () => {
  const options = parseTranscriptOptions([
    "read",
    "pi",
    "--file",
    "/synthetic",
    "--accept-limits",
    "embedded-content,history,history",
  ]);
  expect(options.acceptedLimits).toEqual(["history", "embedded-content"]);
  const output = await read(`${header}malformed\n`, { acceptedLimits: options.acceptedLimits });
  expect(output.code).toBe(1);
  expect(output.result.failure.issue).toBe("source-malformed");
});
