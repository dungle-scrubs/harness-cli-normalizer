/**
 * Content decoding: extract assistant text, token deltas, tool calls, and
 * progress from ONE parsed harness record. Each harness has an entirely
 * different event vocabulary, so this dispatches by harness name to a pure
 * per-harness reader. Identity and wall detection stay descriptor-driven
 * elsewhere; this owns the message/token/tool/progress classes only.
 *
 * (Kept as functions rather than descriptor data because the shapes are
 * structurally too varied - array-of-blocks text, nested delta events,
 * payload-discriminated records - for the flat match/field spec that
 * identity decoding uses.)
 */
import type { HarnessName } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

export type ContentEvent =
  | { readonly kind: "token"; readonly text: string }
  | { readonly kind: "message"; readonly role: string; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly input?: unknown }
  | { readonly kind: "progress"; readonly label: string }
  | { readonly kind: "error"; readonly message: string };

// NOTE: tool-call decoding is claude-only. codex, pi (tool_execution_start
// with toolName/args), and muse emit tool records too, but their exact
// shapes are not yet captured as fixtures, so decoding them here would be
// unverified guesswork. A normal coding turn on those harnesses currently
// loses tool activity - a known gap to close with real tool-call fixtures.

/** Text of an array of `{type:"text", text}` content blocks. */
const textOfBlocks = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b) => asRecord(b))
        .filter((b): b is Record<string, unknown> => b !== null && b.type === "text")
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("")
    : "";

const at = (record: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = record;
  for (const seg of path.split(".")) {
    const inner = asRecord(cursor);
    if (inner === null) return undefined;
    cursor = inner[seg];
  }
  return cursor;
};

const claude = (r: Record<string, unknown>): ContentEvent[] => {
  const events: ContentEvent[] = [];
  if (r.type === "assistant") {
    const content = at(r, "message.content");
    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);
        if (block?.type === "tool_use" && typeof block.name === "string") {
          events.push({ kind: "tool", name: block.name, input: block.input });
        }
      }
    }
    const text = textOfBlocks(content);
    if (text !== "") events.push({ kind: "message", role: "assistant", text });
  } else if (r.type === "stream_event") {
    const delta = at(r, "event.delta");
    const d = asRecord(delta);
    if (d?.type === "text_delta" && typeof d.text === "string") {
      events.push({ kind: "token", text: d.text });
    }
  } else if (r.type === "system" && r.subtype !== "init" && typeof r.subtype === "string") {
    // Non-init system lines (hook_started etc.) surface as droppable
    // progress, as the pre-refactor decoder did. The init line is the
    // identity announcement, handled upstream.
    events.push({ kind: "progress", label: r.subtype });
  }
  return events;
};

const codex = (r: Record<string, unknown>): ContentEvent[] => {
  if (r.type !== "item.completed") return [];
  const item = asRecord(r.item);
  if (item === null) return [];
  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "message", role: "assistant", text: item.text }];
  }
  if (item.type === "error" && typeof item.message === "string") {
    return [{ kind: "error", message: item.message }];
  }
  return [];
};

const pi = (r: Record<string, unknown>): ContentEvent[] => {
  if (r.type === "message_update") {
    const ev = asRecord(r.assistantMessageEvent);
    if (ev?.type === "text_delta" && typeof ev.delta === "string") {
      return [{ kind: "token", text: ev.delta }];
    }
    return [];
  }
  if (r.type === "message_end") {
    const message = asRecord(r.message);
    if (message?.role === "assistant") {
      const text = textOfBlocks(message.content);
      if (text !== "") return [{ kind: "message", role: "assistant", text }];
    }
  }
  return [];
};

const muse = (r: Record<string, unknown>): ContentEvent[] => {
  const payload = asRecord(r.payload);
  if (payload === null) return [];
  if (payload.kind === "run_output_delta" && typeof payload.text === "string") {
    return [{ kind: "token", text: payload.text }];
  }
  if (payload.kind === "run_terminal") {
    if (
      payload.terminal === "completed" &&
      typeof payload.text === "string" &&
      payload.text !== ""
    ) {
      return [{ kind: "message", role: "assistant", text: payload.text }];
    }
    if (payload.terminal === "failed") {
      const reason = typeof payload.reason === "string" ? payload.reason : "run failed";
      return [{ kind: "error", message: `muse run failed: ${reason}` }];
    }
  }
  return [];
};

const READERS: Record<HarnessName, (r: Record<string, unknown>) => ContentEvent[]> = {
  claude,
  codex,
  pi,
  muse,
};

export const contentEventsOf = (harness: HarnessName, raw: unknown): ContentEvent[] => {
  const record = asRecord(raw);
  if (record === null) return [];
  return READERS[harness](record);
};
