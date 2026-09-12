import { opendirSync } from "node:fs";
import { join } from "node:path";
import { storePath } from "../interpretation/store.js";
import { codexCli } from "../knowledge/codex.js";

export function codexRecordsRoot(runtime: {
  readonly codexHome: string | undefined;
  readonly cwd: string;
  readonly home: string;
  readonly sessionId: string;
}): string {
  return runtime.codexHome ? join(runtime.codexHome, "sessions") : storePath(codexCli, runtime);
}

/** Bounded exact-ID lookup shared by passive reads and native terminal preflight. */
export function codexRecordPath(root: string, sessionId: string): string | undefined {
  const matches: string[] = [];
  let remaining = 16_384;
  const visit = (directory: string, depth: number): void => {
    const entries = opendirSync(directory);
    try {
      for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
        if (--remaining < 0) throw new Error("Session scan bound exceeded");
        const path = join(directory, entry.name);
        if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name))
          visit(path, depth + 1);
        if (
          depth === 3 &&
          entry.name.startsWith("rollout-") &&
          entry.name.endsWith(`-${sessionId}.jsonl`)
        ) {
          matches.push(path);
          if (matches.length === 2) throw new Error("Ambiguous native session");
        }
      }
    } finally {
      entries.closeSync();
    }
  };
  visit(root, 0);
  return matches.length === 1 ? matches[0] : undefined;
}
