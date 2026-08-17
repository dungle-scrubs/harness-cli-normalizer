/**
 * Store-path resolution: where a harness files the transcript for a session,
 * resolved purely from descriptor template data - the tail reader in the
 * execution layer consumes this, it is never guessed at a call site. The
 * session id is shape-checked before it becomes a path segment (a traversal
 * id must never reach the filesystem), and replacements are literal - no
 * `$&` pattern semantics from String.replace.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { assertUsableSessionId } from "./session-id.js";

export interface StorePathInputs {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
}

const slugFor = (h: HarnessDescriptor, cwd: string): string => {
  const normalized = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  switch (h.store.cwdSlug) {
    case "dash-separators":
      return normalized.replace(/[/.]/g, "-");
    case "pi-dash-wrapped":
      // pi 0.84.2, verified on-disk: leading slash stripped, '/' -> '-',
      // dots preserved, wrapped in double dashes:
      // /Users/kevin/dev/x -> --Users-kevin-dev-x--
      return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
    case "verbatim":
      return normalized;
    default: {
      const exhaustive: never = h.store.cwdSlug;
      return exhaustive;
    }
  }
};

export const storePath = (h: HarnessDescriptor, inputs: StorePathInputs): string => {
  assertUsableSessionId(inputs.sessionId);
  return h.store.template
    .replaceAll("{home}", () => inputs.home)
    .replaceAll("{cwdSlug}", () => slugFor(h, inputs.cwd))
    .replaceAll("{sessionId}", () => inputs.sessionId);
};
