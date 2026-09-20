import type { HarnessName } from "../../knowledge/descriptor.js";
import { UUID_SHAPE } from "../../knowledge/descriptor.js";
import type { SessionMode } from "../../knowledge/transcript/listing.js";
import type { Json, JsonObject } from "./json.js";
import { integer, object, parseNativeJson, string } from "./json.js";
import { SqliteImage } from "./sqlite.js";
import { utcTime, utcTimeFromEpochMicros, utcTimeFromEpochMillis } from "./time.js";

/** One walked path a harness recognizes as a saved session. */
export interface ListingCandidate {
  /** The native ID, as `transcript read --id` accepts it; "" until the
   * session's own header supplies one. */
  readonly id: string;
  /** The native transcript source, relative to the listing root. */
  readonly file: string;
  /** Whether `transcript read` has a verified method for this source shape. */
  readonly readable: boolean;
  /** The bytes this candidate's markers need, or null when it needs none. */
  readonly read: { readonly path: string; readonly bytes: number } | null;
}

/** One session, before the harness name and the method-level readability of
 * `SessionRow` are stamped on it. */
export interface ListedSession {
  readonly id: string;
  readonly file: string;
  readonly cwd: string | null;
  readonly lastWriteAt: string;
  /** When the native header says the session began, or null where the store
   * records no start time. A filesystem observation is never substituted. */
  readonly startedAt: string | null;
  readonly mode: SessionMode;
  readonly readable: boolean;
}

export interface ListingMarkers {
  /** The candidate's bytes; empty when it declared no read. */
  readonly bytes: Uint8Array;
  /** Whether this is the last prefix the caller will read: the whole file, or
   * the listing's read cap. */
  readonly final: boolean;
  /** The listing's index bytes, or null when it declares no index. */
  readonly index: Uint8Array | null;
  readonly lastWriteAt: string;
}

export type ListedResult =
  | { readonly kind: "session"; readonly session: ListedSession }
  /** No session of this harness, or a child conversation. */
  | { readonly kind: "skip" }
  /** The markers lie beyond the prefix; read more and ask again. */
  | { readonly kind: "truncated" };

export interface TranscriptListing {
  /** Directories under the listing root to walk; "" is the root itself. */
  readonly directories: readonly string[];
  /** Directory names that hold no session of this harness. */
  prune(name: string): boolean;
  /** One store-wide file every row reads, relative to the listing root. */
  readonly index: {
    readonly path: string;
    /** A passive filesystem clone is required to read it consistently. */
    readonly snapshot: boolean;
    /** Sibling suffixes that must be absent or empty around the capture. */
    readonly quiescentSiblings: readonly string[];
  } | null;
  /** The candidate a walked path names, or null when it names no session. */
  candidate(path: string): ListingCandidate | null;
  session(candidate: ListingCandidate, markers: ListingMarkers): ListedResult;
}

const SKIP: ListedResult = { kind: "skip" };
const TRUNCATED: ListedResult = { kind: "truncated" };
const NO_PRUNE = (): boolean => false;
/** A first prefix that holds the identity records of every observed store. */
export const LISTING_PREFIX_BYTES = 65536;

function found(session: ListedSession): ListedResult {
  return { kind: "session", session };
}

/** A native ISO 8601 UTC marker, normalized to millisecond precision. */
const isoTime = (value: Json | undefined): string | null => {
  const text = string(value);
  return text === null ? null : utcTime(text);
};
/** Muse counts a record's time in microseconds since the epoch. */
const microsTime = (value: Json | undefined): string | null => {
  const micros = integer(value);
  return micros === null ? null : utcTimeFromEpochMicros(micros);
};
/** Cursor counts its chat's creation in milliseconds since the epoch. */
const millisTime = (value: Json | undefined): string | null => {
  const millis = integer(value);
  return millis === null ? null : utcTimeFromEpochMillis(millis);
};

/**
 * A session whose store names no workspace and no mode. The default workspace
 * scope drops it, so it surfaces only under `--all-workspaces`, where dropping
 * it outright would hide a saved session.
 *
 * A missing workspace does not make the start time missing too: the prefix the
 * scan already read can carry one, and the caller passes what it found.
 */
function unmarked(
  candidate: ListingCandidate,
  markers: ListingMarkers,
  startedAt: string | null = null,
  id?: string,
): ListedResult {
  return found({
    id: id ?? candidate.id,
    file: candidate.file,
    cwd: null,
    lastWriteAt: markers.lastWriteAt,
    startedAt,
    mode: "unknown",
    readable: candidate.readable,
  });
}

/**
 * The complete LF-framed JSON objects of a prefix, one at a time. A line this
 * listing cannot parse is not a marker, so it is skipped rather than failing
 * the harness.
 *
 * Every caller wants the first record carrying a marker, not all of them, and
 * the parse is the largest cost in the call: on a real store claude parses
 * 18.4 records per candidate to use 3.4, and codex parses 5.3 to use 1. So
 * each line is sliced, decoded and parsed only when the caller asks for it,
 * and a caller that has its markers stops the scan by returning.
 */
function* prefixEntries(bytes: Uint8Array): Generator<JsonObject> {
  const end = bytes.lastIndexOf(10);
  if (end < 0) return;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let start = 0;
  while (start < end) {
    let stop = bytes.indexOf(10, start);
    if (stop < 0 || stop > end) stop = end;
    if (stop > start) {
      let value: Json;
      try {
        value = parseNativeJson(decoder.decode(bytes.subarray(start, stop)));
      } catch {
        value = null;
      }
      const entry = object(value);
      if (entry) yield entry;
    }
    start = stop + 1;
  }
}

/** The first record satisfying `want`, or null when the prefix holds none. */
function firstEntry(bytes: Uint8Array, want: (entry: JsonObject) => boolean): JsonObject | null {
  for (const entry of prefixEntries(bytes)) if (want(entry)) return entry;
  return null;
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? "";
}

/** The path's segments with the last one dropped. */
function parent(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/**
 * Claude files one main transcript per session under its project directory.
 * `cwd` and `entrypoint` sit on every user and assistant record, but summary
 * records can precede the first one, so the prefix is scanned rather than only
 * its first line.
 */
const claudeListing: TranscriptListing = {
  directories: [""],
  prune: NO_PRUNE,
  index: null,
  candidate(path) {
    const name = basename(path);
    const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
    if (!UUID_SHAPE.test(id)) return null;
    return { id, file: path, readable: true, read: { path, bytes: LISTING_PREFIX_BYTES } };
  },
  session(candidate, markers) {
    // Three markers off one pass, each taken from the first record carrying
    // it. A transcript opens with settings records that carry none of them.
    let identity: JsonObject | null = null;
    let entrypoint: string | null = null;
    let startedAt: string | null = null;
    for (const entry of prefixEntries(markers.bytes)) {
      if (!identity && string(entry.cwd) !== null) identity = entry;
      entrypoint ??= string(entry.entrypoint);
      startedAt ??= isoTime(entry.timestamp);
      if (identity && entrypoint !== null && startedAt !== null) break;
    }
    if (!identity) return markers.final ? unmarked(candidate, markers, startedAt) : TRUNCATED;
    // A sidechain file is the agent's own conversation, not the session's.
    if (identity.isSidechain === true) return SKIP;
    return found({
      id: candidate.id,
      file: candidate.file,
      cwd: string(identity.cwd),
      lastWriteAt: markers.lastWriteAt,
      startedAt,
      mode: claudeMode(entrypoint),
      readable: candidate.readable,
    });
  },
};

/** `cli` is the interactive terminal; every `sdk-` entrypoint is a headless
 * caller driving the same binary. An entrypoint hcn has not observed reports
 * `unknown` rather than guessing a side. */
function claudeMode(entrypoint: string | null): SessionMode {
  if (entrypoint === "cli") return "interactive";
  return entrypoint?.startsWith("sdk") ? "headless" : "unknown";
}

const CODEX_ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl(\.zst)?$/i;

/**
 * Codex files one rollout per thread under a dated directory. Its first record
 * is `session_meta`, whose payload names the workspace, the caller and - for a
 * spawned agent thread - its parent.
 */
const codexListing: TranscriptListing = {
  directories: ["sessions", "archived_sessions"],
  prune: NO_PRUNE,
  index: null,
  candidate(path) {
    const match = CODEX_ROLLOUT.exec(basename(path));
    const id = match?.[1] ?? "";
    if (!match || !UUID_SHAPE.test(id)) return null;
    // A compressed rollout is a source this reader refuses on sight.
    if (match[2]) return { id, file: path, readable: false, read: null };
    return { id, file: path, readable: true, read: { path, bytes: LISTING_PREFIX_BYTES } };
  },
  session(candidate, markers) {
    if (!candidate.readable) return unmarked(candidate, markers);
    const meta = firstEntry(markers.bytes, (entry) => entry.type === "session_meta");
    const payload = object(meta?.payload);
    if (!payload) return markers.final ? unmarked(candidate, markers) : TRUNCATED;
    // A spawned agent thread carries its parent in `source`; it is a child
    // conversation, so it is not a row of its own.
    if (object(object(payload.source)?.subagent)) return SKIP;
    return found({
      id: candidate.id,
      file: candidate.file,
      cwd: string(payload.cwd),
      lastWriteAt: markers.lastWriteAt,
      // The rollout's time is on the `session_meta` record, not its payload.
      startedAt: isoTime(meta?.timestamp),
      mode: codexMode(string(payload.source), string(payload.originator)),
      readable: true,
    });
  },
};

/** `exec` and the `codex_exec` originator are the headless entry; the TUI, the
 * CLI, the editor extensions and the desktop app are interactive. */
function codexMode(source: string | null, originator: string | null): SessionMode {
  if (source === "exec" || originator === "codex_exec") return "headless";
  return source !== null || originator !== null ? "interactive" : "unknown";
}

/**
 * Pi files one transcript per session under a directory named for the
 * workspace. The file name prefixes the ID with a timestamp whose separator
 * also occurs in IDs, so identity comes from the v3 session header.
 */
const piListing: TranscriptListing = {
  directories: [""],
  prune: NO_PRUNE,
  index: null,
  candidate(path) {
    const name = basename(path);
    if (!name.endsWith(".jsonl") || !name.includes("_")) return null;
    return { id: "", file: path, readable: true, read: { path, bytes: LISTING_PREFIX_BYTES } };
  },
  session(candidate, markers) {
    const [header] = prefixEntries(markers.bytes);
    if (!header) return markers.final ? SKIP : TRUNCATED;
    const id = string(header.id);
    if (header.type !== "session" || !id || !basename(candidate.file).endsWith(`_${id}.jsonl`))
      return SKIP;
    return found({
      id,
      file: candidate.file,
      cwd: string(header.cwd),
      lastWriteAt: markers.lastWriteAt,
      startedAt: isoTime(header.timestamp),
      // No observed Pi record separates a headless run from a terminal one.
      mode: "unknown",
      readable: candidate.readable,
    });
  },
};

/**
 * Muse files one session log per session directory and nests each agent's own
 * log under `subagent/`. The workspace is on the session's opening metadata
 * record.
 */
const museListing: TranscriptListing = {
  directories: [""],
  // `subagent` holds child conversations; a dotted directory is Muse's own view
  // cache, never a session.
  prune: (name) => name === "subagent" || name.startsWith("."),
  index: null,
  candidate(path) {
    if (basename(path) !== "session.jsonl") return null;
    const id = basename(parent(path));
    if (!id) return null;
    return { id, file: path, readable: true, read: { path, bytes: LISTING_PREFIX_BYTES } };
  },
  session(candidate, markers) {
    let workspace: string | undefined;
    let startedAt: string | null = null;
    for (const entry of prefixEntries(markers.bytes)) {
      workspace ??= string(object(object(entry.payload)?.record)?.workspace_root) ?? undefined;
      startedAt ??= microsTime(entry.recorded_at);
      if (workspace !== undefined && startedAt !== null) break;
    }
    if (workspace === undefined)
      return markers.final ? unmarked(candidate, markers, startedAt) : TRUNCATED;
    return found({
      id: candidate.id,
      file: candidate.file,
      cwd: workspace,
      lastWriteAt: markers.lastWriteAt,
      // The opening frame envelope carries no time; the payload records do.
      startedAt,
      // `runtime.session.route_facts` records terminal facts for headless and
      // terminal sessions alike, so it does not separate the two.
      mode: "unknown",
      readable: candidate.readable,
    });
  },
};

/**
 * Cursor files one chat store per agent under a directory named for the md5 of
 * its workspace, which is one-way. Its sibling `meta.json` names the workspace
 * outright, and it holds none of the credential fields the store's meta row
 * carries.
 */
const cursorListing: TranscriptListing = {
  directories: ["chats"],
  prune: NO_PRUNE,
  index: null,
  candidate(path) {
    if (basename(path) !== "store.db") return null;
    const directory = parent(path);
    const id = basename(directory);
    if (!UUID_SHAPE.test(id)) return null;
    return {
      id,
      file: path,
      readable: true,
      read: { path: `${directory}/meta.json`, bytes: LISTING_PREFIX_BYTES },
    };
  },
  session(candidate, markers) {
    let meta: JsonObject | null = null;
    try {
      meta = object(
        parseNativeJson(new TextDecoder("utf-8", { fatal: true }).decode(markers.bytes)),
      );
    } catch {
      meta = null;
    }
    if (!meta) return markers.final ? unmarked(candidate, markers) : TRUNCATED;
    return found({
      id: candidate.id,
      file: candidate.file,
      cwd: string(meta.cwd),
      lastWriteAt: markers.lastWriteAt,
      startedAt: millisTime(meta.createdAtMs),
      // No observed Cursor chat store separates a headless run from a terminal one.
      mode: "unknown",
      readable: candidate.readable,
    });
  },
};

const ANTIGRAVITY_LOG =
  /^brain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/\.system_generated\/logs\/transcript_full\.jsonl$/i;
const ANTIGRAVITY_SUMMARIES = "conversation_summaries";

interface AntigravitySummary {
  readonly workspace: string | null;
  readonly child: boolean;
}

/** One parse of the conversation index per capture, not per conversation. */
const antigravityIndexes = new WeakMap<Uint8Array, Map<string, AntigravitySummary>>();

/** `file:///absolute/path` as the absolute path it names. */
function fileUriPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const path = uri.slice("file://".length).replace(/^[^/]*/, "");
  if (!path.startsWith("/")) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function antigravitySummaries(bytes: Uint8Array): Map<string, AntigravitySummary> {
  const cached = antigravityIndexes.get(bytes);
  if (cached) return cached;
  const image = new SqliteImage(bytes);
  const table = image.tables().find((item) => item.name === ANTIGRAVITY_SUMMARIES);
  if (!table) throw new Error(`the ${ANTIGRAVITY_SUMMARIES} table is absent`);
  // Column order comes from the table's own definition, so a new column ahead
  // of the ones read here cannot shift them.
  const columns = new Map<string, number>();
  for (const [, name] of table.sql.slice(table.sql.indexOf("(")).matchAll(/`([^`]+)`/g))
    if (name !== undefined && !columns.has(name)) columns.set(name, columns.size);
  const at = (row: readonly unknown[], name: string): unknown => {
    const index = columns.get(name);
    return index === undefined ? undefined : row[index];
  };
  const summaries = new Map<string, AntigravitySummary>();
  for (const row of image.rows(table.rootPage)) {
    const id = at(row, "conversation_id");
    if (typeof id !== "string") continue;
    const uris = at(row, "workspace_uris");
    let workspace: string | null = null;
    if (typeof uris === "string")
      try {
        const parsed: unknown = JSON.parse(uris);
        const first = Array.isArray(parsed) ? parsed[0] : null;
        workspace = typeof first === "string" ? fileUriPath(first) : null;
      } catch {
        workspace = null;
      }
    const parentId = at(row, "parent_conversation_id");
    const depth = at(row, "nesting_depth");
    summaries.set(id, {
      workspace,
      child:
        (typeof parentId === "string" && parentId !== "") ||
        (typeof depth === "bigint" && depth > 0n),
    });
  }
  antigravityIndexes.set(bytes, summaries);
  return summaries;
}

/**
 * Antigravity files one untruncated step log per conversation directory. The
 * log carries no workspace, so the workspace and the parent link come from the
 * conversation index that sits beside the brain directory. The log's own first
 * step carries the start time, which the index does not: `last_modified_time`
 * is a modification, not a beginning.
 */
const antigravityListing: TranscriptListing = {
  directories: ["brain"],
  prune: NO_PRUNE,
  index: {
    path: `${ANTIGRAVITY_SUMMARIES}.db`,
    snapshot: true,
    quiescentSiblings: ["-wal", "-journal"],
  },
  candidate(path) {
    const id = ANTIGRAVITY_LOG.exec(path)?.[1];
    return id
      ? { id, file: path, readable: true, read: { path, bytes: LISTING_PREFIX_BYTES } }
      : null;
  },
  session(candidate, markers) {
    const summary = markers.index ? antigravitySummaries(markers.index).get(candidate.id) : null;
    if (summary?.child) return SKIP;
    let steps = 0;
    let startedAt: string | null = null;
    for (const entry of prefixEntries(markers.bytes)) {
      steps++;
      startedAt = isoTime(entry.created_at);
      if (startedAt !== null) break;
    }
    // A step longer than the first prefix is the only reason to read more; a
    // log that simply stopped writing `created_at` reports null instead.
    if (steps === 0 && !markers.final) return TRUNCATED;
    return found({
      id: candidate.id,
      file: candidate.file,
      cwd: summary?.workspace ?? null,
      lastWriteAt: markers.lastWriteAt,
      startedAt,
      // No observed Antigravity record separates a headless run from a terminal one.
      mode: "unknown",
      readable: candidate.readable,
    });
  },
};

const LISTINGS: Readonly<Record<HarnessName, TranscriptListing>> = {
  antigravity: antigravityListing,
  claude: claudeListing,
  codex: codexListing,
  cursor: cursorListing,
  muse: museListing,
  pi: piListing,
};

/** The listing one harness contributes, or null where it has none. */
export function listingForHarness(harness: HarnessName): TranscriptListing | null {
  return LISTINGS[harness] ?? null;
}
