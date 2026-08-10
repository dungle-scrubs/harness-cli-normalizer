/**
 * Resume-command parsing: recognizes a pasted "resume this session" shell
 * command and recovers {harness, sessionId, autonomy} - or a resume-last
 * request where the harness supports one. The inverse of buildResumeArgv,
 * tolerant of what shell history actually carries (quoted ids, resolved
 * bin paths, --flag=value, flag aliases, root options on either side of a
 * subcommand). Anchoring rules ported from v1 (D-011): the id must follow
 * the harness's own resume grammar, match its id shape, and be the ONLY
 * id-shaped token - a UUID inside quoted prompt text must never be
 * returned as the session id. Position independence is safe because
 * tokenize collapses quoted text into single words: a bare resume word can
 * only come from a real argv slot.
 */
import type { HarnessDescriptor, HarnessName } from "../knowledge/descriptor.js";
import { isUsableSessionId } from "./session-id.js";
import { basenameOf, tokenize } from "./shape.js";

export interface ParsedResume {
  readonly harness: HarnessName;
  readonly sessionId: string;
  readonly autonomy: boolean;
}

/** A recorded `--last` resume: no id to anchor - corroboration ranking
 * (rankResumeLast) decides what it names. */
export interface ParsedResumeLast {
  readonly harness: HarnessName;
  readonly resumeLast: true;
  readonly autonomy: boolean;
}

const flagTokens = (h: HarnessDescriptor): readonly string[] => [
  h.resume.flag,
  ...h.resume.aliases,
];

/** The id token per the descriptor's resume grammar, or null. */
const idTokenOf = (h: HarnessDescriptor, words: readonly string[]): string | null => {
  const positionalWords: string[] = [];
  if (h.resume.style === "positional") positionalWords.push(h.resume.flag);
  if (h.resume.positionalParseWord !== undefined) {
    positionalWords.push(h.resume.positionalParseWord);
  }
  for (const word of positionalWords) {
    // Any bare occurrence of the resume word whose successor is id-shaped:
    // root options may sit on either side of a subcommand, so position is
    // not the anchor - the bare word plus the id shape is.
    const at = words.indexOf(word, 1);
    if (at !== -1) {
      const candidate = words[at + 1];
      if (candidate !== undefined && h.resume.idShape.test(candidate)) return candidate;
    }
  }
  if (h.resume.style === "flag" || h.resume.positionalParseWord === undefined) {
    for (const token of flagTokens(h)) {
      if (h.resume.style === "positional") break;
      const at = words.indexOf(token, 1);
      if (at !== -1) return words[at + 1] ?? null;
      const eqForm = words.find((w) => w.startsWith(`${token}=`));
      if (eqForm !== undefined) return eqForm.slice(token.length + 1);
    }
  }
  return null;
};

/** True when the command asks for the harness's resume-most-recent form. */
const isResumeLast = (h: HarnessDescriptor, words: readonly string[]): boolean => {
  if (h.resumeLast === null) return false;
  if (!words.includes(h.resumeLast.flag)) return false;
  // --last only means "resume last" in the resume grammar's context: after
  // the positional resume word, or anywhere for flag-style harnesses.
  const anchor =
    h.resume.style === "positional" ? h.resume.flag : (h.resume.positionalParseWord ?? null);
  if (anchor !== null) {
    const at = words.indexOf(anchor, 1);
    return at !== -1 && words.indexOf(h.resumeLast.flag) > at;
  }
  return true;
};

export const parseResumeCommand = (
  known: readonly HarnessDescriptor[],
  command: string,
): ParsedResume | ParsedResumeLast | null => {
  const words = tokenize(command);
  const bin = words[0];
  if (bin === undefined) return null;
  const h = known.find((d) => basenameOf(bin) === d.bin);
  if (h === undefined) return null;

  const autonomy = h.autonomy !== null && words.includes(h.autonomy.flag);

  const id = idTokenOf(h, words);
  if (id === null) {
    return isResumeLast(h, words) ? { harness: h.name, resumeLast: true, autonomy } : null;
  }
  if (!h.resume.idShape.test(id) || !isUsableSessionId(id)) return null;

  // D-011: any OTHER id-shaped token means the command is ambiguous -
  // refuse rather than resume a stranger.
  const idShaped = words.filter((w) => w !== id && h.resume.idShape.test(w));
  if (idShaped.length > 0) return null;

  return { harness: h.name, sessionId: id, autonomy };
};
