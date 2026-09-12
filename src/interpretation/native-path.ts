/** Native CLI folder grammar, bounded in UTF-8 bytes rather than characters. */
export const isNativeFolder = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !/\p{Cc}/u.test(value) &&
  new TextEncoder().encode(value).length <= 4096;
