/**
 * ADR 0009 / #241: muse's compaction signal, read from the MSP view.
 *
 * `muse exec --json` emits NOTHING on a successful compaction - a turn that
 * compacted 68,376 tokens to 22,388 produced a stdout stream identical,
 * record for record, to a turn that compacted nothing. The signal lives on
 * the `muse serve` MSP view, which hcn already attaches to for the approval
 * observer (docs/research/2026-09-22-compaction-signals/muse).
 *
 * Compaction is a first-class view item, emitted as a started/completed
 * pair. Only the terminal half carries an outcome, so only the terminal
 * half reports: muse announces `compacted`, `noop`, `failed` and `aborted`,
 * and never a `started`.
 *
 * Pure: this module maps one view item to one event and decides nothing
 * about polling, cursors or process lifecycle. The observer in
 * src/execution/muse-approvals.ts owns those.
 */
import type { CompactionState, CompactionTrigger } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

/** One terminal compaction item, normalized. `itemId` is the view's own
 * identity for the compaction; a caller dedupes on it so one compaction
 * reports once across repeated pages. */
export interface MuseCompaction {
  readonly itemId: string;
  readonly state: CompactionState;
  readonly trigger?: CompactionTrigger;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly detail?: string;
}

/**
 * MSP `CompactionOutcome` onto ADR 0009's state union. Three names agree;
 * the fourth does not - muse says `cancelled` for a stopped compaction and
 * ADR 0009 says `aborted`, so that one is translated rather than passed
 * through. The schema declares this vocabulary `x-msp-openness: open`, so
 * an outcome hcn has no arm for reports nothing rather than guessing.
 */
const STATE_OF: Readonly<Record<string, CompactionState>> = {
  cancelled: "aborted",
  compacted: "compacted",
  failed: "failed",
  noop: "noop",
};

/** MSP `CompactionTrigger` is `manual` | `auto`, both of which ADR 0009
 * already has. Only `auto` was observed live; `manual` needs a
 * `session/compact` call the probe never made. */
const triggerOf = (value: unknown): CompactionTrigger | undefined =>
  value === "auto" || value === "manual" ? value : undefined;

const numberOr = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * One MSP view item to one compaction, or null when the item is not a
 * terminal compaction. Null covers three cases a caller treats alike: a
 * non-compaction item, the `inProgress` half of the pair, and an outcome
 * word this version has no arm for.
 */
export const museCompactionOf = (value: unknown): MuseCompaction | null => {
  const item = asRecord(value);
  if (item === null || item.kind !== "compaction") return null;
  const itemId = item.itemId;
  if (typeof itemId !== "string" || itemId === "") return null;
  // `outcome` is documented "terminal only". The started half carries
  // `status: "inProgress"` and no outcome, and reports nothing: muse
  // announces no start, so a caller counts ends and never doubles.
  const state = typeof item.outcome === "string" ? STATE_OF[item.outcome] : undefined;
  if (state === undefined) return null;
  const trigger = triggerOf(item.trigger);
  const before = numberOr(item.tokensBefore);
  const after = numberOr(item.tokensAfter);
  // `reason` is the harness's own words for a noop or failure, verbatim -
  // e.g. "no_compactable_history". Prose, so a consumer branches on state
  // and never on this (ADR 0002).
  const detail = typeof item.reason === "string" && item.reason !== "" ? item.reason : undefined;
  return {
    itemId,
    state,
    ...(trigger !== undefined ? { trigger } : {}),
    ...(before !== undefined ? { tokensBefore: before } : {}),
    ...(after !== undefined ? { tokensAfter: after } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
};

/**
 * Every terminal compaction on one `view/page` reply, in view order, with
 * the page's next cursor. A reply hcn cannot read returns null, which the
 * caller treats as a skipped sample rather than a verdict - the view fold
 * is additive to the approval observer and never decides a turn.
 */
export interface MuseViewPage {
  readonly compactions: readonly MuseCompaction[];
  readonly nextCursor: string | null;
}

export const museViewPageOf = (result: unknown): MuseViewPage | null => {
  const page = asRecord(result);
  if (page === null) return null;
  // The view names its entries `items`; each carries the item under
  // `item`, the way the started/completed frames do, or inline.
  const entries = Array.isArray(page.items) ? page.items : null;
  if (entries === null) return null;
  const compactions: MuseCompaction[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const found =
      museCompactionOf(record?.item) ?? (record !== null ? museCompactionOf(record) : null);
    if (found !== null) compactions.push(found);
  }
  const cursor = page.nextCursor ?? page.viewCursor;
  return {
    compactions,
    nextCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
  };
};
