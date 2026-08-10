/**
 * Presence: does an INTERACTIVE process for this session id exist in the
 * given process listing? Pure over injected rows - the host polls `ps` and
 * feeds rows in. Presence says a process exists; it never creates a tap,
 * never proves a channel, and never decides attachment (that is the chat
 * layer's liveness state machine).
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface ProcessRow {
  readonly argv: string;
}

export const isInteractive = (
  h: HarnessDescriptor,
  sessionId: string,
  rows: readonly ProcessRow[],
): boolean =>
  rows.some((row) => {
    const words = row.argv.split(/\s+/);
    if (words[0] !== h.bin) return false;
    if (!words.includes(sessionId)) return false;
    return !h.presence.headlessMarkers.some((marker) => words.includes(marker));
  });
