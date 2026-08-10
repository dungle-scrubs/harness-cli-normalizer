/**
 * Context-hook decoding: recognizes the harness's context-window usage
 * payload and surfaces it as a `context` HarnessEvent, the droppable
 * gauge-class event the chat layer may coalesce under pressure. For claude
 * the payload arrives on the STATUSLINE channel, never on stream-json
 * stdout - route this at the channel level, do not call it per stdout line.
 * Values are sanitized (v1 sanitizeContext): non-finite is rejected,
 * out-of-range is clamped, so callers report nothing rather than a broken
 * gauge.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

export interface ContextEvent {
  readonly kind: "context";
  readonly usedPct: number;
}

export const contextEventFrom = (h: HarnessDescriptor, raw: unknown): ContextEvent | null => {
  if (h.contextHook === null) return null;
  const record = asRecord(raw);
  if (record === null) return null;
  const outer = asRecord(record[h.contextHook.object]);
  if (outer === null) return null;
  const usedPct = outer[h.contextHook.usedPctField];
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return null;
  return { kind: "context", usedPct: Math.min(100, Math.max(0, usedPct)) };
};
