/**
 * Tiny shared shape helpers for the interpretation layer. They exist so the
 * unsafe cast to Record and the shell-word splitter each have exactly one
 * owner - quoting rules live in tokenize, not at call sites.
 */

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/**
 * Split a command line into shell words: whitespace separates, single or
 * double quotes group (so a flag inside quoted prompt text stays part of
 * that one word and can never be mistaken for a real flag - the D-011
 * resume-anchoring rule depends on this).
 */
export const tokenize = (command: string): string[] => {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
};

/** The final path segment of a command word, without importing node:path -
 * argv[0] arrives as `claude`, `/usr/local/bin/claude`, or similar. */
export const basenameOf = (word: string): string => {
  const at = word.lastIndexOf("/");
  return at === -1 ? word : word.slice(at + 1);
};
