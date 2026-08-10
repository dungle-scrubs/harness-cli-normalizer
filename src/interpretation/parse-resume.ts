/**
 * Resume-command parsing: recognizes a pasted "resume this session" shell
 * command and recovers {harness, sessionId, autonomy}. The inverse of
 * buildResumeArgv, tolerant of what shell history actually carries (quoted
 * ids, resolved bin paths, --flag=value, flag aliases). Anchoring rules
 * ported from v1 (D-011): the id must sit where the resume grammar puts it,
 * match the harness's id shape, and be the ONLY id-shaped token - a UUID
 * inside quoted prompt text must never be returned as the session id.
 */
import type { HarnessDescriptor, HarnessName } from "../knowledge/descriptor.js";
import { isUsableSessionId } from "./session-id.js";
import { basenameOf, tokenize } from "./shape.js";

export interface ParsedResume {
  readonly harness: HarnessName;
  readonly sessionId: string;
  readonly autonomy: boolean;
}

const resumeTokens = (h: HarnessDescriptor): readonly string[] => [
  h.resume.flag,
  ...h.resume.aliases,
];

/** The id token per the descriptor's resume grammar, or null. */
const idTokenOf = (h: HarnessDescriptor, words: readonly string[]): string | null => {
  if (h.resume.style === "positional") {
    // `<bin> resume <id>`: the resume word must be argv position 1 exactly.
    if (words[1] !== h.resume.flag) return null;
    return words[2] ?? null;
  }
  for (const token of resumeTokens(h)) {
    const at = words.indexOf(token, 1);
    if (at !== -1) return words[at + 1] ?? null;
    const eqForm = words.find((w) => w.startsWith(`${token}=`));
    if (eqForm !== undefined) return eqForm.slice(token.length + 1);
  }
  return null;
};

export const parseResumeCommand = (
  known: readonly HarnessDescriptor[],
  command: string,
): ParsedResume | null => {
  const words = tokenize(command);
  const bin = words[0];
  if (bin === undefined) return null;
  const h = known.find((d) => basenameOf(bin) === d.bin);
  if (h === undefined) return null;

  const id = idTokenOf(h, words);
  if (id === null || !h.resume.idShape.test(id) || !isUsableSessionId(id)) return null;

  // D-011: any OTHER id-shaped token means the command is ambiguous -
  // refuse rather than resume a stranger.
  const idShaped = words.filter((w) => w !== id && h.resume.idShape.test(w));
  if (idShaped.length > 0) return null;

  const autonomy = h.autonomy !== null && words.includes(h.autonomy.flag);
  return { harness: h.name, sessionId: id, autonomy };
};
