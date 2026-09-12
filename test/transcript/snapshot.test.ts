import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";
import { snapshotTranscriptFiles } from "../../src/execution/transcript/snapshot.js";

test("a missing packaged helper is a consistency refusal, not a missing native source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcn-snapshot-missing-helper-"));
  try {
    const files = snapshotTranscriptFiles({
      cloneExecutable: join(directory, "missing-helper"),
      temporaryRoot: directory,
      deps: nodeRunnerDeps(),
    });
    await expect(files.snapshot("/synthetic/source")).rejects.toMatchObject({
      issue: "guarantee-unmet",
      requirement: "consistency",
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("a cleanup deadline preserves the earlier acquisition failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcn-snapshot-primary-"));
  const empty = async function* () {};
  try {
    const files = snapshotTranscriptFiles({
      cloneExecutable: "/synthetic/clone",
      temporaryRoot: directory,
      deps: {
        clock: {
          now: () => 0,
          clearTimeout() {},
          setTimeout(callback) {
            queueMicrotask(callback);
            return 1;
          },
        },
        signal() {},
        spawn: () => ({
          disposeOutput() {},
          exited: new Promise(() => {}),
          stdout: empty(),
          stderr: empty(),
        }),
      },
    });
    await expect(files.snapshot("/synthetic/source")).rejects.toMatchObject({
      issue: "native-read-failed",
      cleanupFailed: true,
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("interruption stops snapshot acquisition and removes its private directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcn-snapshot-interrupt-"));
  const abort = new AbortController();
  const signals: string[] = [];
  let finish: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const empty = async function* () {};
  try {
    const files = snapshotTranscriptFiles({
      cloneExecutable: "/synthetic/clone",
      temporaryRoot: directory,
      signal: abort.signal,
      deps: {
        clock: nodeRunnerDeps().clock,
        signal(_process, signal) {
          signals.push(signal);
          finish(null);
        },
        spawn() {
          queueMicrotask(() => abort.abort());
          return { disposeOutput() {}, exited, stdout: empty(), stderr: empty() };
        },
      },
    });
    await expect(files.snapshot("/synthetic/source")).rejects.toMatchObject({
      issue: "interrupted",
    });
    expect(signals).toEqual(["SIGKILL"]);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 1000);

test("a stalled snapshot helper is killed and its directory removed before failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcn-snapshot-deadline-"));
  const signals: string[] = [];
  let finish: (code: number | null) => void = () => {};
  const child = {
    disposeOutput() {},
    exited: new Promise<number | null>((resolve) => {
      finish = resolve;
    }),
    async *stderr() {},
    async *stdout() {},
  };
  try {
    const files = snapshotTranscriptFiles({
      cloneExecutable: "/synthetic/clone",
      temporaryRoot: directory,
      deps: {
        clock: {
          now: () => 0,
          clearTimeout() {},
          setTimeout(callback, ms) {
            if (ms === 5000) queueMicrotask(callback);
            return 1;
          },
        },
        signal(_process, signal) {
          signals.push(signal);
          finish(null);
        },
        spawn: () => ({ ...child, stdout: child.stdout(), stderr: child.stderr() }),
      },
    });
    await expect(files.snapshot("/synthetic/source")).rejects.toMatchObject({
      issue: "native-read-failed",
    });
    expect(signals).toEqual(["SIGKILL"]);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 1000);

test("filesystem snapshots survive native rewrites and remove private copies on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hcn-snapshot-test-"));
  try {
    const executable = join(directory, "clone");
    const native = fileURLToPath(
      new URL("../../src/execution/transcript/native/clone.c", import.meta.url),
    );
    const built = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", native, "-o", executable], {
      encoding: "utf8",
    });
    expect(built.status, built.stderr).toBe(0);
    const path = join(directory, "source.jsonl");
    const original = '{"synthetic":"before"}\n';
    await writeFile(path, original);
    const files = snapshotTranscriptFiles({
      cloneExecutable: executable,
      deps: nodeRunnerDeps(),
      temporaryRoot: directory,
    });
    const probePath = join(directory, "capability-probe");
    const probe = spawnSync(executable, [path, probePath], { encoding: "utf8" });
    if (probe.status !== 0) {
      expect(process.platform).toBe("linux");
      expect(probe.stderr).toMatch(/not supported|Invalid argument/);
      await expect(files.snapshot(path)).rejects.toMatchObject({ issue: "guarantee-unmet" });
      expect(await readFile(path, "utf8")).toBe(original);
      expect(
        (await readdir(directory)).filter((name) => name.startsWith("hcn-transcript-")),
      ).toHaveLength(0);
      return;
    }
    await rm(probePath);
    const snapshot = await files.snapshot(path);
    await writeFile(path, '{"synthetic":"after"}\n');
    const version = await snapshot.version();
    expect(new TextDecoder().decode(await snapshot.read(version.size))).toBe(original);
    expect(await readFile(path, "utf8")).toContain("after");
    expect(
      (await readdir(directory)).filter((name) => name.startsWith("hcn-transcript-")),
    ).toHaveLength(1);
    await snapshot.close();
    await snapshot.close();
    expect(
      (await readdir(directory)).filter((name) => name.startsWith("hcn-transcript-")),
    ).toHaveLength(0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
