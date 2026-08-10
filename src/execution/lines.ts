/**
 * Line assembly for process streams: chunks arrive torn at arbitrary byte
 * boundaries, so complete lines are only ever cut at '\n'. The trailing
 * partial survives in the buffer until its newline (or flush at close).
 */

const decoder = new TextDecoder();

export class LineBuffer {
  private pending = "";

  push(chunk: string | Uint8Array): string[] {
    this.pending += typeof chunk === "string" ? chunk : decoder.decode(chunk);
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    return parts.filter((line) => line.trim() !== "");
  }

  /** The final partial line at stream close, if any. */
  flush(): string | null {
    const rest = this.pending.trim();
    this.pending = "";
    return rest === "" ? null : rest;
  }
}
