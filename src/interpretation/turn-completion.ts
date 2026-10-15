/** Successful native turn delimiters, not assistant-message heuristics.
 * These are the same wire shapes the content/session readers consume. */
import type { HarnessName } from "../knowledge/descriptor.js";
import { asRecord } from "./shape.js";

export const successfulTurnEnd = (harness: HarnessName, raw: unknown): boolean => {
  const r = asRecord(raw);
  if (r === null) return false;
  switch (harness) {
    case "claude":
    case "cursor":
      return r.type === "result" && r.subtype === "success" && r.is_error !== true;
    case "pi":
      return r.type === "agent_settled" && r.aborted !== true;
    case "codex":
      return r.type === "turn.completed";
    case "muse": {
      const payload = asRecord(r.payload);
      return payload?.kind === "run_terminal" && payload.terminal === "completed";
    }
    case "antigravity":
      return r.event === "result" && asRecord(r.result)?.status === "SUCCESS";
    case "popeye":
      return r.kind === "done" && r.cause === "clean";
  }
};
