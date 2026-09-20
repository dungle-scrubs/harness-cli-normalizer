/**
 * Hand-built SQLite images for the malformed cases a real engine will not
 * write. Pages are addressed one-based, as the file format numbers them.
 */

export const PAGE = 512;

export interface ImagePlan {
  readonly pages: number;
  /** Cell payloads of the page-1 table leaf, or interior children to point at. */
  write(page: (number: number) => DataView, bytes: Uint8Array): void;
}

export function buildImage(plan: ImagePlan): Uint8Array {
  const bytes = new Uint8Array(plan.pages * PAGE);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  view.setUint16(16, PAGE);
  bytes[18] = 1;
  bytes[19] = 1;
  bytes[20] = 0;
  bytes[21] = 64;
  bytes[22] = 32;
  bytes[23] = 32;
  view.setUint32(24, 1);
  view.setUint32(28, plan.pages);
  view.setUint32(56, 1);
  view.setUint32(92, 1);
  const page = (number: number): DataView => new DataView(bytes.buffer, (number - 1) * PAGE, PAGE);
  plan.write(page, bytes);
  return bytes;
}

/** Writes a table-leaf b-tree header on one page and returns its cell-pointer offset. */
export function leafHeader(
  page: DataView,
  cells: number,
  contentStart: number,
  onPage1 = false,
): number {
  const at = onPage1 ? 100 : 0;
  page.setUint8(at, 0x0d);
  page.setUint16(at + 1, 0);
  page.setUint16(at + 3, cells);
  page.setUint16(at + 5, contentStart);
  page.setUint8(at + 7, 0);
  return at + 8;
}

/** Writes a table-interior b-tree header and returns its cell-pointer offset. */
export function interiorHeader(
  page: DataView,
  cells: number,
  contentStart: number,
  rightMost: number,
  onPage1 = false,
): number {
  const at = onPage1 ? 100 : 0;
  page.setUint8(at, 0x05);
  page.setUint16(at + 1, 0);
  page.setUint16(at + 3, cells);
  page.setUint16(at + 5, contentStart);
  page.setUint8(at + 7, 0);
  page.setUint32(at + 8, rightMost);
  return at + 12;
}

/** Big-endian SQLite varint bytes for a non-negative value. */
export function varint(value: number): number[] {
  if (value === 0) return [0];
  const groups: number[] = [];
  let rest = value;
  while (rest > 0) {
    groups.unshift(rest % 128);
    rest = Math.floor(rest / 128);
  }
  return groups.map((group, index) => (index === groups.length - 1 ? group : group | 0x80));
}
