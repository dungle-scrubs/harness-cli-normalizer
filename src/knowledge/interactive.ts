import { deepFreeze } from "./descriptor.js";

/** Native terminal operations are separate from headless resume grammars.
 * Codex 0.154.0 `resume --help`: exact UUID, optional --cd, no prompt required.
 * Other lanes remain unavailable until their native launch is corroborated. */
export const INTERACTIVE_INTERFACES = deepFreeze({
  "claude-cli": { harness: "claude", resume: null },
  "codex-cli": { harness: "codex", resume: ["resume", "{sessionId}", "--cd", "{cwd}"] },
  "codex-desktop": { harness: "codex", resume: null },
  "muse-cli": { harness: "muse", resume: null },
  "pi-cli": { harness: "pi", resume: null },
} as const);

export type InteractiveRefusal =
  | "unsupported-interface"
  | "resume-unavailable"
  | "cwd-refused"
  | "invalid-request"
  | "executable-unavailable"
  | "spawn-rejected";

export interface NativeProcessOwner {
  readonly executable: string;
  readonly pid: number;
  readonly startedAt: string;
}

export type InteractiveControlBody =
  | { readonly kind: "ready" }
  | {
      readonly kind: "refused";
      readonly evidence: "spawn-not-attempted";
      readonly reason: InteractiveRefusal;
    }
  | {
      readonly kind: "started";
      readonly cwd: string;
      readonly interface: string;
      readonly sessionId: string;
      readonly owner: NativeProcessOwner;
    }
  | {
      readonly kind: "closed";
      readonly cleanupComplete: boolean;
      readonly exitCode: number | null;
    };

export type InteractiveControlRecord = InteractiveControlBody & {
  readonly launchId: string;
  readonly operation: "interactive";
  readonly v: 1;
};
