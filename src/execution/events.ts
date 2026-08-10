/**
 * HarnessEvent: the runner's output vocabulary (PLAN.md Part 0). The
 * normalizer owns these events and the parsing that produces them; it does
 * NOT own the chat protocol - lucid maps events into frames downstream.
 * Event classes are load-bearing for backpressure: token/progress/context
 * are droppable (coalescible, latest-wins); the rest are lossless.
 */
import type { CapabilityResult } from "../interpretation/capabilities.js";

export type ExitCause = "clean" | "limit" | "crash" | "stall" | "killed";

export type HarnessEvent =
  | {
      readonly kind: "identity";
      readonly sessionId: string;
      readonly authority: "caller-assigned" | "harness-minted";
      readonly capabilities: CapabilityResult;
    }
  | { readonly kind: "token"; readonly text: string }
  | { readonly kind: "message"; readonly role: string; readonly text: string }
  | { readonly kind: "progress"; readonly label: string }
  | { readonly kind: "tool"; readonly name: string; readonly input?: unknown }
  | { readonly kind: "context"; readonly usedPct: number }
  | { readonly kind: "limit"; readonly code: string; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "done"; readonly exitCode: number | null; readonly cause: ExitCause };

export const DROPPABLE_KINDS = new Set(["token", "progress", "context"]);
