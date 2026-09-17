/**
 * Vendored pure MD5 (RFC 1321) for the cursor chats slug. Hand-rolled so
 * the interpretation layer keeps its purity gate: no node: import, no
 * TextEncoder global, no crypto global. UTF-8 encoding is inline for the
 * same reason. Verified against md5sum vectors in store-cursor.test.ts.
 */

const utf8Bytes = (input: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
};

const SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const TABLE: readonly number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 64; i++) t.push(Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  return t;
})();

const rotateLeft = (value: number, bits: number): number =>
  (value << bits) | (value >>> (32 - bits));

/** MD5 hex digest of the UTF-8 bytes of the input. */
export const md5Hex = (input: string): string => {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLength / 2 ** (8 * i)) & 0xff);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let block = 0; block < bytes.length; block += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) {
      words.push(
        (bytes[block + i * 4] as number) |
          ((bytes[block + i * 4 + 1] as number) << 8) |
          ((bytes[block + i * 4 + 2] as number) << 16) |
          ((bytes[block + i * 4 + 3] as number) << 24),
      );
    }
    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) % 16;
      }
      f = (f + aa + (TABLE[i] as number) + (words[g] as number)) | 0;
      aa = dd;
      dd = cc;
      cc = bb;
      bb = (bb + rotateLeft(f, SHIFTS[i] as number)) | 0;
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }

  const wordHex = (w: number): string =>
    [0, 8, 16, 24].map((s) => ((w >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
  return wordHex(a) + wordHex(b) + wordHex(c) + wordHex(d);
};
