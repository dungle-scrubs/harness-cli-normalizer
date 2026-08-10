/**
 * Presence: does an INTERACTIVE process for this session id exist in the
 * given process listing? Pure over injected rows - the host polls `ps` and
 * feeds rows in. Presence says a process exists; it never creates a tap,
 * never proves a channel, and never decides attachment (that is the chat
 * layer's liveness state machine). Known blind spot, inherent to argv
 * matching and shared with v1: an interactive session whose argv carries no
 * id (`claude --continue`) is invisible here - false-negative is the safe
 * direction, because presence only ever corroborates.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { basenameOf, tokenize } from "./shape.js";

export interface ProcessRow {
  readonly argv: string;
}

const idBearingFlags = (h: HarnessDescriptor): readonly string[] => [
  h.resume.flag,
  ...h.resume.aliases,
  ...(h.sessionMode === null ? [] : [h.sessionMode.idFlag]),
];

export const isInteractive = (
  h: HarnessDescriptor,
  sessionId: string,
  rows: readonly ProcessRow[],
): boolean => {
  const flags = idBearingFlags(h);
  return rows.some((row) => {
    // Cheap rejection before tokenizing: most ps rows are unrelated.
    if (!row.argv.includes(sessionId)) return false;
    const words = tokenize(row.argv);
    const bin = words[0];
    // ps reports the resolved path (/usr/local/bin/claude), not the bare bin.
    if (bin === undefined || basenameOf(bin) !== h.bin) return false;
    // The id must be the VALUE of an id-bearing flag - an id-shaped word in
    // prompt text is not presence.
    const bound = flags.some((flag) => {
      const at = words.indexOf(flag);
      return at !== -1 && words[at + 1] === sessionId;
    });
    if (!bound) return false;
    return !h.presence.headlessMarkers.some((marker) => words.includes(marker));
  });
};
