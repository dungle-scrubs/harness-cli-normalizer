/**
 * Opt-in stage trace for the Cursor overflow test (issue #388). Each mark
 * appends one complete JSON line to the trace file before it returns, so the
 * records written before a worker is killed stay on disk. Records survive
 * process death; they are not fsynced and make no power-loss promise.
 *
 * A record carries only timing metadata. CPU fields are the cumulative
 * process CPU time at the mark: coarse evidence of whether the process ran,
 * not per-stage attribution and not proof of I/O wait versus suspension.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type StagePhase = "start" | "end";
export type StageListener = (stage: string, phase: StagePhase) => void;

export interface StageRecord {
  readonly v: 1;
  readonly pid: number;
  readonly stage: string;
  readonly phase: StagePhase;
  readonly wallMs: number;
  readonly monoMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
}

export interface StageTrace {
  readonly path: string;
  readonly mark: StageListener;
}

/**
 * Creates a trace file under `root`, or returns undefined when `root` is
 * missing or empty. The caller passes the root explicitly; this never reads
 * the environment. IO failures propagate.
 */
export function createStageTrace(root: string | undefined): StageTrace | undefined {
  if (!root) return undefined;
  mkdirSync(root, { recursive: true });
  const path = join(root, `cursor-stage-${process.pid}-${randomUUID()}.jsonl`);
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  const mark: StageListener = (stage, phase) => {
    const cpu = process.cpuUsage();
    const record: StageRecord = {
      v: 1,
      pid: process.pid,
      stage,
      phase,
      wallMs: Date.now(),
      monoMs: performance.now(),
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
  return { path, mark };
}
