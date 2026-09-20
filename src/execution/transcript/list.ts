import { join } from "node:path";
import { failure } from "../../interpretation/transcript/envelopes.js";
import { encodeJson, TranscriptError } from "../../interpretation/transcript/json.js";
import type {
  ListedSession,
  ListingCandidate,
  TranscriptListing,
} from "../../interpretation/transcript/listings.js";
import type { HarnessName } from "../../knowledge/descriptor.js";
import type {
  HarnessListing,
  SessionBlock,
  SessionListResult,
  SessionListSource,
  SessionRow,
} from "../../knowledge/transcript/listing.js";
import type { Issue } from "../../knowledge/transcript/wire.js";
import type { TranscriptFiles } from "./files.js";

/** The most bytes one candidate's markers may cost. Every observed store names
 * its workspace far inside this, and the cap keeps one oversized log from
 * reading a whole store into memory. */
const MAX_PREFIX_BYTES = 4 * 1024 * 1024;
/** How many of a call's sources are open at once. Each candidate is read
 * independently, and a store holds thousands, so reading them one at a time
 * spends the whole listing waiting on the filesystem. The listings run
 * concurrently, so this ceiling is the whole call's rather than one store's.
 */
const OPEN_SOURCES = 32;

/** Runs one source read at a time per free slot, holding the rest until a
 * slot frees. A released slot passes straight to the next waiter, so the
 * count cannot drift when several stores ask at once. */
function openBudget(limit: number): <TResult>(run: () => Promise<TResult>) => Promise<TResult> {
  let free = limit;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}
type OpenBudget = ReturnType<typeof openBudget>;

/** What one store's walk contributed. A null outcome is a store that saw the
 * caller's interruption and has nothing to report. */
interface HarnessWalk {
  readonly outcome: HarnessListing | null;
  readonly rows: readonly SessionRow[];
}

export interface HarnessListingRequest {
  readonly harness: HarnessName;
  /** The listing this harness contributes, or null where it has none. */
  readonly listing: TranscriptListing | null;
  readonly listingRoot: string | null;
  /** Whether `transcript read` has a verified method for this harness. */
  readonly readable: boolean;
  /** Sibling suffixes this harness's reader requires absent or empty around a
   * capture, as the reader declares them. Empty where it requires none. */
  readonly quiescentSiblings: readonly string[];
  /** Why this harness contributes no listing; null when it contributes one. */
  readonly divergence: string | null;
}
export interface ListSessionsRequest {
  readonly harnesses: readonly HarnessListingRequest[];
  readonly hcnVersion: string;
  /** The workspace rows must match exactly, or null under --all-workspaces. */
  readonly workspace: string | null;
  readonly headless: boolean;
  readonly limit: number | null;
}
export interface ListSessionsDeps {
  readonly files: TranscriptFiles;
  /** Files that can take a passive filesystem clone, for an index needing one. */
  readonly snapshotFiles: TranscriptFiles;
  readonly signal?: AbortSignal;
  readonly write: (line: string) => Promise<void>;
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function issueOf(error: unknown): Issue {
  if (error instanceof TranscriptError) return error.issue;
  return missing(error) ? "source-not-found" : "source-inaccessible";
}
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "The native store could not be listed.";
}

/** The store-wide index a listing declares, or null when the store has none. */
async function captureIndex(
  listing: TranscriptListing,
  root: string,
  deps: ListSessionsDeps,
): Promise<Uint8Array | null> {
  const index = listing.index;
  if (!index) return null;
  const path = join(root, index.path);
  for (const suffix of index.quiescentSiblings) {
    let sibling: Awaited<ReturnType<TranscriptFiles["version"]>>;
    try {
      sibling = await deps.files.version(`${path}${suffix}`);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (sibling.size !== 0)
      throw new TranscriptError(
        "guarantee-unmet",
        "The native conversation index holds uncheckpointed writes; list it after the native session closes.",
        "consistency",
      );
  }
  const files = index.snapshot ? deps.snapshotFiles : deps.files;
  if (index.snapshot && !files.snapshot)
    throw new TranscriptError(
      "guarantee-unmet",
      "A passive filesystem snapshot is required.",
      "consistency",
    );
  let file: Awaited<ReturnType<TranscriptFiles["open"]>>;
  try {
    file = index.snapshot && files.snapshot ? await files.snapshot(path) : await files.open(path);
  } catch (error) {
    // A store that has not written its index yet still lists its conversations.
    if (missing(error)) return null;
    throw error;
  }
  try {
    return await file.read((await file.version()).size);
  } finally {
    await file.close();
  }
}

/** One session and the precondition, if any, that a read of it would refuse
 * on right now. */
interface WalkedSession {
  readonly session: ListedSession;
  readonly blocked: SessionBlock | null;
}

/**
 * The cheap precondition a read of this source would fail on, or null when
 * none was observed to. This is the same check `captureSource` makes before a
 * read, and the same one `captureIndex` already makes for a store-wide index;
 * running it here lets a consumer tell "no method for this" from "busy right
 * now". A sibling that cannot be stat'd leaves the answer null: the listing
 * does not know, and the read still decides.
 */
async function blockedBy(
  path: string,
  siblings: readonly string[],
  files: TranscriptFiles,
): Promise<SessionBlock | null> {
  for (const suffix of siblings) {
    let sibling: Awaited<ReturnType<TranscriptFiles["version"]>>;
    try {
      sibling = await files.version(`${path}${suffix}`);
    } catch {
      continue;
    }
    if (sibling.size !== 0)
      return {
        issue: "guarantee-unmet",
        reason: `The native source holds uncheckpointed writes in its ${suffix} sibling; read it after the native session closes.`,
      };
  }
  return null;
}

/** One candidate's markers, growing the prefix until the listing has them. */
async function readSession(
  listing: TranscriptListing,
  candidate: ListingCandidate,
  root: string,
  index: Uint8Array | null,
  lastWriteAt: string,
  files: TranscriptFiles,
): Promise<ListedSession | null> {
  const read = candidate.read;
  if (!read) {
    const result = listing.session(candidate, {
      bytes: new Uint8Array(),
      final: true,
      index,
      lastWriteAt,
    });
    return result.kind === "session" ? result.session : null;
  }
  const file = await files.open(join(root, read.path));
  try {
    const size = (await file.version()).size;
    let want = Math.min(size, read.bytes);
    for (;;) {
      const bytes = await file.read(want);
      const final = want >= size || want >= MAX_PREFIX_BYTES;
      const result = listing.session(candidate, { bytes, final, index, lastWriteAt });
      if (result.kind === "session") return result.session;
      if (result.kind === "skip" || final) return null;
      want = Math.min(size, MAX_PREFIX_BYTES, Math.max(want * 8, read.bytes + 1));
    }
  } finally {
    await file.close();
  }
}

async function listHarness(
  entry: HarnessListingRequest & {
    readonly listing: TranscriptListing;
    readonly listingRoot: string;
  },
  deps: ListSessionsDeps,
  checkAbort: () => void,
  openSource: OpenBudget,
): Promise<{ readonly sessions: readonly WalkedSession[]; readonly unreadable: number }> {
  const { listing, listingRoot: root } = entry;
  const writeTime = deps.files.writeTime;
  if (!deps.files.list || !writeTime)
    throw new TranscriptError("source-inaccessible", "Native store listing is unavailable.");
  const index = await openSource(() => captureIndex(listing, root, deps));
  checkAbort();
  const candidates: ListingCandidate[] = [];
  for (const directory of listing.directories) {
    const base = join(root, directory);
    for await (const name of deps.files.list(base, true, (item) => listing.prune(item))) {
      checkAbort();
      const candidate = listing.candidate(directory ? `${directory}/${name}` : name);
      if (candidate) candidates.push(candidate);
    }
  }
  const files = deps.files;
  let unreadable = 0;
  const read = await Promise.all(
    candidates.map((candidate) =>
      openSource(async () => {
        checkAbort();
        try {
          const lastWriteAt = await writeTime(join(root, candidate.file));
          const found = await readSession(listing, candidate, root, index, lastWriteAt, files);
          if (!found) return null;
          const file = join(root, found.file);
          return {
            session: { ...found, file },
            blocked: entry.quiescentSiblings.length
              ? await blockedBy(file, entry.quiescentSiblings, files)
              : null,
          };
        } catch (error) {
          // One source that vanished or cannot be opened is a gap in this
          // harness's coverage, not a failure of the listing.
          if (error instanceof TranscriptError && error.issue === "interrupted") throw error;
          unreadable++;
          return null;
        }
      }),
    ),
  );
  return {
    sessions: read.filter((walked): walked is WalkedSession => walked !== null),
    unreadable,
  };
}

export async function listSessions(
  request: ListSessionsRequest,
  deps: ListSessionsDeps,
): Promise<number> {
  const checkAbort = (): void => {
    if (deps.signal?.aborted)
      throw new TranscriptError("interrupted", "The caller interrupted the native listing.");
  };
  const source: SessionListSource = {
    schemaVersion: 1,
    kind: "session-list-source",
    hcnVersion: request.hcnVersion,
    harnesses: request.harnesses.map((entry) => entry.harness),
    scope: {
      workspace: request.workspace,
      headless: request.headless,
      limit: request.limit,
    },
  };
  // The six stores are unrelated directories sharing no state, so the call is
  // bounded by the slowest walk rather than by their sum. Each listing keeps
  // its own rows and outcome, which are assembled in request order below, so
  // the concurrency cannot reorder the result.
  const openSource = openBudget(OPEN_SOURCES);
  const walked = await Promise.all(
    request.harnesses.map(async (entry): Promise<HarnessWalk> => {
      if (!entry.listing || !entry.listingRoot)
        return {
          outcome: {
            harness: entry.harness,
            state: "divergent",
            storeRoot: entry.listingRoot,
            rows: 0,
            reason: entry.divergence ?? `${entry.harness} has no transcript listing method.`,
            issue: "transcript-divergence",
          },
          rows: [],
        };
      const scoped = { ...entry, listing: entry.listing, listingRoot: entry.listingRoot };
      try {
        const { sessions, unreadable } = await listHarness(scoped, deps, checkAbort, openSource);
        const kept = sessions.filter(
          ({ session }) =>
            (request.workspace === null || session.cwd === request.workspace) &&
            (request.headless || session.mode !== "headless"),
        );
        return {
          outcome: {
            harness: entry.harness,
            state: "listed",
            storeRoot: entry.listingRoot,
            rows: kept.length,
            reason: unreadable
              ? `${unreadable} native source(s) under this store could not be read.`
              : null,
            issue: unreadable ? "source-inaccessible" : null,
          },
          rows: kept.map(({ session, blocked }) => ({
            schemaVersion: 1,
            kind: "session",
            harness: entry.harness,
            id: session.id,
            file: session.file,
            cwd: session.cwd,
            lastWriteAt: session.lastWriteAt,
            startedAt: session.startedAt,
            mode: session.mode,
            readable: entry.readable && session.readable,
            blocked,
          })),
        };
      } catch (error) {
        // Several stores can see the same interruption at once; the call
        // reports one, and a store that had already finished keeps its outcome.
        if (error instanceof TranscriptError && error.issue === "interrupted")
          return { outcome: null, rows: [] };
        return {
          outcome: {
            harness: entry.harness,
            state: "failed",
            storeRoot: entry.listingRoot,
            rows: 0,
            reason: reasonOf(error),
            issue: issueOf(error),
          },
          rows: [],
        };
      }
    }),
  );
  const interrupted = walked.some((walk) => walk.outcome === null);
  const outcomes = walked
    .map((walk) => walk.outcome)
    .filter((outcome): outcome is HarnessListing => outcome !== null);
  const rows = walked.flatMap((walk) => walk.rows);
  rows.sort(
    (a, b) =>
      b.lastWriteAt.localeCompare(a.lastWriteAt) ||
      a.harness.localeCompare(b.harness) ||
      a.id.localeCompare(b.id),
  );
  const limited = request.limit === null ? rows : rows.slice(0, request.limit);
  const degraded = outcomes.some((outcome) => outcome.state !== "listed");
  const result: SessionListResult = interrupted
    ? {
        schemaVersion: 1,
        kind: "session-list-result",
        exitCode: 1,
        status: "failed",
        rowsReturned: 0,
        more: false,
        harnesses: outcomes,
        failure: failure("interrupted", "read", "retrieval", "The caller interrupted the listing."),
      }
    : {
        schemaVersion: 1,
        kind: "session-list-result",
        exitCode: 0,
        status: degraded ? "partial" : "complete",
        rowsReturned: limited.length,
        more: limited.length < rows.length,
        harnesses: outcomes,
        failure: null,
      };
  await deps.write(`${encodeJson(source)}\n`);
  if (!interrupted) for (const row of limited) await deps.write(`${encodeJson(row)}\n`);
  await deps.write(`${encodeJson(result)}\n`);
  return result.exitCode;
}
