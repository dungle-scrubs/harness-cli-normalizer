import { ArgvRefusalError } from "./refusal.js";

export const isValidEnvEntry = (key: string, value: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !value.includes("\0") && !key.includes("\0");

/**
 * Parse --env KEY=VAL entries into env record. "" value means delete.
 */
export const parseEnvEntries = (
  entries: string[] | string | undefined,
): Record<string, string> | undefined => {
  if (entries === undefined) return undefined;
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of list) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new ArgvRefusalError({
        issue: "invalid-env",
        supported: ["KEY=VAL"],
        detail: entry,
      });
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!isValidEnvEntry(key, value)) {
      throw new ArgvRefusalError({
        issue: "invalid-env",
        supported: ["keys must match ^[A-Za-z_][A-Za-z0-9_]*$ and contain no NUL"],
        detail: entry,
      });
    }
    env[key] = value;
  }
  return env;
};
