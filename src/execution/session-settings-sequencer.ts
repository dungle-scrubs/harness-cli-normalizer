/**
 * Issue #456: the settings-op sequencer of one persistent session,
 * extracted from openSession (review round 1, F12). One op is on the wire
 * at a time (pi answers rpc commands asynchronously; two model writes
 * racing could apply out of order while both reported applied), and the
 * writes of one op are sequenced behind each other: on pi, a model op
 * reads the session's own catalog (`get_available_models`) first and
 * resolves the selector exactly the way the spawn flags do
 * (resolvePiSessionModel), and every pi op ends with a `get_state`
 * readback so the receipt reports the EFFECTIVE model and thinking level
 * - pi clamps both silently. Claude ops write `set_model` then
 * `apply_flag_settings` and report the model the harness confirmed plus
 * the requested effort (claude has no effort readback; the docs say so).
 *
 * Every op is owed exactly one receipt whatever happens next: native
 * rejection (with the part that applied), invalid values (no write),
 * closed, or write-failed - including ops still queued when the session
 * dies or the stdin pipe breaks asynchronously.
 */

import type { SessionRecord } from "../interpretation/session-input.js";
import {
  encodeSessionSettingsCatalog,
  encodeSessionSettingsEffort,
  encodeSessionSettingsModel,
  encodeSessionSettingsState,
  type PiModelRef,
  resolvePiSessionModel,
  settingsCatalogId,
  settingsEffortId,
  settingsModelId,
  settingsStateId,
  validateSessionSettings,
} from "../interpretation/session-settings.js";
import type { HarnessDescriptor, SessionInputContract } from "../knowledge/descriptor.js";

/** Issue #456: one settings op's receipt, exactly one per well-formed
 * op. `applied` follows every native response succeeding; a
 * `native-rejected` partial application reports the part that applied in
 * `model`/`effort`. A Pi state readback that failed or came back
 * partial after the writes succeeded (review rounds 3 H2, 4 J4) reports
 * `applied` with only the values
 * the readback confirmed and lists the parts it wrote but could not
 * read back in `unconfirmed` - pi clamps silently, so the write's
 * acknowledgment is not the effective value. */
export interface SessionSettingsReceipt {
  readonly state: "applied" | "rejected";
  readonly reason?:
    | "invalid-model"
    | "invalid-effort"
    | "unsupported"
    | "native-rejected"
    | "closed"
    | "write-failed";
  readonly model?: string;
  readonly effort?: string;
  readonly unconfirmed?: readonly ("model" | "effort")[];
}

/** One settings op as the host submitted it - the shape the session
 * handle, this sequencer and the CLI's stdin settings op share. */
export interface SessionSettingsRequest {
  readonly id: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface SettingsSequencerIO {
  readonly sessionId: string;
  readonly log: (entry: Record<string, unknown>) => void;
  readonly isClosed: () => boolean;
  /** May throw: broken stdin pipe. */
  readonly write: (line: string) => void;
  /** The session's broken-pipe shutdown. */
  readonly onWriteFailed: () => void;
  /** The session's --provider (pi), constraining model resolution. */
  readonly sessionProvider?: string;
  /** The session's current model - the last one a settings op applied,
   * else the spawn model - so a later op's effort ladder follows the
   * model the session actually runs, not the spawn one. */
  readonly currentModel: () => string | undefined;
  /** Notified with the model each applied op leaves the session on. */
  readonly onModelResolved: (model: string) => void;
  /** Fresh correlation token per op (the runner's command sequence). */
  readonly nextToken: () => string;
}

type Phase = "catalog" | "model" | "effort" | "state" | "done";

interface PendingSettings {
  readonly id: string;
  /** The op's model as validated: claude's resolved id, pi's selector. */
  readonly model?: { readonly id: string };
  /** Pi only: the resolved pair, set when the catalog phase answers. */
  piRef?: PiModelRef;
  /** The op's effort: the field the host named, or on pi the level a
   * `model:level` selector parsed (set when the catalog phase answers;
   * an explicit effort always wins, as pi's `--thinking` beats the
   * suffix). */
  effort?: string;
  phase: Phase;
  /** The model write was acknowledged; its native confirmation. */
  modelApplied: boolean;
  confirmedModel?: string;
  /** The effort write was acknowledged. */
  effortApplied: boolean;
  /** Pi's state readback: the effective `provider/id` and level. */
  stateModel?: string;
  stateEffort?: string;
  readonly resolve: (receipt: SessionSettingsReceipt) => void;
}

export interface SettingsSequencer {
  submit(request: SessionSettingsRequest): Promise<SessionSettingsReceipt>;
  /** Feed one decoded settings-answered record. Only the in-flight op's
   * OWN outstanding write settles it; any other response is ignored. */
  onAnswered(record: Extract<SessionRecord, { kind: "settings-answered" }>): void;
  /** The stdin pipe broke asynchronously: every in-flight and queued op
   * settles write-failed with the part that applied. */
  writeFailedAll(): void;
  /** The session is gone: every op settles closed with the part that
   * applied. */
  closeAll(): void;
}

export const createSettingsSequencer = (
  h: HarnessDescriptor,
  input: SessionInputContract,
  io: SettingsSequencerIO,
): SettingsSequencer => {
  const isPi = input.kind === "pi-rpc-prompt";
  // One op on the wire at a time; the rest wait in arrival order, each
  // as the closure that validates and starts it when the wire frees.
  let tokenInFlight: string | undefined;
  let inFlight: PendingSettings | undefined;
  interface QueuedSettings {
    readonly token: string;
    readonly id: string;
    readonly resolve: (receipt: SessionSettingsReceipt) => void;
    /** Validates against the model current at dispatch and takes the
     * wire (or rejects without writing). */
    readonly start: (token: string) => void;
  }
  const queued: QueuedSettings[] = [];

  /** The fields a receipt reports: only what actually applied. On pi the
   * state readback wins when it answered (it is the effective value);
   * the write confirmations stand in for it otherwise. */
  const appliedFields = (entry: PendingSettings): { model?: string; effort?: string } => ({
    ...(isPi
      ? entry.stateModel !== undefined
        ? { model: entry.stateModel }
        : entry.modelApplied && entry.piRef !== undefined
          ? { model: `${entry.piRef.provider}/${entry.piRef.modelId}` }
          : {}
      : entry.modelApplied && entry.confirmedModel !== undefined
        ? { model: entry.confirmedModel }
        : {}),
    ...(isPi
      ? entry.stateEffort !== undefined
        ? { effort: entry.stateEffort }
        : entry.effortApplied && entry.effort !== undefined
          ? { effort: entry.effort }
          : {}
      : entry.effortApplied && entry.effort !== undefined
        ? { effort: entry.effort }
        : {}),
  });

  const emit = (id: string, token: string | undefined, receipt: SessionSettingsReceipt): void => {
    io.log({
      event: "settings",
      sessionId: io.sessionId,
      id,
      ...(token === undefined ? {} : { token }),
      ...receipt,
    });
  };

  /** A Pi state readback that could not confirm everything it wrote -
   * a native error, an answer that carried neither field, or a PARTIAL
   * answer that omitted one: the op applied, but only the readback
   * confirms the EFFECTIVE values (pi clamps silently, so the write's
   * acknowledgment is not one) - the parts it wrote but could not read
   * back are `unconfirmed`, never silently reported from the requested
   * value (review rounds 3 H2, 4 J4). */
  const readbackReceipt = (entry: PendingSettings): SessionSettingsReceipt => {
    const unconfirmed = [
      ...(entry.modelApplied && entry.stateModel === undefined ? (["model"] as const) : []),
      ...(entry.effortApplied && entry.stateEffort === undefined ? (["effort"] as const) : []),
    ];
    return {
      state: "applied",
      ...(entry.stateModel !== undefined ? { model: entry.stateModel } : {}),
      ...(entry.stateEffort !== undefined ? { effort: entry.stateEffort } : {}),
      ...(unconfirmed.length > 0 ? { unconfirmed } : {}),
    };
  };

  const settleInFlight = (receipt: SessionSettingsReceipt): void => {
    if (inFlight === undefined || tokenInFlight === undefined) return;
    const entry = inFlight;
    inFlight = undefined;
    const token = tokenInFlight;
    tokenInFlight = undefined;
    // The applied model becomes current BEFORE the next op dispatches: a
    // queued op's validation reads the model this one leaves behind, not
    // the one it found (review round 2, G8).
    const appliedModel = appliedFields(entry).model;
    if (receipt.state === "applied" && appliedModel !== undefined) io.onModelResolved(appliedModel);
    // The settled op's receipt leaves BEFORE the queue drains: a queued op
    // can settle inside the drain (closed, or invalid at dispatch), and
    // the host reads receipts in the order the ops were submitted
    // (review round 3, H4).
    emit(entry.id, token, receipt);
    entry.resolve(receipt);
    // The wire is free: start the next queued op now, unless the session
    // is gone - then it and the rest settle closed without writing. An
    // op that invalidates at dispatch settles the same way and the one
    // behind it starts, until one takes the wire or none remain.
    while (inFlight === undefined) {
      const next = queued.shift();
      if (next === undefined) break;
      if (io.isClosed()) {
        emit(next.id, next.token, { state: "rejected", reason: "closed" });
        next.resolve({ state: "rejected", reason: "closed" });
        continue;
      }
      next.start(next.token);
    }
  };

  /** Write the next native command of the in-flight op; a broken pipe
   * rejects the op write-failed with the half that already applied. */
  const writeStep = (entry: PendingSettings): void => {
    if (entry.phase === "done" || tokenInFlight === undefined) return;
    let line: string | null = null;
    if (entry.phase === "catalog")
      line = encodeSessionSettingsCatalog(input, settingsCatalogId(tokenInFlight));
    else if (entry.phase === "model" && entry.model !== undefined)
      line = encodeSessionSettingsModel(input, settingsModelId(tokenInFlight), {
        id: entry.model.id,
        ...(entry.piRef === undefined ? {} : { pi: entry.piRef }),
      });
    else if (entry.phase === "effort" && entry.effort !== undefined)
      line = encodeSessionSettingsEffort(input, settingsEffortId(tokenInFlight), entry.effort);
    else if (entry.phase === "state")
      line = encodeSessionSettingsState(input, settingsStateId(tokenInFlight));
    if (line === null || line === "") {
      settleInFlight({ state: "applied", ...appliedFields(entry) });
      return;
    }
    try {
      io.write(line);
    } catch {
      io.onWriteFailed();
      settleInFlight({ state: "rejected", reason: "write-failed", ...appliedFields(entry) });
    }
  };

  return {
    submit(request) {
      return new Promise<SessionSettingsReceipt>((resolve) => {
        if (io.isClosed()) {
          emit(request.id, undefined, { state: "rejected", reason: "closed" });
          resolve({ state: "rejected", reason: "closed" });
          return;
        }
        // Validation runs when the op takes the wire, not when it is
        // submitted: an op queued behind another reads the session's
        // CURRENT model - the one the previous op leaves behind - so its
        // effort ladder follows the model the session will actually run
        // (review round 2, G8). Invalid values still reject without a
        // native write.
        const start = (token: string): void => {
          const validated = validateSessionSettings(h, input, request, {
            ...(io.currentModel() === undefined ? {} : { model: io.currentModel() }),
            ...(io.sessionProvider === undefined ? {} : { provider: io.sessionProvider }),
          });
          if (!validated.ok) {
            emit(request.id, token, { state: "rejected", reason: validated.reason });
            resolve({ state: "rejected", reason: validated.reason });
            return;
          }
          const entry: PendingSettings = {
            id: request.id,
            ...(validated.value.model === undefined ? {} : { model: validated.value.model }),
            ...(validated.value.effort === undefined ? {} : { effort: validated.value.effort }),
            phase: validated.value.model === undefined ? "effort" : isPi ? "catalog" : "model",
            modelApplied: false,
            effortApplied: false,
            resolve,
          };
          inFlight = entry;
          tokenInFlight = token;
          writeStep(entry);
        };
        if (inFlight !== undefined) {
          queued.push({ token: io.nextToken(), id: request.id, resolve, start });
          return;
        }
        start(io.nextToken());
      });
    },
    onAnswered(record) {
      if (inFlight === undefined || tokenInFlight === undefined) return;
      // Only the response whose token names the in-flight op AND whose
      // phase is the write outstanding on the wire settles anything: a
      // stale duplicate from an earlier op, or a premature answer to
      // another half, is ignored and logged - it must not advance,
      // reject or settle an op it does not belong to (review round 2, G1).
      if (record.token !== tokenInFlight || record.part !== inFlight.phase) {
        io.log({
          event: "settings_stale",
          sessionId: io.sessionId,
          token: record.token,
          part: record.part,
        });
        return;
      }
      if (!record.ok) {
        if (record.part === "state") {
          // The writes applied; only the readback failed. The op settles
          // applied with what the readback could confirm and `unconfirmed`
          // naming the rest; the control path delivers the diagnostic
          // alongside the receipt (review round 3, H2).
          settleInFlight(readbackReceipt(inFlight));
          return;
        }
        settleInFlight({
          state: "rejected",
          reason: "native-rejected",
          ...appliedFields(inFlight),
        });
        return;
      }
      switch (record.part) {
        case "catalog": {
          const resolved = resolvePiSessionModel(record.models ?? [], {
            text: inFlight.model?.id ?? "",
            ...(io.sessionProvider === undefined ? {} : { provider: io.sessionProvider }),
          });
          if (resolved.status === "invalid") {
            settleInFlight({ state: "rejected", reason: "invalid-model" });
            return;
          }
          inFlight.piRef = resolved.ref;
          // A `model:level` selector carries its level the way pi's
          // spawn `--model` does: it applies when the op named no
          // explicit effort (pi's own `--thinking` wins over the suffix).
          if (resolved.thinkingLevel !== undefined && inFlight.effort === undefined)
            inFlight.effort = resolved.thinkingLevel;
          inFlight.phase = "model";
          writeStep(inFlight);
          return;
        }
        case "model": {
          inFlight.modelApplied = true;
          inFlight.confirmedModel =
            record.model ?? (isPi ? inFlight.piRef?.modelId : undefined) ?? inFlight.model?.id;
          inFlight.phase = inFlight.effort !== undefined ? "effort" : isPi ? "state" : "done";
          break;
        }
        case "effort": {
          inFlight.effortApplied = true;
          inFlight.phase = isPi ? "state" : "done";
          break;
        }
        case "state": {
          if (record.state?.model !== undefined)
            inFlight.stateModel = `${record.state.model.provider}/${record.state.model.modelId}`;
          if (record.state?.thinkingLevel !== undefined)
            inFlight.stateEffort = record.state.thinkingLevel;
          // The readback answered: only the fields it confirmed are
          // reported. An answer that carried neither field is the same
          // failure class as an errored one, and a PARTIAL answer
          // confirms only what it carried: a field the op wrote but the
          // readback omitted is `unconfirmed`, never silently its
          // requested value (review rounds 3 H2, 4 J4).
          settleInFlight(readbackReceipt(inFlight));
          return;
        }
      }
      if (inFlight.phase === "done") {
        settleInFlight({ state: "applied", ...appliedFields(inFlight) });
        return;
      }
      writeStep(inFlight);
    },
    writeFailedAll() {
      // Queued ops never reached the wire, so nothing of theirs applied;
      // the in-flight one keeps whatever its acknowledgements confirmed
      // in its terminal receipt (review round 2, G2).
      for (const { token, id, resolve } of queued.splice(0)) {
        emit(id, token, { state: "rejected", reason: "write-failed" });
        resolve({ state: "rejected", reason: "write-failed" });
      }
      if (inFlight !== undefined)
        settleInFlight({ state: "rejected", reason: "write-failed", ...appliedFields(inFlight) });
    },
    closeAll() {
      for (const { token, id, resolve } of queued.splice(0)) {
        emit(id, token, { state: "rejected", reason: "closed" });
        resolve({ state: "rejected", reason: "closed" });
      }
      if (inFlight !== undefined)
        settleInFlight({ state: "rejected", reason: "closed", ...appliedFields(inFlight) });
    },
  };
};
