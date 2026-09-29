/**
 * Line assembly for process streams: chunks arrive torn at arbitrary BYTE
 * boundaries, so the byte->string step must stream (a multibyte character
 * split across chunks decodes whole, never as replacement bytes), and
 * complete lines are only ever cut at '\n'. The pending partial is scanned
 * incrementally (never re-split from the start) and bounded: a payload
 * must not become parseable - or resident - by luck of where the pipe
 * split it, so an over-long line flips to discard until its newline, and
 * the owner hears of it once, with its size, through `onOverflow`.
 */

export const LINE_MAX = 65_536;

/**
 * The line bound for every output stream of a run or a session. A harness
 * writes one whole message per line, and pi's `message_end` carries the
 * full reasoning trace plus the answer, repeated on `turn_end` and
 * `agent_end`. A maximal reply sets the size: GLM 5.3 emits up to 131,072
 * output tokens; at a generous 16 characters per token and 2x JSON
 * escaping (newlines and quotes) that is 4 MiB on one line. 16 MiB keeps
 * 4x headroom over that and holds at most 32 MB of UTF-16 per stream while
 * a line assembles. A longer line is discarded and reported, never
 * silently dropped: see `LineBuffer`'s `onOverflow`.
 */
export const RUN_LINE_MAX = 16 * 1024 * 1024;

/** One over-long line, reported once when it ends (at its newline or at
 * stream close). `characters` counts the decoded line (UTF-16 code units,
 * the unit `limit` is in); `bytes` is its UTF-8 size, exact for byte
 * chunks (a surrogate pair torn across two string chunks counts 6). */
export interface LineOverflow {
  readonly characters: number;
  readonly bytes: number;
  readonly limit: number;
}

export class LineBuffer {
  constructor(
    private readonly limit = LINE_MAX,
    private readonly onOverflow?: (overflow: LineOverflow) => void,
  ) {}
  // Per-instance and stateful ({stream:true}): a shared decoder would carry
  // partial-sequence state across two streams and corrupt both.
  private readonly decoder = new TextDecoder();
  private pending = "";
  private discarding = false;
  private discardedCharacters = 0;
  private discardedBytes = 0;

  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.ingest(text);
  }

  private ingest(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    while (true) {
      // Search only new bytes. Searching the accumulated rope on each pipe
      // chunk repeatedly flattens large echoed prompts.
      const at = text.indexOf("\n", start);
      this.append(text.slice(start, at === -1 ? text.length : at));
      if (at === -1) return lines;
      if (!this.discarding && !isBlank(this.pending)) lines.push(this.pending);
      this.endLine();
      start = at + 1;
    }
  }

  private append(text: string): void {
    if (this.discarding) {
      this.discardedCharacters += text.length;
      this.discardedBytes += utf8Length(text);
    } else if (this.pending.length + text.length > this.limit) {
      this.discardedCharacters = this.pending.length + text.length;
      this.discardedBytes = utf8Length(this.pending) + utf8Length(text);
      this.pending = "";
      this.discarding = true;
    } else this.pending += text;
  }

  private endLine(): void {
    if (this.discarding) {
      this.onOverflow?.({
        characters: this.discardedCharacters,
        bytes: this.discardedBytes,
        limit: this.limit,
      });
    }
    this.pending = "";
    this.discarding = false;
    this.discardedCharacters = 0;
    this.discardedBytes = 0;
  }

  /** The final partial line at stream close, if any. */
  flush(): string | null {
    const tail = this.decoder.decode();
    if (tail !== "") this.append(tail);
    const rest = this.discarding || isBlank(this.pending) ? null : this.pending;
    this.endLine();
    return rest;
  }
}

/** UTF-8 length of a JS string without allocating its encoding. A lone
 * surrogate counts 3, as TextEncoder writes U+FFFD for it. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // Past the end, charCodeAt is NaN and the range test fails.
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

const isBlank = (line: string): boolean => {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13) return false;
  }
  return true;
};

/** Strict UTF-8 NDJSON framing for a control channel. The limit includes the
 * newline, and an incomplete final frame is never a command. Unlike diagnostic
 * line assembly, invalid bytes and oversized frames terminate this channel. */
export class ControlFrameError extends Error {
  constructor(readonly code: "frame-too-large" | "invalid-utf8") {
    super(code);
    this.name = "ControlFrameError";
  }
}

export class ControlLines {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();
  private pending = "";
  private bytes = 0;

  constructor(private readonly limit: number) {}

  *push(chunk: string | Uint8Array): Iterable<string> {
    const bytes = typeof chunk === "string" ? this.encoder.encode(chunk) : chunk;
    let start = 0;
    while (start < bytes.length) {
      const at = bytes.indexOf(10, start);
      const end = at === -1 ? bytes.length : at + 1;
      this.bytes += end - start;
      if (this.bytes > this.limit) throw new ControlFrameError("frame-too-large");
      try {
        this.pending += this.decoder.decode(bytes.subarray(start, end), { stream: true });
      } catch {
        throw new ControlFrameError("invalid-utf8");
      }
      if (at !== -1) {
        const line = this.pending.slice(0, -1);
        this.pending = "";
        this.bytes = 0;
        yield line;
      }
      start = end;
    }
  }
}
