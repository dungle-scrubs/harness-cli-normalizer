/**
 * The six stores are walked concurrently, so two facts have to hold that a
 * sequential walk got for free: the result keeps request order, and the whole
 * call - not one store - owns the open-source ceiling.
 */
import { expect, test } from "vitest";
import type { ListSessionsDeps, ListSessionsRequest } from "../../src/execution/transcript/list.js";
import { listSessions } from "../../src/execution/transcript/list.js";
import type {
  ListingCandidate,
  TranscriptListing,
} from "../../src/interpretation/transcript/listings.js";
import type { HarnessName } from "../../src/knowledge/descriptor.js";

/** The ceiling `list.ts` declares; the call may not exceed it. */
const OPEN_SOURCES = 32;
/** Enough sources per store that the ceiling is reached and held. */
const SOURCES = 60;

const listing: TranscriptListing = {
  directories: [""],
  prune: () => false,
  index: null,
  candidate(path): ListingCandidate | null {
    return {
      id: path.replace(/\.jsonl$/, ""),
      file: path,
      readable: true,
      read: { path, bytes: 8 },
    };
  },
  session(candidate, markers) {
    return {
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
    };
  },
};

interface OpenWatch {
  readonly files: ListSessionsDeps["files"];
  peak(): number;
  /** The most stores that ever had a source open at the same moment. */
  overlap(): number;
}

/** Files whose every open is counted, and whose reads yield the event loop so
 * the stores actually overlap rather than running to completion one at a time. */
function watchedFiles(): OpenWatch {
  const live = new Map<string, number>();
  let open = 0;
  let peak = 0;
  let overlap = 0;
  const store = (path: string): string => path.split("/")[1] ?? "";
  return {
    peak: () => peak,
    overlap: () => overlap,
    files: {
      async *list(path) {
        // The store name keeps each harness's IDs apart in the assertion.
        const name = store(path);
        for (let index = 0; index < SOURCES; index++) yield `${name}-${index}.jsonl`;
      },
      async open(path) {
        const name = store(path);
        live.set(name, (live.get(name) ?? 0) + 1);
        open++;
        peak = Math.max(peak, open);
        overlap = Math.max(overlap, live.size);
        return {
          close: async () => {
            open--;
            const held = (live.get(name) ?? 1) - 1;
            if (held === 0) live.delete(name);
            else live.set(name, held);
          },
          read: async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            return new Uint8Array();
          },
          version: async () => ({ identity: "0:0", size: 0 }),
        };
      },
      version: () => Promise.reject(new Error("unused")),
      writeTime: async () => "2026-09-20T00:00:00.000Z",
    },
  };
}

const HARNESSES: readonly HarnessName[] = ["pi", "claude", "antigravity", "codex"];

async function run(): Promise<{
  readonly lines: readonly string[];
  readonly peak: number;
  readonly overlap: number;
  readonly exitCode: number;
}> {
  const watch = watchedFiles();
  const request: ListSessionsRequest = {
    harnesses: HARNESSES.map((harness) => ({
      harness,
      listing,
      listingRoot: `/${harness}`,
      readable: true,
      divergence: null,
    })),
    hcnVersion: "0.0.0-test",
    workspace: null,
    headless: true,
    limit: null,
  };
  const lines: string[] = [];
  const exitCode = await listSessions(request, {
    files: watch.files,
    snapshotFiles: watch.files,
    write: async (line) => {
      lines.push(line);
    },
  });
  return { lines, peak: watch.peak(), overlap: watch.overlap(), exitCode };
}

test("the whole call holds the open-source ceiling, not one store each", async () => {
  const { peak, overlap, exitCode } = await run();
  expect(exitCode).toBe(0);
  // Four stores of 60 sources could hold 4 x 32 open if each owned its own
  // budget; the ceiling belongs to the call.
  expect(peak).toBeLessThanOrEqual(OPEN_SOURCES);
  expect(peak).toBe(OPEN_SOURCES);
  // A store-at-a-time walk never has two stores open at once.
  expect(overlap).toBeGreaterThan(1);
});

test("outcomes keep request order and every store contributes its rows", async () => {
  const { lines } = await run();
  const result = JSON.parse(lines.at(-1) ?? "{}") as {
    readonly rowsReturned: number;
    readonly harnesses: readonly { readonly harness: string; readonly rows: number }[];
  };
  expect(result.harnesses.map((item) => item.harness)).toEqual([...HARNESSES]);
  expect(result.harnesses.map((item) => item.rows)).toEqual(HARNESSES.map(() => SOURCES));
  expect(result.rowsReturned).toBe(HARNESSES.length * SOURCES);
});
