import type { ReadTranscriptRequest } from "../../interpretation/transcript/envelopes.js";
import {
  assessments,
  emptyTranscript,
  failure,
} from "../../interpretation/transcript/envelopes.js";

export type { ReadTranscriptRequest } from "../../interpretation/transcript/envelopes.js";
export { emptyTranscript, failure } from "../../interpretation/transcript/envelopes.js";

import { createHash } from "node:crypto";
import { join } from "node:path";
import { encodeJson, TranscriptError } from "../../interpretation/transcript/json.js";
import { position } from "../../interpretation/transcript/native.js";
import type { TranscriptReader } from "../../interpretation/transcript/readers.js";
import type { CapabilityMap } from "../../knowledge/transcript/schema.js";
import type {
  Check,
  Consistency,
  Continuation,
  Issue,
  Mutable,
  Phase,
  RecordEnvelope,
} from "../../knowledge/transcript/wire.js";
import type { Clock } from "../deps.js";
import type { TranscriptFile, TranscriptFiles } from "./files.js";

export interface ReadTranscriptDeps {
  readonly reader: TranscriptReader;
  readonly clock: Clock;
  readonly files: TranscriptFiles;
  readonly signal?: AbortSignal;
  readonly write: (line: string) => Promise<void>;
}
function errorIssue(error: unknown): Issue {
  if (error instanceof TranscriptError) return error.issue;
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return code === "ENOENT" ? "source-not-found" : "source-inaccessible";
}
export async function readTranscript(
  request: ReadTranscriptRequest,
  deps: ReadTranscriptDeps,
): Promise<number> {
  const { result, source } = emptyTranscript(request);
  const reader = deps.reader;
  const continuation: Mutable<Continuation> = {
    input: request.since ? "not-checked" : "absent",
    output: "unavailable",
  };
  result.continuation = continuation;
  const consistencyIds = [
    ...reader.consistencyRuleIds,
    ...(request.since ? (reader.continuation?.ruleIds ?? []) : []),
  ];
  const checks: Mutable<Check>[] = consistencyIds.map((ruleId) => ({
    description: "Required native source check.",
    outcome: "unknown",
    ruleId,
  }));
  const consistency: Mutable<Consistency> = {
    assumptions: [
      "The selected native format uses the documented append-only writer protocol. File checks do not authenticate an unknown writer build or cover arbitrary in-place writers.",
    ],
    boundaries: [],
    checks,
    method: "unknown",
    ruleIds: consistencyIds,
  };
  result.consistency = consistency;
  source.methodId = reader.method.id;
  const selection = request.selection;
  let selectedFile = selection.kind === "file" ? selection.path : "";
  if (selection.kind === "id")
    source.selection = {
      kind: "id",
      storeRoots: [selection.storeRoot],
      value: selection.nativeId,
      workspace: request.workspace,
    };
  let file: TranscriptFile | undefined;
  let phase: Phase = "resolve";
  let records: RecordEnvelope[] = [];
  let issue: Issue | null = null;
  const checkAbort = (): void => {
    if (deps.signal?.aborted)
      throw new TranscriptError("interrupted", "The caller interrupted the native read.");
  };
  try {
    checkAbort();
    if (selection.kind === "id") {
      if (!selection.storeRoot || !deps.files.list)
        throw new TranscriptError("source-not-found", "Native lookup root is unavailable.");
      let match: string | null = null;
      for await (const name of deps.files.list(selection.storeRoot)) {
        if (!name.endsWith(`_${selection.nativeId}.jsonl`)) continue;
        if (match !== null)
          throw new TranscriptError(
            "source-ambiguous",
            "Multiple native sources match the requested ID.",
          );
        match = name;
      }
      if (!match)
        throw new TranscriptError(
          "source-not-found",
          "The requested native conversation does not exist.",
        );
      selectedFile = join(selection.storeRoot, match);
    }
    file = await deps.files.open(selectedFile);
    checkAbort();
    const before = await file.version();
    const bytes = await file.read(before.size);
    const hash = createHash("sha256");
    let hashedBytes = 0;
    const digestThrough = (end: number): string => {
      hash.update(bytes.subarray(hashedBytes, end));
      hashedBytes = end;
      return hash.copy().digest("hex");
    };
    checkAbort();
    let samePrefix = true;
    for (let offset = 0; offset < before.size; offset += 1024 * 1024) {
      const length = Math.min(1024 * 1024, before.size - offset);
      const chunk = await file.read(length, offset);
      if (chunk.length !== length || chunk.some((byte, index) => bytes[offset + index] !== byte)) {
        samePrefix = false;
        break;
      }
      checkAbort();
    }
    const [after, named] = await Promise.all([file.version(), deps.files.version(selectedFile)]);
    checkAbort();
    if (
      bytes.length !== before.size ||
      !samePrefix ||
      after.size < before.size ||
      named.identity !== before.identity ||
      after.identity !== before.identity
    ) {
      const prefixCheck = checks.find((check) => reader.consistencyRuleIds.includes(check.ruleId));
      if (prefixCheck) prefixCheck.outcome = "failed";
      if (request.since) continuation.input = "invalid";
      throw new TranscriptError("source-changed", "The native source changed during the read.");
    }
    const completeBytes = bytes.lastIndexOf(10) + 1;
    const history = reader.parse(bytes.subarray(0, completeBytes));
    const id = reader.nativeId(history);
    if (selection.kind === "id" && id !== selection.nativeId)
      throw new TranscriptError(
        "source-identity-mismatch",
        "Native header identity differs from the requested ID.",
      );
    const coverage = assessments("complete", reader.evidence);
    const capabilities: CapabilityMap = history.entries.length
      ? reader.method.capabilities
      : {
          ...reader.method.capabilities,
          "active-branch": {
            evidence: [],
            prerequisiteRuleIds: [],
            reason: "No saved native selection is established in this empty view.",
            status: "unknown",
          },
        };
    const compatibility = {
      evidence: [reader.evidence],
      reason:
        "Validated native identity, framing and source-prefix rules within the documented format applicability; no writer build is inferred from the format label.",
      ruleIds: reader.rules.map((rule) => rule.id),
      state: "verified",
    };
    const ruleIds = reader.rules.map((rule) => rule.id);
    Object.assign(source, {
      appliedRuleIds: ruleIds,
      capabilities,
      compatibility,
      conversation: { nativeId: id },
      historicalLoss: reader.historicalLoss,
      coverage,
      methodId: reader.method.id,
      nativeHeaders: [{ original: history.header, sourceKey: "source-0" }],
      sources: [
        {
          formatId: reader.evidence.appliesTo.formatId,
          formatVersion: reader.evidence.appliesTo.formatVersions[0] ?? null,
          key: "source-0",
          kind: "file",
          location: selectedFile,
          nativeId: id,
          writerBuild: { buildId: null, version: reader.writerVersion },
        },
      ],
      verification: [reader.evidence],
    });
    Object.assign(result, {
      appliedRuleIds: ruleIds,
      capabilities,
      compatibility,
      consistency,
      coverage,
      historicalLoss: reader.historicalLoss,
    });
    let start = 0;
    if (request.since) {
      try {
        if (!reader.continuation)
          throw new TranscriptError("fresh-read-required", "No compatible continuation reader.");
        const bookmark = reader.continuation.decode(request.since);
        const boundary = history.entries[bookmark.entries]?.offset ?? completeBytes;
        if (
          bookmark.conversationId !== id ||
          bookmark.entries > history.entries.length ||
          bookmark.offset !== boundary ||
          bookmark.digest !== digestThrough(boundary)
        )
          throw new TranscriptError(
            "fresh-read-required",
            "The prior native prefix cannot be verified.",
          );
        start = bookmark.entries;
        continuation.input = "verified";
        const check = checks.find((item) => reader.continuation?.ruleIds.includes(item.ruleId));
        if (check) check.outcome = "passed";
      } catch (error) {
        continuation.input = "invalid";
        const check = checks.find((item) => reader.continuation?.ruleIds.includes(item.ruleId));
        if (check) check.outcome = "failed";
        throw error;
      }
    }
    phase = "read";
    const end = Math.min(history.entries.length, start + (request.limit ?? history.entries.length));
    const selected = history.entries.slice(start, end);
    const progressBytes = history.entries[end]?.offset ?? completeBytes;
    phase = "verify";
    for (const check of checks) check.outcome = "passed";
    records = selected.map((entry) => reader.normalize(entry, id));
    const last = history.entries.at(-1);
    const progressed = history.entries[end - 1];
    consistency.method = "validated-prefix";
    consistency.boundaries = [
      {
        observedEntries: String(history.entries.length),
        observedThrough: last ? position(last.offset) : null,
        progressEntries: String(end),
        progressThrough: progressed ? position(progressed.offset) : null,
        sourceKey: "source-0",
      },
    ];
    let bookmark =
      reader.method.capabilities.incremental.status === "available" && reader.continuation
        ? reader.continuation.encode({
            conversationId: id,
            digest: digestThrough(progressBytes),
            entries: end,
            offset: progressBytes,
          })
        : null;
    if (bookmark && bookmark.length > 65536) {
      bookmark = null;
      const reduced: CapabilityMap = {
        ...capabilities,
        incremental: {
          status: "unavailable",
          evidence: [reader.evidence],
          prerequisiteRuleIds: [],
          reason: "Required source identity cannot fit in the 65536-byte bookmark envelope.",
        },
      };
      source.capabilities = reduced;
      result.capabilities = reduced;
    }
    continuation.output =
      bookmark !== null ? (end > start ? "advanced" : "same-boundary") : "unavailable";
    Object.assign(result, {
      activeBranch: reader.branch(history, id),
      bookmark,
      exitCode: 0,
      incompleteTail:
        completeBytes === bytes.length
          ? null
          : {
              position: position(completeBytes),
              reason: "Final native framing unit is unfinished.",
            },
      more: end < history.entries.length,
      recordsReturned: records.length,
      status: "complete",
    });
  } catch (error) {
    issue = errorIssue(error);
    continuation.output = "unavailable";
    const requirement =
      issue === "fresh-read-required"
        ? "bookmark"
        : issue === "guarantee-unmet" || issue === "source-malformed"
          ? "format"
          : issue === "source-changed"
            ? "consistency"
            : "identity";
    Object.assign(result, {
      bookmark: null,
      exitCode: 1,
      failure: failure(
        issue,
        phase,
        requirement,
        "The selected native transcript could not be read under its declared rules.",
      ),
      status: "failed",
    });
  } finally {
    if (file) {
      try {
        let timer: number | undefined;
        try {
          await Promise.race([
            file.close(),
            new Promise<never>((_, reject) => {
              timer = deps.clock.setTimeout(
                () =>
                  reject(new TranscriptError("cleanup-failed", "Native reader cleanup timed out.")),
                reader.method.cleanupTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) deps.clock.clearTimeout(timer);
        }
      } catch {
        if (!issue) {
          issue = "cleanup-failed";
          continuation.output = "unavailable";
          Object.assign(result, {
            bookmark: null,
            exitCode: 1,
            failure: failure(
              issue,
              "cleanup",
              "cleanup",
              "The native reader could not close its resources.",
            ),
            status: "failed",
          });
        }
      }
    }
  }
  if (deps.signal?.aborted && issue !== "interrupted") {
    issue = "interrupted";
    continuation.output = "unavailable";
    Object.assign(result, {
      bookmark: null,
      exitCode: 1,
      failure: failure(issue, "cleanup", "cleanup", "The caller interrupted the read."),
      status: "failed",
    });
  }
  await deps.write(`${encodeJson(source)}\n`);
  for (const record of records) {
    if (issue !== "interrupted") checkAbort();
    await deps.write(`${encodeJson(record)}\n`);
  }
  if (issue !== "interrupted") checkAbort();
  await deps.write(`${encodeJson(result)}\n`);
  if (issue !== "interrupted") checkAbort();
  return result.exitCode;
}
