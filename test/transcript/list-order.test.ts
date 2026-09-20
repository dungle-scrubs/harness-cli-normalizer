/**
 * Rows are ordered `(lastWriteAt desc, harness asc, id asc)`. The synthetic
 * store in `list-store.ts` gives every session its own write time, so the tie
 * break is exercised only here. It is not a corner case: 14 of the 3191 rows
 * on the machine this was written against shared a `lastWriteAt` with another
 * row, across 5 distinct timestamps.
 */
import { expect, test } from "vitest";
import type { ListSessionsDeps, ListSessionsRequest } from "../../src/execution/transcript/list.js";
import { listSessions } from "../../src/execution/transcript/list.js";
import type { TranscriptListing } from "../../src/interpretation/transcript/listings.js";
import type { HarnessName } from "../../src/knowledge/descriptor.js";

const NEWEST = "2026-09-20T03:00:00.000Z";
const TIED = "2026-09-20T02:00:00.000Z";
const OLDEST = "2026-09-20T01:00:00.000Z";

/** Sources per store, and the write time each one reports. Two stores share
 * `TIED` and one store holds two sources at it, so both halves of the tie
 * break have to decide an order. */
const SOURCES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  // Written out of id order, so a store that kept walk order would be caught.
  claude: [
    ["c2", TIED],
    ["c1", TIED],
  ],
  codex: [
    ["x1", TIED],
    ["x2", NEWEST],
  ],
  pi: [
    ["p1", TIED],
    ["p2", OLDEST],
  ],
};

const listing: TranscriptListing = {
  directories: [""],
  prune: () => false,
  index: null,
  // `read: null` keeps the row off the filesystem: the write time is the only
  // marker this listing needs.
  candidate: (path) => ({ id: path, file: path, readable: true, read: null }),
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

const files: ListSessionsDeps["files"] = {
  async *list(path) {
    const store = path.split("/")[1] ?? "";
    for (const [id] of SOURCES[store] ?? []) yield id;
  },
  writeTime: async (path) => {
    const [, store = "", id = ""] = path.split("/");
    const found = SOURCES[store]?.find(([name]) => name === id);
    if (!found) throw new Error(`no write time for ${path}`);
    return found[1];
  },
  open: () => Promise.reject(new Error("unused")),
  version: () => Promise.reject(new Error("unused")),
};

/** Deliberately not the sort's harness order, so request order cannot pass as
 * the tie break by accident. */
const REQUESTED: readonly HarnessName[] = ["pi", "codex", "claude"];

async function rows(order: readonly HarnessName[] = REQUESTED): Promise<string[]> {
  const request: ListSessionsRequest = {
    harnesses: order.map((harness) => ({
      harness,
      listing,
      listingRoot: `/${harness}`,
      readable: true,
      quiescentSiblings: [],
      divergence: null,
    })),
    hcnVersion: "0.0.0-test",
    workspace: null,
    headless: true,
    limit: null,
  };
  const lines: string[] = [];
  await listSessions(request, {
    files,
    snapshotFiles: files,
    write: async (line) => {
      lines.push(line);
    },
  });
  return lines
    .map((line) => JSON.parse(line) as { kind: string; harness?: string; id?: string })
    .filter((entry) => entry.kind === "session")
    .map((entry) => `${entry.harness}:${entry.id}`);
}

test("rows tied on lastWriteAt break on harness, then on id", async () => {
  expect(await rows()).toEqual([
    // Newest first, whatever its harness.
    "codex:x2",
    // Then the tie, by harness ascending.
    "claude:c1",
    "claude:c2",
    "codex:x1",
    "pi:p1",
    // Oldest last.
    "pi:p2",
  ]);
});

test("the tie order does not move when the stores are requested in another order", async () => {
  expect(await rows(["claude", "codex", "pi"])).toEqual(await rows(["pi", "codex", "claude"]));
  expect(await rows(["codex", "pi", "claude"])).toEqual(await rows(REQUESTED));
});
