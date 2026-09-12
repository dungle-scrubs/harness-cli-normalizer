import { codexCli } from "../knowledge/codex.js";
import { isNativeFolder } from "./native-path.js";
import { asRecord } from "./shape.js";
import { CLEAN_SELECTOR, validateEffort } from "./vocabulary.js";

type CodexSettingsRecord =
  | {
      readonly cwd: string;
      readonly kind: "metadata";
      readonly provider: string;
      readonly sessionId: string;
    }
  | {
      readonly cwd: string;
      readonly effort: string;
      readonly kind: "settings";
      readonly model: string;
    }
  | { readonly kind: "other" };

const selector = (value: unknown): value is string =>
  typeof value === "string" && CLEAN_SELECTOR.test(value);

/** Select native metadata only; conversation text never becomes settings. */
export function parseCodexSettingsRecord(value: unknown): CodexSettingsRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;
  if (record.type !== "session_meta" && record.type !== "turn_context") return { kind: "other" };
  const payload = asRecord(record.payload);
  if (!payload || !isNativeFolder(payload.cwd)) return null;
  if (record.type === "session_meta")
    return typeof payload.id === "string" && selector(payload.model_provider)
      ? {
          cwd: payload.cwd,
          kind: "metadata",
          provider: payload.model_provider,
          sessionId: payload.id,
        }
      : null;
  return selector(payload.model) &&
    typeof payload.effort === "string" &&
    validateEffort(codexCli, payload.effort).ok
    ? { cwd: payload.cwd, effort: payload.effort, kind: "settings", model: payload.model }
    : null;
}
