import {
  CODEX_HISTORICAL_LOSS,
  CODEX_TRANSCRIPT,
  CODEX_TRANSCRIPT_EVIDENCE,
  CODEX_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/codex.js";
import {
  PI_TRANSCRIPT,
  PI_TRANSCRIPT_EVIDENCE,
  PI_TRANSCRIPT_METHOD,
} from "../../knowledge/transcript/pi.js";
import type { Evidence } from "../../knowledge/transcript/schema.js";
import type {
  BranchObservation,
  HistoricalLoss,
  Method,
  RecordEnvelope,
  Rule,
  TranscriptKnowledge,
} from "../../knowledge/transcript/wire.js";
import type { Bookmark } from "./bookmark.js";
import { decodeBookmark, encodeBookmark } from "./bookmark.js";
import { codexNativeId, normalizeCodex, parseCodexHistory } from "./codex.js";
import { string } from "./json.js";
import type { NativeEntry, NativeHistory } from "./native.js";
import { normalizePi, parsePiHistory, piBranch } from "./pi.js";

export interface TranscriptReader {
  readonly method: Method;
  readonly historicalLoss: HistoricalLoss;
  readonly evidence: Evidence;
  readonly rules: readonly Rule[];
  readonly consistencyRuleIds: readonly string[];
  readonly continuation: {
    readonly ruleIds: readonly string[];
    decode(token: string): Bookmark;
    encode(value: Omit<Bookmark, "methodId" | "bookmarkVersion">): string;
  } | null;
  readonly writerVersion: string | null;
  branch(history: NativeHistory, id: string): BranchObservation;
  nativeId(history: NativeHistory): string;
  normalize(entry: NativeEntry, id: string): RecordEnvelope;
  parse(bytes: string | Uint8Array): NativeHistory;
}
function rulesFor(knowledge: TranscriptKnowledge, method: Method): readonly Rule[] {
  return knowledge.rules.filter((rule) => method.ruleIds.includes(rule.id));
}
export function readerForMethod(method: Method): TranscriptReader | null {
  if (method.id === PI_TRANSCRIPT_METHOD.id) {
    const rules = rulesFor(PI_TRANSCRIPT, method);
    return {
      method,
      branch: piBranch,
      historicalLoss: { state: "unknown", details: [], evidence: [] },
      evidence: PI_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: {
        ruleIds: rules.filter((rule) => rule.purpose === "continuation").map((rule) => rule.id),
        decode: (token) => decodeBookmark(token, method.id),
        encode: (value) => encodeBookmark({ ...value, methodId: method.id, bookmarkVersion: 1 }),
      },
      nativeId: (history) => string(history.header.id) ?? "",
      normalize: normalizePi,
      parse: parsePiHistory,
      writerVersion: null,
    };
  }
  if (method.id === CODEX_TRANSCRIPT_METHOD.id) {
    const rules = rulesFor(CODEX_TRANSCRIPT, method);
    return {
      method,
      branch: () => ({ evidence: [], selection: null, state: "unknown", view: "unknown" }),
      historicalLoss: CODEX_HISTORICAL_LOSS,
      evidence: CODEX_TRANSCRIPT_EVIDENCE,
      rules,
      consistencyRuleIds: rules
        .filter((rule) => rule.purpose === "consistency")
        .map((rule) => rule.id),
      continuation: null,
      nativeId: codexNativeId,
      normalize: normalizeCodex,
      parse: parseCodexHistory,
      writerVersion: CODEX_TRANSCRIPT_EVIDENCE.appliesTo.writerBuilds[0]?.version ?? null,
    };
  }
  return null;
}
