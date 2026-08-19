/**
 * HarnessEvent: the runner's output vocabulary (PLAN.md Part 0). The
 * normalizer owns these events and the parsing that produces them; it does
 * NOT own the chat protocol - lucid maps events into frames downstream.
 * Only `done` is terminal. A turn may emit MULTIPLE `error` events before
 * it (a decoded mid-stream error, then a crash-exit stderr tail, etc.), so
 * a consumer treats `error` as informational and waits for `done`.
 *
 * Event classes are load-bearing for backpressure: token/progress/context
 * are droppable (coalescible, latest-wins); the rest are lossless. The
 * split is DECLARED here because the normalizer emits the events; the
 * coalescing policy that consumes it lives in the chat layer (lucid-v2).
 * Under token granularity a turn's text arrives twice by design: as token
 * deltas AND as the whole trailing message event - render one, never
 * concatenate both.
 */
import type { CapabilityResult } from "../interpretation/capabilities.js";
import type { FailureSummary } from "./failure.js";

export type ExitCause =
  | "clean"
  | "limit"
  | "crash"
  | "stall"
  | "killed"
  | "failed"
  /** issue #41: the turn ended by asking (escalateQuestions) - a
   * SUCCESSFUL turn (process exit 0); the caller resumes with the answer. */
  | "awaiting-input";

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
  | {
      /** issue #41: the worker asked the caller's user a question (the
       * final message carried an hcn-question block). Structured-first:
       * these fields ARE the question; prose renders from them. */
      readonly kind: "question";
      readonly question: string;
      readonly options: readonly string[];
      readonly recommended?: string;
    }
  | { readonly kind: "limit"; readonly code: string; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | ({ readonly kind: "failure" } & FailureSummary)
  | {
      readonly kind: "done";
      readonly exitCode: number | null;
      readonly cause: ExitCause;
      readonly failure?: FailureSummary;
    };

export const DROPPABLE_KINDS = new Set(["token", "progress", "context"]);
