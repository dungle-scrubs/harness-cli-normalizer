import type { HarnessName } from "../descriptor.js";
import type { Issue, TranscriptFailure } from "./wire.js";

/**
 * Whether a saved session was driven from a terminal or by a headless caller.
 * `unknown` is the answer where the native store carries no marker; a consumer
 * treats it as interactive unless it knows otherwise.
 */
export type SessionMode = "interactive" | "headless" | "unknown";

/**
 * A cheap precondition a read of this source would refuse on right now. It is
 * an observation taken while listing, not a promise about the read: a native
 * session can open between the two.
 */
export interface SessionBlock {
  readonly issue: Issue;
  readonly reason: string;
}

/** One saved native session. */
export interface SessionRow {
  readonly schemaVersion: 1;
  readonly kind: "session";
  readonly harness: HarnessName;
  /** The native ID, as `transcript read --id` accepts it. */
  readonly id: string;
  /** The native path, as `transcript read --file` accepts it. */
  readonly file: string;
  /** The workspace the session ran in, or null where the store names none. */
  readonly cwd: string | null;
  /** The last native write to the source, as the filesystem reports it. It is
   * the sort key because it is the one time every store can produce, not
   * because it is the best time available: a copy or a restore rewrites it. */
  readonly lastWriteAt: string;
  /** When the native header says the session began, or null where the store
   * records no start time. Normalized to `YYYY-MM-DDTHH:MM:SS.mmmZ` from the
   * four shapes the stores write. `lastWriteAt` is never substituted for it. */
  readonly startedAt: string | null;
  /** The row's own native source in bytes, from the stat the walk already
   * takes. It says what a `transcript read` of this row would have to get
   * through; it is not a record count, which no store makes cheap. */
  readonly sizeBytes: number;
  readonly mode: SessionMode;
  /** Whether `transcript read` has a verified method for this source. This
   * answers "is there a method", not "will the read succeed". */
  readonly readable: boolean;
  /** The precondition a read would refuse on right now, or null when no cheap
   * check was observed to fail. Null is not a promise that the read will
   * succeed: it means nothing this listing could check cheaply said otherwise. */
  readonly blocked: SessionBlock | null;
}

/**
 * What one harness contributed. `divergent` is a harness with no listing
 * method - the dimension it cannot express, reported rather than faked.
 */
export type HarnessListingState = "listed" | "divergent" | "failed";

export interface HarnessListing {
  readonly harness: HarnessName;
  readonly state: HarnessListingState;
  readonly storeRoot: string | null;
  /** Rows this harness contributed, after the workspace and headless filters
   * and before `--limit`. It is not the number printed: `--limit` applies to
   * the sorted set of every harness's rows, and the printed count is the
   * result's `rowsReturned`. */
  readonly rows: number;
  readonly reason: string | null;
  readonly issue: Issue | null;
}

export interface SessionListSource {
  readonly schemaVersion: 1;
  readonly kind: "session-list-source";
  readonly hcnVersion: string;
  readonly harnesses: readonly HarnessName[];
  readonly scope: {
    /** The workspace rows must match exactly, or null under --all-workspaces. */
    readonly workspace: string | null;
    /** Whether headless runs are admitted. */
    readonly headless: boolean;
    readonly limit: number | null;
  };
}

export interface SessionListResult {
  readonly schemaVersion: 1;
  readonly kind: "session-list-result";
  readonly exitCode: 0 | 1 | 2;
  /**
   * `complete` when every requested harness listed, `partial` when one was
   * divergent or failed, `failed` when the listing itself could not be
   * emitted, `refused` for invalid arguments.
   */
  readonly status: "complete" | "partial" | "failed" | "refused";
  /** Rows actually printed: the whole sorted set, or `--limit` of it. A
   * per-harness `rows` can exceed this, and normally does. */
  readonly rowsReturned: number;
  /** Whether rows existed beyond `--limit`. There is no continuation token;
   * a consumer that needs the rest re-runs without `--limit`. */
  readonly more: boolean;
  readonly harnesses: readonly HarnessListing[];
  readonly failure: TranscriptFailure | null;
}
