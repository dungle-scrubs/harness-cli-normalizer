/**
 * Line assembly for process streams: chunks arrive torn at arbitrary BYTE
 * boundaries, so the byte->string step must stream (a multibyte character
 * split across chunks decodes whole, never as replacement bytes), and
 * complete lines are only ever cut at '\n'. The pending partial is scanned
 * incrementally (never re-split from the start) and bounded: a payload
 * must not become parseable - or resident - by luck of where the pipe
 * split it, so an over-long line flips to discard until its newline.
 */

export const LINE_MAX = 65_536;

export class LineBuffer {
  constructor(
    private readonly limit = LINE_MAX,
    private readonly onOverflow?: () => void,
  ) {}
  // Per-instance and stateful ({stream:true}): a shared decoder would carry
  // partial-sequence state across two streams and corrupt both.
  private readonly decoder = new TextDecoder();
  private pending = "";
  private discarding = false;

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
      this.pending = "";
      this.discarding = false;
      start = at + 1;
    }
  }

  private append(text: string): void {
    if (this.discarding) return;
    if (this.pending.length + text.length > this.limit) {
      this.pending = "";
      this.discarding = true;
      this.onOverflow?.();
    } else this.pending += text;
  }

  /** The final partial line at stream close, if any. */
  flush(): string | null {
    const tail = this.decoder.decode();
    if (tail !== "") this.append(tail);
    const rest =
      this.discarding || this.pending.length > this.limit || isBlank(this.pending)
        ? null
        : this.pending;
    this.pending = "";
    this.discarding = false;
    return rest;
  }
}

const isBlank = (line: string): boolean => {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13) return false;
  }
  return true;
};
