/**
 * Malformed-image cases for the pure SQLite page reader. Each one is a shape a
 * real engine does not write, so the images are built byte by byte here.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SqliteImage } from "../../src/interpretation/transcript/sqlite.js";
import { writeDatabase } from "./cursor-store.js";
import { buildImage, interiorHeader, leafHeader, PAGE, varint } from "./sqlite-image.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "hcn-sqlite-"));
  directories.push(path);
  return path;
}

/** One page-1 table leaf holding a single cell with the given bytes. */
function leafWithCell(cell: readonly number[], pages = 1): Uint8Array {
  return buildImage({
    pages,
    write(page, bytes) {
      const first = page(1);
      const start = PAGE - cell.length;
      const pointers = leafHeader(first, 1, start, true);
      first.setUint16(pointers, start);
      bytes.set(Uint8Array.from(cell), start);
    },
  });
}

test("a payload size larger than the image is refused before allocation", () => {
  // 2^40 bytes declared by a 512-byte image.
  const cell = [...varint(2 ** 40), ...varint(1), 0x00];
  expect(() => new SqliteImage(leafWithCell(cell)).rows(1)).toThrow("payload size");
});

test("an interior cell whose child pointer crosses the page end is refused", () => {
  const image = buildImage({
    pages: 2,
    write(page) {
      const first = page(1);
      const pointers = interiorHeader(first, 1, PAGE - 4, 2, true);
      // The cell starts two bytes before the usable end, so its four-byte
      // child pointer would continue into the next page.
      first.setUint16(pointers, PAGE - 2);
      const second = page(2);
      leafHeader(second, 0, PAGE);
    },
  });
  expect(() => new SqliteImage(image).rows(1)).toThrow("cell pointer");
});

test("a leaf whose overflow pointer sits past the usable end is refused", () => {
  const usable = PAGE;
  const maxLocal = usable - 35;
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  // Choose a total whose local part ends exactly at the page end, leaving no
  // room for the four-byte overflow pointer.
  const total = maxLocal + 1;
  const spill = minLocal + ((total - minLocal) % (usable - 4));
  const local = spill <= maxLocal ? spill : minLocal;
  const header = [...varint(total), ...varint(1)];
  const image = buildImage({
    pages: 2,
    write(page, bytes) {
      const first = page(1);
      const start = PAGE - local - header.length;
      const pointers = leafHeader(first, 1, start, true);
      first.setUint16(pointers, start);
      bytes.set(Uint8Array.from(header), start);
    },
  });
  expect(() => new SqliteImage(image).rows(1)).toThrow("cell payload bounds");
});

test("an overflow chain whose final pointer is not zero is refused", () => {
  const usable = PAGE;
  const total = usable - 35 + 100;
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  const spill = minLocal + ((total - minLocal) % (usable - 4));
  const local = spill <= usable - 35 ? spill : minLocal;
  const header = [...varint(total), ...varint(1)];
  const image = buildImage({
    pages: 2,
    write(page, bytes) {
      const first = page(1);
      const start = PAGE - local - header.length - 4;
      const pointers = leafHeader(first, 1, start, true);
      first.setUint16(pointers, start);
      bytes.set(Uint8Array.from(header), start);
      // Overflow continues on page 2, whose own next pointer loops to itself.
      new DataView(bytes.buffer).setUint32(start + header.length + local, 2);
      page(2).setUint32(0, 2);
    },
  });
  expect(() => new SqliteImage(image).rows(1)).toThrow("overflow chain terminator");
});

test("a record whose serial type crosses its header is refused", () => {
  // Header size 2, but the serial-type varint continues past that boundary.
  const payload = [0x02, 0x80, 0x01, 0x2a];
  const cell = [...varint(payload.length), ...varint(1), ...payload];
  expect(() => new SqliteImage(leafWithCell(cell)).rows(1)).toThrow("record header");
});

test("a record with surplus body bytes is refused", () => {
  // One NULL column declared, two body bytes supplied.
  const payload = [0x02, 0x00, 0x41, 0x42];
  const cell = [...varint(payload.length), ...varint(1), ...payload];
  expect(() => new SqliteImage(leafWithCell(cell)).rows(1)).toThrow("record body length");
});

test("a deep chain of interior pages fails without exhausting the call stack", () => {
  const pages = 12000;
  const image = buildImage({
    pages,
    write(page) {
      for (let number = 1; number < pages; number++)
        interiorHeader(page(number), 0, PAGE, number + 1, number === 1);
      leafHeader(page(pages), 0, PAGE);
    },
  });
  expect(() => new SqliteImage(image).rows(1)).toThrow("empty interior page");
});

test("a stored TEXT value keeps a leading byte order mark", async () => {
  const path = join(directory(), "bom.db");
  await writeDatabase(path, [
    "CREATE TABLE t (value TEXT)",
    "INSERT INTO t (value) VALUES (char(65279) || 'hello')",
  ]);
  const image = new SqliteImage(readFileSync(path));
  const root = image.tables().find((table) => table.name === "t")?.rootPage ?? 0;
  expect(image.rows(root)[0]?.[0]).toBe("﻿hello");
});
