import { promptTextOf } from "../interpretation/argv.js";
import { capabilitiesOf } from "../interpretation/capabilities.js";
import type { FileApprovalItem } from "../interpretation/native-approval-files.js";
import { assembleFileApproval, fileApprovalKey } from "../interpretation/native-approval-files.js";
import type { ApprovalProposal } from "../interpretation/native-approvals.js";
import {
  approvalInitialize,
  approvalInitialized,
  approvalResponse,
  approvalResume,
  approvalStart,
  approvalTurnId,
  decodeApprovalProtocol,
  matchesApprovalResume,
  parseApprovalDecision,
} from "../interpretation/native-approvals.js";
import { composeEscalatedPrompt } from "../interpretation/question.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { UUID_SHAPE } from "../knowledge/descriptor.js";
import type {
  NativeApprovalFailure,
  NativeApprovalFailureReason,
  NativeApprovalPhase,
  NativeApprovalSubmission,
} from "../knowledge/native-approvals.js";
import { NATIVE_APPROVAL_LIMITS } from "../knowledge/native-approvals.js";
import { AsyncChannel } from "./channel.js";
import type { RunnerDeps, SpawnedProcess, TimerHandle } from "./deps.js";
import type { HarnessEvent } from "./events.js";
import type { FailureSummary } from "./failure.js";
import {
  failureFromRejected,
  failureFromTask,
  failureFromTimeout,
  failureFromTransport,
  nativeApprovalPreflightEvidence,
} from "./failure.js";
import { ControlFrameError, ControlLines, LineBuffer } from "./lines.js";
import { nativeApprovalPlan } from "./native-approval-plan.js";
import type { TurnRunOptions } from "./stream-turn.js";
import { StderrTail, superviseTurn } from "./supervisor.js";

export async function* streamNativeApprovalTurn(
  h: HarnessDescriptor,
  opts: TurnRunOptions,
  deps: RunnerDeps,
): AsyncIterable<HarnessEvent> {
  const mode = opts.questions ?? "ask";
  const input = deps.approvalInput;
  const log = (event: Record<string, unknown>): void =>
    deps.log?.({ ...event, harness: h.name, sessionId: opts.resume, turnId: deps.turnId });
  if (opts.signal?.aborted) {
    input?.close();
    yield {
      kind: "done",
      cause: "killed",
      exitCode: null,
      escalation: { mode, detection: "none" },
    };
    return;
  }
  let plan: ReturnType<typeof nativeApprovalPlan>;
  try {
    if (!input)
      throw new ArgvRefusalError({
        issue: "invalid-option-value",
        harness: h.name,
        detail: "native approvals require a live decision channel",
      });
    plan = nativeApprovalPlan(h, opts, deps.inspectNativeSettings);
  } catch (cause) {
    input?.close();
    if (!(cause instanceof ArgvRefusalError)) throw cause;
    const failure: FailureSummary = {
      ...failureFromRejected({
        issue: cause.issue,
        option: cause.option,
        supported: cause.supported,
        detail: cause.message,
      }),
      nativeApproval: nativeApprovalPreflightEvidence(cause.issue),
    };
    log({ event: "rejected", issue: cause.issue });
    yield { kind: "failure", ...failure };
    yield {
      kind: "done",
      exitCode: null,
      cause: "failed",
      failure,
      escalation: { mode, detection: "none" },
    };
    return;
  }
  log({ event: "spawn", argv: plan.argv });
  let proc: SpawnedProcess;
  try {
    proc = deps.spawn(plan.argv, { cwd: opts.cwd, env: opts.env, stdin: "pipe" });
  } catch (cause) {
    input.close();
    const message = cause instanceof Error ? cause.message : "native process creation failed";
    const failure: FailureSummary = {
      ...failureFromTransport(`spawn failed: ${message}`),
      nativeApproval: {
        reason: "spawn-failed",
        phase: "preflight",
        prompt: "not-submitted",
        process: "unknown",
      },
    };
    log({ event: "exit", cause: "failed", exitCode: 127, failure });
    yield { kind: "error", message: `spawn failed: ${message}` };
    yield { kind: "failure", ...failure };
    yield {
      kind: "done",
      cause: "failed",
      exitCode: 127,
      failure,
      escalation: { mode, detection: "none" },
    };
    return;
  }
  const queue = new AsyncChannel<HarnessEvent>(32, 8);
  const pending = new Map<
    string,
    { readonly proposal: ApprovalProposal; readonly requestId: string; decided: boolean }
  >();
  const decisionsById = new Map<
    string,
    {
      readonly requestId: string;
      readonly choiceId: string;
      readonly disposition: Extract<HarnessEvent, { kind: "approval-disposition" }>;
    }
  >();
  const beforeAck: ApprovalProposal[] = [];
  const nativeRequestIds = new Set<string>();
  const requestIds = new Set<string>();
  const ignoredNativeMethods = new Set<string>();
  let ignoredNativeNotificationCount = 0;
  const fileItems = new Map<string, FileApprovalItem>();
  let failure: FailureSummary | undefined;
  let failureReason: NativeApprovalFailureReason = "native-process-ended";
  let processStart: NativeApprovalFailure["process"] = "unknown";
  let promptSubmission: NativeApprovalSubmission = "not-submitted";
  void proc.started?.then((start) => {
    processStart =
      start.kind === "started"
        ? "started"
        : start.kind === "not-started"
          ? "not-started"
          : "unknown";
  });
  let completed = false;
  let cancelled = false;
  let exited = false;
  let closing = false;
  let turnId: string | null = null;
  const matchesTurn = (value: { readonly sessionId: string; readonly turnId: string }): boolean =>
    value.sessionId === plan.saved.sessionId && value.turnId === turnId;
  let stage: NativeApprovalPhase = "initialize";
  let timer: TimerHandle | null = null;
  const stop = (
    reason: NativeApprovalFailureReason,
    detail: string = reason,
    summary?: FailureSummary,
  ): void => {
    if (closing) return;
    closing = true;
    failureReason = reason;
    failure ??= summary ?? failureFromTask(detail);
    input.close();
    supervisor.escalate();
  };
  const write = (text: string): boolean => {
    if (closing || exited) return false;
    try {
      if (!proc.stdin) throw new Error("native stdin unavailable");
      proc.stdin.write(text);
      return true;
    } catch {
      stop("approval-channel-lost");
      return false;
    }
  };
  const arm = (): void => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = deps.clock.setTimeout(
      () => stop("native-protocol-timeout", "native approval protocol deadline exceeded"),
      NATIVE_APPROVAL_LIMITS.protocolDeadlineMs,
    );
  };
  const supervisor = superviseTurn(h, mode, {
    clock: deps.clock,
    stallMs: deps.stallMs,
    signal: (sig) => deps.signal(proc, sig),
    emit: (event) => queue.push(event),
    fail: async (summary) => {
      if (!failure) {
        failure = summary;
        failureReason = "native-process-failed";
      }
      stop("native-process-failed", summary.message, summary);
    },
    tail: new StderrTail(),
    onStall: () => stop("inactivity", "native approval response exceeded inactivity budget"),
    onQuestion: () => {},
  });
  const updateWait = (): void => {
    if (stage !== "running" || closing) return;
    if ([...pending.values()].some((request) => !request.decided)) supervisor.pauseInactivity();
    else supervisor.resumeInactivity();
  };
  const onAbort = (): void => {
    if (closing || exited) return;
    cancelled = true;
    closing = true;
    input.close();
    supervisor.escalate();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  const hardDeadline =
    deps.turnTimeoutMs === undefined
      ? null
      : deps.clock.setTimeout(
          () => stop("timeout", "native approval hard deadline exceeded", failureFromTimeout()),
          deps.turnTimeoutMs,
        );
  void proc.inputError?.then(() => stop("approval-channel-lost"));
  void proc.exited.then(() => {
    exited = true;
    supervisor.settle();
    input.close();
    if (timer !== null) deps.clock.clearTimeout(timer);
    proc.disposeOutput();
  });
  const clear = async (
    key: string,
    reason: "native-resolved" | "turn-ended" | "process-ended" | "channel-failed",
  ): Promise<void> => {
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key);
    updateWait();
    await queue.push({ kind: "approval-cleared", requestId: request.requestId, reason, v: 1 });
  };
  const publishRequest = async (p: ApprovalProposal): Promise<void> => {
    if (closing || exited) return;
    const key = JSON.stringify(p.nativeId);
    if (
      stage !== "running" ||
      !matchesTurn(p) ||
      pending.has(key) ||
      pending.size >= NATIVE_APPROVAL_LIMITS.pending
    ) {
      stop("unsupported-native-interaction");
      return;
    }
    const requestId = input.newId();
    if (
      !UUID_SHAPE.test(requestId) ||
      requestIds.has(requestId) ||
      requestIds.size >= NATIVE_APPROVAL_LIMITS.identities
    ) {
      stop("approval-channel-lost", "invalid approval request identity");
      return;
    }
    requestIds.add(requestId);
    pending.set(key, { proposal: p, requestId, decided: false });
    updateWait();
    await queue.push({
      category: p.category,
      choices: p.choices.map(({ payload: _payload, ...choice }) => choice),
      details: p.details,
      kind: "approval-request",
      requestId,
      sessionId: p.sessionId,
      turnId: p.turnId,
      v: 1,
    });
  };
  const receiveProposal = async (proposal: ApprovalProposal): Promise<void> => {
    if (closing || exited) return;
    const key = JSON.stringify(proposal.nativeId);
    if (nativeRequestIds.has(key) || nativeRequestIds.size >= NATIVE_APPROVAL_LIMITS.identities) {
      stop("unsupported-native-interaction", "native request identity reused or exhausted");
      return;
    }
    nativeRequestIds.add(key);
    if (stage === "turn-start") {
      if (beforeAck.length >= NATIVE_APPROVAL_LIMITS.pending)
        stop("unsupported-native-interaction");
      else beforeAck.push(proposal);
    } else await publishRequest(proposal);
  };
  const publishFileActivity = async (item: FileApprovalItem): Promise<void> => {
    if (!matchesTurn(item)) stop("unsupported-native-interaction");
    else await queue.push({ kind: "tool", name: "file_change", input: item.details });
  };
  const stdout = (async (): Promise<void> => {
    const lines = new ControlLines(NATIVE_APPROVAL_LIMITS.nativeFrameBytes);
    for await (const chunk of proc.stdout) {
      supervisor.rearm();
      for (const raw of lines.push(chunk)) {
        if (closing) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          stop("native-protocol-failed", "invalid native approval protocol");
          continue;
        }
        const message = decodeApprovalProtocol(value);
        if (message.kind === "unsupported") {
          stop("unsupported-native-interaction");
          continue;
        }
        if (message.kind === "reply") {
          if (exited && message.operation !== "start") continue;
          if (message.failed) {
            stop("native-protocol-failed", "native approval protocol request failed");
            continue;
          }
          if (stage === "initialize" && message.operation === "initialize") {
            stage = "resume";
            write(approvalInitialized());
            write(approvalResume(plan.saved));
            arm();
          } else if (stage === "resume" && message.operation === "resume") {
            if (!matchesApprovalResume(message.value, plan.saved)) {
              stop("native-settings-mismatch");
              continue;
            }
            await queue.push({
              kind: "identity",
              authority: "caller-assigned",
              sessionId: plan.saved.sessionId,
              capabilities: capabilitiesOf(h, plan.saved.model, "headless-turn"),
            });
            if (closing || exited) continue;
            stage = "turn-start";
            promptSubmission = "submission-unknown";
            write(
              approvalStart(plan.saved.sessionId, composeEscalatedPrompt(promptTextOf(opts), mode)),
            );
            arm();
          } else if (stage === "turn-start" && message.operation === "start") {
            turnId = approvalTurnId(message.value);
            if (!turnId) {
              stop("native-protocol-failed", "native turn identity unavailable");
              continue;
            }
            stage = "running";
            promptSubmission = "acknowledged";
            if (exited) {
              beforeAck.length = 0;
              continue;
            }
            supervisor.beginTurn();
            if (timer !== null) deps.clock.clearTimeout(timer);
            timer = null;
            for (const item of fileItems.values()) {
              if (closing) break;
              await publishFileActivity(item);
            }
            for (const proposal of beforeAck) {
              if (closing) break;
              await publishRequest(proposal);
            }
            beforeAck.length = 0;
          } else stop("native-protocol-failed", "unexpected native protocol reply");
        } else if (message.kind === "request") {
          await receiveProposal(message.proposal);
        } else if (message.kind === "file-item") {
          const key = fileApprovalKey(message.item);
          if (
            (stage !== "turn-start" && stage !== "running") ||
            message.item.sessionId !== plan.saved.sessionId ||
            (turnId !== null && message.item.turnId !== turnId) ||
            fileItems.has(key) ||
            fileItems.size >= NATIVE_APPROVAL_LIMITS.pending
          )
            stop("unsupported-native-interaction");
          else {
            fileItems.set(key, message.item);
            if (stage === "running") await publishFileActivity(message.item);
          }
        } else if (message.kind === "file-request") {
          const proposal = assembleFileApproval(
            message.request,
            fileItems.get(fileApprovalKey(message.request)),
            plan.saved.cwd,
          );
          if (!proposal) stop("unsupported-native-interaction");
          else await receiveProposal(proposal);
        } else if (message.kind === "file-item-ended") {
          if (
            message.item.sessionId !== plan.saved.sessionId ||
            (turnId !== null && message.item.turnId !== turnId)
          )
            stop("unsupported-native-interaction");
          else fileItems.delete(fileApprovalKey(message.item));
        } else if (message.kind === "ignored") {
          ignoredNativeNotificationCount++;
          if (
            ignoredNativeMethods.size < 32 &&
            /^[A-Za-z][A-Za-z0-9./_-]{0,127}$/.test(message.method)
          )
            ignoredNativeMethods.add(message.method);
        } else if (message.kind === "cleared") {
          if (message.sessionId !== plan.saved.sessionId) stop("unsupported-native-interaction");
          else {
            const buffered = beforeAck.findIndex(
              (proposal) => proposal.nativeId === message.nativeId,
            );
            if (buffered !== -1) beforeAck.splice(buffered, 1);
            await clear(JSON.stringify(message.nativeId), "native-resolved");
          }
        } else if (message.kind === "content") {
          if (!matchesTurn(message)) stop("unsupported-native-interaction");
          else {
            if (message.event.kind === "error" && message.event.terminal)
              stop("native-process-failed", message.event.message);
            await queue.push(message.event);
          }
        } else if (message.kind === "message") {
          if (!matchesTurn(message)) stop("unsupported-native-interaction");
          else {
            const event = { kind: "message", role: "assistant", text: message.text } as const;
            supervisor.noteEvent(event);
            await queue.push(event);
          }
        } else if (message.kind === "complete") {
          if (!matchesTurn(message) || message.failed) {
            const detail = message.error ?? "native response failed";
            stop("native-process-failed", detail);
            await queue.push({ kind: "error", message: detail, terminal: true });
            continue;
          }
          completed = true;
          cancelled = message.interrupted;
          closing = true;
          supervisor.disarm();
          input.close();
          for (const key of pending.keys()) await clear(key, "turn-ended");
          proc.stdin?.end();
          timer = deps.clock.setTimeout(
            () => supervisor.escalate(),
            NATIVE_APPROVAL_LIMITS.exitGraceMs,
          );
        }
      }
    }
  })().catch((cause: unknown) =>
    stop(
      "native-protocol-failed",
      `native approval output failed: ${cause instanceof ControlFrameError ? cause.code : "stream-error"}`,
    ),
  );
  const stderr = (async (): Promise<void> => {
    const lines = new LineBuffer();
    for await (const chunk of proc.stderr) {
      supervisor.rearm();
      for (const line of lines.push(chunk)) await supervisor.stderrLine(line);
    }
  })().catch(() => stop("approval-channel-lost", "native approval stderr failed"));
  const decisions = (async (): Promise<void> => {
    const lines = new ControlLines(NATIVE_APPROVAL_LIMITS.decisionBytes);
    for await (const chunk of input.chunks) {
      for (const raw of lines.push(chunk)) {
        const parsed = parseApprovalDecision(raw);
        if (parsed.kind === "invalid") {
          await queue.push({
            kind: "approval-disposition",
            id: parsed.id,
            requestId: parsed.requestId,
            status: "rejected",
            reason: "invalid-decision",
            v: 1,
          });
          continue;
        }
        const decision = parsed.decision;
        const { id: decisionId, requestId } = decision;
        const reject = (
          reason: string,
        ): Extract<HarnessEvent, { kind: "approval-disposition" }> => ({
          kind: "approval-disposition",
          id: decisionId,
          requestId,
          status: "rejected",
          reason,
          v: 1,
        });
        const previous = decisionsById.get(decisionId);
        if (previous) {
          await queue.push(
            previous.requestId === requestId && previous.choiceId === decision.choiceId
              ? previous.disposition
              : reject("decision-conflict"),
          );
          continue;
        }
        if (decisionsById.size >= NATIVE_APPROVAL_LIMITS.identities) {
          stop("approval-channel-lost", "native approval decision bound exceeded");
          continue;
        }
        const found = [...pending.values()].find((r) => r.requestId === requestId);
        const choice = found?.proposal.choices.find((c) => c.id === decision.choiceId);
        if (closing || exited || !found || found.decided || !choice) {
          const disposition = reject(
            closing || exited || !found || found.decided
              ? "request-unavailable"
              : "choice-unavailable",
          );
          decisionsById.set(decisionId, { requestId, choiceId: decision.choiceId, disposition });
          await queue.push(disposition);
          continue;
        }
        found.decided = true;
        const sent = write(approvalResponse(found.proposal.nativeId, choice.payload));
        updateWait();
        if (sent) {
          const disposition = {
            kind: "approval-disposition",
            id: decisionId,
            requestId,
            status: "sent",
            v: 1,
          } as const;
          decisionsById.set(decisionId, {
            requestId: found.requestId,
            choiceId: choice.id,
            disposition,
          });
          await queue.push(disposition);
        }
      }
    }
    if (!closing && !exited) stop("approval-channel-lost");
  })().catch((cause: unknown) =>
    stop(
      "approval-channel-lost",
      `approval channel failed: ${cause instanceof ControlFrameError ? cause.code : "stream-error"}`,
    ),
  );
  if (!closing) {
    arm();
    write(approvalInitialize());
  }
  const finished = (async (): Promise<void> => {
    const exitCode = await proc.exited;
    await Promise.all([stdout, stderr, decisions]);
    const startupError = proc.startupError?.();
    if (startupError && !failure) {
      failure = failureFromTransport(`spawn failed: ${startupError}`);
      failureReason = "spawn-failed";
    }
    if (hardDeadline !== null) deps.clock.clearTimeout(hardDeadline);
    for (const key of pending.keys())
      await clear(key, failure ? "channel-failed" : "process-ended");
    const close =
      completed && !failure && exitCode === 0
        ? supervisor.close()
        : { asked: false, detection: "none" as const };
    if (!completed && !failure && !cancelled)
      failure = failureFromTask("native process ended before response completion");
    if (failure) {
      failure = {
        ...failure,
        nativeApproval: {
          reason: failureReason,
          phase: stage,
          prompt: promptSubmission,
          process: processStart,
        },
      };
      await queue.push({ kind: "failure", ...failure });
    }
    const done: Extract<HarnessEvent, { kind: "done" }> = {
      kind: "done",
      exitCode,
      cause:
        cancelled || failure?.class === "timeout"
          ? "killed"
          : completed && !failure && exitCode === 0
            ? close.asked
              ? "awaiting-input"
              : "clean"
            : "failed",
      ...(failure ? { failure } : {}),
      escalation: { mode, detection: close.detection },
    };
    log({
      event: "exit",
      cause: done.cause,
      exitCode,
      ignoredNativeNotificationCount,
      ignoredNativeMethods: [...ignoredNativeMethods],
      ...(failure ? { failure } : {}),
    });
    await queue.push(done);
    queue.close();
  })();
  try {
    for await (const event of queue) yield event;
    await finished;
  } finally {
    closing = true;
    queue.close();
    input.close();
    if (!exited) supervisor.escalate();
    await proc.exited;
    proc.disposeOutput();
    await Promise.all([stdout, stderr, decisions]);
    supervisor.settle();
    if (timer !== null) deps.clock.clearTimeout(timer);
    if (hardDeadline !== null) deps.clock.clearTimeout(hardDeadline);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
