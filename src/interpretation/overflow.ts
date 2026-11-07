/**
 * Whether a discarded output line was an ECHO record: one that only
 * repeats content hcn already read from an earlier record, so losing it
 * loses nothing (pi repeats the assistant message on `turn_end` and
 * `agent_end`; hcn reads the message from `message_end`).
 *
 * The rule is deliberately conservative: the head of the discarded line
 * must START with the echo record - the type field first, the value in
 * the descriptor's list. Anything else (a different record, a type field
 * that is not first, a truncated head, a harness with no echo records) is
 * not an echo, and the line is judged on its own.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

/** JSON whitespace: the only space a JSON text may carry between its
 * tokens. */
const JSON_WHITESPACE = " \t\n\r";

/** The characters of a JSON string literal, unescaped for the plain
 * identifiers a record type is made of. */
const readString = (text: string, start: number): { value: string; next: number } | null => {
  if (text[start] !== '"') return null;
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') return { value, next: index + 1 };
    // A backslash means the literal is not a plain identifier; refuse it
    // rather than guess what it decodes to.
    if (char === "\\") return null;
    value += char;
    index++;
  }
  return null;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && JSON_WHITESPACE.includes(text[index] ?? "")) index++;
  return index;
};

/** True when `head` starts with an echo record of this harness: an object
 * whose FIRST key is the descriptor's type field and whose value is one
 * of the harness's echo record types. */
export const overflowIsEcho = (h: HarnessDescriptor, head: string): boolean => {
  const echo = h.output.echoRecords;
  if (echo === null || echo.values.length === 0) return false;
  const start = skipWhitespace(head, 0);
  if (head[start] !== "{") return false;
  const keyStart = skipWhitespace(head, start + 1);
  const key = readString(head, keyStart);
  if (key === null || key.value !== echo.field) return false;
  const colon = skipWhitespace(head, key.next);
  if (head[colon] !== ":") return false;
  const valueStart = skipWhitespace(head, colon + 1);
  const value = readString(head, valueStart);
  if (value === null) return false;
  return echo.values.includes(value.value);
};
