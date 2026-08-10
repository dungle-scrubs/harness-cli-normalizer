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
  // Per-instance and stateful ({stream:true}): a shared decoder would carry
  // partial-sequence state across two streams and corrupt both.
  private readonly decoder = new TextDecoder();
  private pending = "";
  private scanFrom = 0;
  private discarding = false;

  push(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.ingest(text);
  }

  private ingest(text: string): string[] {
    this.pending += text;
    const lines: string[] = [];
    while (true) {
      const at = this.pending.indexOf("\n", this.scanFrom);
      if (at === -1) break;
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      this.scanFrom = 0;
      if (this.discarding) {
        // The truncated head of an over-long line ends here; drop it whole.
        this.discarding = false;
        continue;
      }
      if (!isBlank(line)) lines.push(line);
    }
    this.scanFrom = this.pending.length;
    if (this.pending.length > LINE_MAX) {
      this.pending = "";
      this.scanFrom = 0;
      this.discarding = true;
    }
    return lines;
  }

  /** The final partial line at stream close, if any. */
  flush(): string | null {
    const tail = this.decoder.decode();
    if (tail !== "") this.pending += tail;
    const rest = this.discarding || isBlank(this.pending) ? null : this.pending;
    this.pending = "";
    this.scanFrom = 0;
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
