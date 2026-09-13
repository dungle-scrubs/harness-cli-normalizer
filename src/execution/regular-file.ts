import { type BigIntStats, closeSync, constants, fstatSync, openSync } from "node:fs";

/** Refuses links and special files without waiting. The caller owns a returned fd. */
export function openRegularFile(
  path: string,
): { readonly fd: number; readonly stat: BigIntStats } | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.isFile()) return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  closeSync(fd);
  return undefined;
}
