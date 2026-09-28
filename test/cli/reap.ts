/**
 * Shared teardown for tests that spawn children into sandbox directories
 * (observer.test.ts, observer-run.test.ts). A failed assertion before
 * the test's own SIGTERM or end() can leave a stub process running; a
 * cleanup that only polls for exit would then either hang or delete the
 * sandbox under a live child. This helper terminates and reaps every
 * recorded pid FIRST - SIGTERM, up to 2 s, then SIGKILL, then a bounded
 * wait - and deletes fixture directories only after every pid is
 * confirmed gone, each under its named prefix, checked before deletion
 * (never a parent, TMPDIR, HOME, or any path computed with '..').
 */
import { rmSync } from "node:fs";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** For each recorded pid still alive: SIGTERM, wait up to 2 s, SIGKILL,
 * then wait until it is gone. Every pid is attempted even when an
 * earlier one survives; the promise rejects only after all attempts,
 * naming the survivors, so the caller keeps its fixture directories for
 * diagnosis instead of deleting them under a live child. */
export const terminateAndReap = async (pids: readonly number[], label: string): Promise<void> => {
  const survivors: number[] = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Exited between the liveness check and the signal.
      continue;
    }
    if (await waitGone(pid, 2000)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
    if (await waitGone(pid, 5000)) continue;
    survivors.push(pid);
  }
  if (survivors.length > 0) {
    throw new Error(
      `${label}: pid(s) ${survivors.join(", ")} still alive after SIGTERM and SIGKILL`,
    );
  }
};

/** terminateAndReap, then delete each directory under its checked
 * prefix. Directory deletion happens only after every pid is confirmed
 * gone; a rejected reap throws before any deletion, so the directories
 * survive for the operator to diagnose. */
export const cleanupSandbox = async (options: {
  readonly pids: readonly number[];
  readonly dirs: readonly string[];
  readonly prefix: string;
  readonly label: string;
}): Promise<void> => {
  await terminateAndReap(options.pids, options.label);
  for (const dir of options.dirs) {
    if (!dir.startsWith(options.prefix)) {
      throw new Error(`refusing to delete ${dir}: not under ${options.prefix}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
};
