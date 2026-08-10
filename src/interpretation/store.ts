/**
 * Store-path resolution: where a harness files the transcript for a session,
 * resolved purely from descriptor template data - the tail reader in the
 * execution layer consumes this, it is never guessed at a call site.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface StorePathInputs {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
}

const slugFor = (h: HarnessDescriptor, cwd: string): string =>
  h.store.cwdSlug === "dash-separators" ? cwd.replace(/[/.]/g, "-") : cwd;

export const storePath = (h: HarnessDescriptor, inputs: StorePathInputs): string =>
  h.store.template
    .replace("{home}", inputs.home)
    .replace("{cwdSlug}", slugFor(h, inputs.cwd))
    .replace("{sessionId}", inputs.sessionId);
