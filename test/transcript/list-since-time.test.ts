/**
 * `--since-time` exists to make the call cheaper, not only the output smaller.
 * The saving is the prefix read and the prefix parse, which together measure
 * about 450 ms of a 2.09 s call on a real store. So the property under test is
 * that a source outside the window is never opened.
 */
import { expect, test } from "vitest";
import type { ListSessionsDeps, ListSessionsRequest } from "../../src/execution/transcript/list.js";
import { listSessions } from "../../src/execution/transcript/list.js";
import type { TranscriptListing } from "../../src/interpretation/transcript/listings.js";

/** One store of ten sources, an hour apart, newest first. */
const SOURCES = Array.from({ length: 10 }, (_, index) => ({
  id: `s${index}`,
  lastWriteAt: `2026-09-20T${String(23 - index).padStart(2, "0")}:00:00.000Z`,
}));

const listing: TranscriptListing = {
  directories: [""],
  prune: () => false,
  // A read is declared, so a source inside the window costs an open.
  candidate: (path) => ({ id: path, file: path, readable: true, read: { path, bytes: 8 } }),
  index: null,
  session: (candidate, markers) => ({
    kind: "session",
    session: {
      id: candidate.id,
      file: candidate.file,
      cwd: "/synthetic",
      lastWriteAt: markers.lastWriteAt,
      startedAt: null,
      mode: "unknown",
      readable: true,
    },
  }),
};

function countingFiles(): { files: ListSessionsDeps["files"]; opens: () => number } {
  let opens = 0;
  return {
    opens: () => opens,
    files: {
      async *list() {
        for (const source of SOURCES) yield source.id;
      },
      sourceStat: async (path: string) => {
        const id = path.split("/").at(-1) ?? "";
        const found = SOURCES.find((source) => source.id === id);
        if (!found) throw new Error(`no stat for ${path}`);
        return { lastWriteAt: found.lastWriteAt, size: 1 };
      },
      async open() {
        opens++;
        return {
          close: async () => {},
          read: async () => new Uint8Array(),
          version: async () => ({ identity: "0:0", size: 0 }),
        };
      },
      version: () => Promise.reject(new Error("unused")),
    },
  };
}

async function list(sinceTime: string | null): Promise<{
  readonly ids: string[];
  readonly opens: number;
}> {
  const counting = countingFiles();
  const request: ListSessionsRequest = {
    harnesses: [
      {
        harness: "pi",
        listing,
        listingRoot: "/pi",
        readable: true,
        quiescentSiblings: [],
        divergence: null,
      },
    ],
    hcnVersion: "0.0.0-test",
    workspace: null,
    headless: true,
    limit: null,
    sinceTime,
  };
  const lines: string[] = [];
  await listSessions(request, {
    files: counting.files,
    snapshotFiles: counting.files,
    write: async (line) => {
      lines.push(line);
    },
  });
  const ids = lines
    .map((line) => JSON.parse(line) as { kind: string; id?: string })
    .filter((entry) => entry.kind === "session")
    .map((entry) => entry.id ?? "");
  return { ids, opens: counting.opens() };
}

test("a source outside the window is stat'd and never opened", async () => {
  const all = await list(null);
  expect(all.ids).toHaveLength(SOURCES.length);
  expect(all.opens).toBe(SOURCES.length);

  const recent = await list("2026-09-20T20:00:00.000Z");
  // 23:00, 22:00, 21:00 and 20:00 are in; the six older ones are not.
  expect(recent.ids).toEqual(["s0", "s1", "s2", "s3"]);
  // The saving, stated as the thing it is: four opens instead of ten.
  expect(recent.opens).toBe(4);
});

test("the window includes a source written exactly at the instant asked for", async () => {
  const boundary = await list("2026-09-20T23:00:00.000Z");
  expect(boundary.ids).toEqual(["s0"]);
  expect(boundary.opens).toBe(1);
});

test("a window later than every source returns nothing and opens nothing", async () => {
  const none = await list("2027-01-01T00:00:00.000Z");
  expect(none.ids).toEqual([]);
  expect(none.opens).toBe(0);
});

test("the source header repeats the window back", async () => {
  const counting = countingFiles();
  const lines: string[] = [];
  await listSessions(
    {
      harnesses: [
        {
          harness: "pi",
          listing,
          listingRoot: "/pi",
          readable: true,
          quiescentSiblings: [],
          divergence: null,
        },
      ],
      hcnVersion: "0.0.0-test",
      workspace: null,
      headless: true,
      limit: null,
      sinceTime: "2026-09-20T20:00:00.000Z",
    },
    {
      files: counting.files,
      snapshotFiles: counting.files,
      write: async (line) => {
        lines.push(line);
      },
    },
  );
  const source = JSON.parse(lines[0] ?? "{}") as { scope?: { sinceTime?: string | null } };
  expect(source.scope?.sinceTime).toBe("2026-09-20T20:00:00.000Z");
});
