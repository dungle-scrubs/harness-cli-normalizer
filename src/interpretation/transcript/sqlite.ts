import { TranscriptError } from "./json.js";

/** One column value of a SQLite record, as stored. */
export type SqliteValue = null | bigint | number | string | Uint8Array;

const HEADER = "SQLite format 3\0";

function malformed(message: string): TranscriptError {
  return new TranscriptError("source-malformed", `Invalid native SQLite store: ${message}`);
}

/**
 * Read-only access to the rowid tables of one SQLite database image, per the
 * documented file format (https://www.sqlite.org/fileformat2.html). Pure and
 * synchronous: it walks table b-trees and overflow chains in a byte view and
 * never consults a write-ahead log, so the caller must supply a checkpointed
 * image.
 *
 * Hand-written on purpose: Bun (probed 1.3.14) has no `node:sqlite`, and this
 * layer's purity gate forbids `node:` imports. A runtime binding would also
 * fork the snapshot framing path by runtime. Cross-checked against
 * `node:sqlite`; see docs/transcript-evidence.md.
 */
export class SqliteImage {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly pageSize: number;
  private readonly usable: number;
  private readonly pageCount: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 100 || String.fromCharCode(...bytes.subarray(0, 16)) !== HEADER)
      throw new TranscriptError("guarantee-unmet", "The source is not a SQLite database.");
    const size = this.view.getUint16(16);
    this.pageSize = size === 1 ? 65536 : size;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0)
      throw malformed("page size.");
    const reserved = bytes[20] ?? 0;
    this.usable = this.pageSize - reserved;
    if (this.usable < 480) throw malformed("usable page size.");
    if (this.view.getUint32(56) !== 1)
      throw new TranscriptError("guarantee-unmet", "Only UTF-8 SQLite stores are established.");
    if (![1, 2].includes(bytes[18] ?? 0) || ![1, 2].includes(bytes[19] ?? 0))
      throw new TranscriptError("guarantee-unmet", "Unestablished SQLite file format version.");
    if (bytes.length % this.pageSize !== 0) throw malformed("truncated page.");
    const physical = bytes.length / this.pageSize;
    // The in-header size is authoritative when its change counter is current.
    const declared = this.view.getUint32(28);
    const current = declared > 0 && this.view.getUint32(24) === this.view.getUint32(92);
    if (current && declared > physical) throw malformed("declared page count.");
    this.pageCount = current ? declared : physical;
  }

  /** The schema rows of every table: name, root page and creating SQL. */
  tables(): { readonly name: string; readonly rootPage: number; readonly sql: string }[] {
    return this.rows(1).flatMap((row) => {
      const [type, name, , rootPage, sql] = row;
      if (type !== "table") return [];
      if (typeof name !== "string" || typeof sql !== "string" || typeof rootPage !== "bigint")
        throw malformed("schema row.");
      return [{ name, rootPage: Number(rootPage), sql }];
    });
  }

  /** Every record of a rowid table in rowid order. */
  rows(rootPage: number): SqliteValue[][] {
    const rows: SqliteValue[][] = [];
    const visited = new Set<number>();
    // Pages still to visit, last first; iterative so depth cannot exhaust the call stack.
    const pending = [rootPage];
    while (pending.length) {
      const page = pending.pop() ?? 0;
      if (!Number.isInteger(page) || page < 1 || page > this.pageCount || visited.has(page))
        throw malformed("b-tree page reference.");
      visited.add(page);
      const start = (page - 1) * this.pageSize;
      const end = start + this.usable;
      const header = page === 1 ? start + 100 : start;
      const type = this.bytes[header];
      const cells = this.view.getUint16(header + 3);
      const interior = type === 0x05;
      if (!interior && type !== 0x0d) throw malformed("table b-tree page type.");
      if (interior && cells === 0) throw malformed("empty interior page.");
      const pointers = header + (interior ? 12 : 8);
      if (pointers + cells * 2 > end) throw malformed("cell count.");
      const children: number[] = [];
      for (let index = 0; index < cells; index++) {
        const cell = start + this.view.getUint16(pointers + index * 2);
        if (cell < pointers || cell + (interior ? 4 : 2) > end) throw malformed("cell pointer.");
        if (interior) children.push(this.view.getUint32(cell));
        else rows.push(recordValues(this.payload(cell, end), this.decoder));
      }
      if (interior) {
        children.push(this.view.getUint32(header + 8));
        pending.push(...children.reverse());
      }
    }
    return rows;
  }

  private varint(offset: number): [bigint, number] {
    let value = 0n;
    for (let index = 0; index < 9; index++) {
      const byte = this.bytes[offset + index];
      if (byte === undefined) throw malformed("varint.");
      if (index === 8) return [(value << 8n) | BigInt(byte), offset + 9];
      value = (value << 7n) | BigInt(byte & 0x7f);
      if (byte < 0x80) return [value, offset + index + 1];
    }
    throw malformed("varint.");
  }

  /** A table leaf cell's payload, following its overflow chain. */
  private payload(cell: number, end: number): Uint8Array {
    const [size, afterSize] = this.varint(cell);
    const [, afterRowid] = this.varint(afterSize);
    if (size > BigInt(this.bytes.length)) throw malformed("payload size.");
    const total = Number(size);
    const u = this.usable;
    const maxLocal = u - 35;
    const minLocal = Math.floor(((u - 12) * 32) / 255) - 23;
    let local = total;
    if (total > maxLocal) {
      const spill = minLocal + ((total - minLocal) % (u - 4));
      local = spill <= maxLocal ? spill : minLocal;
    }
    const spills = local < total;
    if (afterRowid + local + (spills ? 4 : 0) > end) throw malformed("cell payload bounds.");
    const out = new Uint8Array(total);
    out.set(this.bytes.subarray(afterRowid, afterRowid + local));
    let written = local;
    let next = spills ? this.view.getUint32(afterRowid + local) : 0;
    const visited = new Set<number>();
    while (written < total) {
      if (next < 1 || next > this.pageCount || visited.has(next))
        throw malformed("overflow page reference.");
      visited.add(next);
      const start = (next - 1) * this.pageSize;
      const length = Math.min(u - 4, total - written);
      out.set(this.bytes.subarray(start + 4, start + 4 + length), written);
      written += length;
      next = this.view.getUint32(start);
    }
    if (next !== 0) throw malformed("overflow chain terminator.");
    return out;
  }
}

/** Byte widths of the fixed-size serial types 0-9. */
const WIDTHS = [0, 1, 2, 3, 4, 6, 8, 8, 0, 0] as const;

function recordValues(bytes: Uint8Array, decoder: TextDecoder): SqliteValue[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const varint = (offset: number): [number, number] => {
    let value = 0;
    for (let index = 0; index < 9; index++) {
      const byte = bytes[offset + index];
      if (byte === undefined) throw malformed("record varint.");
      if (index === 8) return [value * 256 + byte, offset + 9];
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return [value, offset + index + 1];
    }
    throw malformed("record varint.");
  };
  const [headerSize, first] = varint(0);
  if (headerSize < first || headerSize > bytes.length) throw malformed("record header.");
  const types: number[] = [];
  for (let offset = first; offset < headerSize; ) {
    const [type, next] = varint(offset);
    if (next > headerSize) throw malformed("record header.");
    types.push(type);
    offset = next;
  }
  let body = headerSize;
  const values = types.map((type): SqliteValue => {
    if (type === 10 || type === 11) throw malformed("reserved serial type.");
    const length = type >= 12 ? Math.floor((type - 12) / 2) : (WIDTHS[type] ?? 0);
    if (body + length > bytes.length) throw malformed("record body.");
    const at = body;
    body += length;
    if (type === 0) return null;
    if (type === 8) return 0n;
    if (type === 9) return 1n;
    if (type === 7) return view.getFloat64(at);
    if (type <= 6) {
      let value = BigInt.asIntN(8, BigInt(bytes[at] ?? 0));
      for (let index = 1; index < length; index++)
        value = (value << 8n) | BigInt(bytes[at + index] ?? 0);
      return value;
    }
    const slice = bytes.subarray(at, at + length);
    if (type % 2 === 0) return slice;
    try {
      return decoder.decode(slice);
    } catch {
      throw malformed("text encoding.");
    }
  });
  if (body !== bytes.length) throw malformed("record body length.");
  return values;
}
