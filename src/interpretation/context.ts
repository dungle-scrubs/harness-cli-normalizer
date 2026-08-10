/**
 * Context-hook decoding: recognizes the harness's context-window usage
 * payload and surfaces it as a `context` HarnessEvent, the droppable
 * gauge-class event the chat layer may coalesce under pressure.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

export interface ContextEvent {
  readonly kind: "context";
  readonly usedPct: number;
}

export const contextEventFrom = (h: HarnessDescriptor, raw: unknown): ContextEvent | null => {
  if (h.contextHook === null) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const outer = (raw as Record<string, unknown>)[h.contextHook.object];
  if (typeof outer !== "object" || outer === null) return null;
  const usedPct = (outer as Record<string, unknown>)[h.contextHook.usedPctField];
  if (typeof usedPct !== "number") return null;
  return { kind: "context", usedPct };
};
