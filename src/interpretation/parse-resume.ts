/**
 * Resume-command parsing: recognizes a pasted "resume this session" shell
 * command and recovers {harness, sessionId, autonomy}. The inverse of
 * buildResumeArgv, tolerant of extra flags the user's shell history carried.
 */
import type { HarnessDescriptor, HarnessName } from "../knowledge/descriptor.js";

export interface ParsedResume {
  readonly harness: HarnessName;
  readonly sessionId: string;
  readonly autonomy: boolean;
}

export const parseResumeCommand = (
  known: readonly HarnessDescriptor[],
  command: string,
): ParsedResume | null => {
  const words = command.trim().split(/\s+/);
  const bin = words[0];
  if (bin === undefined) return null;
  const h = known.find((d) => d.bin === bin);
  if (h === undefined) return null;
  const at = words.indexOf(h.resume.flag, 1);
  if (at === -1) return null;
  const sessionId = words[at + 1];
  if (sessionId === undefined || sessionId.startsWith("-")) return null;
  const autonomy = h.autonomy !== null && words.includes(h.autonomy.flag);
  return { harness: h.name, sessionId, autonomy };
};
