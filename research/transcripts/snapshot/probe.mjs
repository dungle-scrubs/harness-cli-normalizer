import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const directory = mkdtempSync(join(tmpdir(), "hcn-snapshot-proof-"));
const helper = process.argv[2] ?? join(directory, "clone");
const source = join(directory, "source");
const clone = join(directory, "snapshot");
const cSource = fileURLToPath(
  new URL("../../../src/execution/transcript/native/clone.c", import.meta.url),
);
const result = {
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  runtime: process.version,
  helperSourceSha256: createHash("sha256").update(readFileSync(cSource)).digest("hex"),
  checks: {},
};
let worker;
try {
  const build = process.argv[2]
    ? null
    : spawnSync("/usr/bin/cc", ["-Wall", "-Wextra", "-Werror", "-O2", cSource, "-o", helper], {
        encoding: "utf8",
        timeout: 5000,
      });
  if (build) assert.equal(build.status, 0, build.stderr);
  result.helperExecutableSha256 = createHash("sha256").update(readFileSync(helper)).digest("hex");
  const run = (from = source, to = clone) =>
    spawnSync(helper, [from, to], {
      encoding: "utf8",
      env: {},
      timeout: 5000,
    });
  writeFileSync(source, "synthetic before\n");
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const native = statSync(source, { bigint: true });
  assert.equal(first.stdout, "");
  assert.notEqual(statSync(clone).ino, Number(native.ino));
  writeFileSync(source, "synthetic after\n");
  assert.equal(readFileSync(clone, "utf8"), "synthetic before\n");
  result.checks.independentCloneAfterRewrite = true;
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(clone, "utf8"), "synthetic before\n");
  result.checks.existingDestinationPreserved = true;
  unlinkSync(clone);
  assert.notEqual(run(directory).status, 0);
  result.checks.directoryRejected = true;
  assert.notEqual(run(join(directory, "missing")).status, 0);
  result.checks.missingRejected = true;

  const state = new Int32Array(new SharedArrayBuffer(8));
  const length = 1024 * 1024;
  writeFileSync(source, Buffer.alloc(length, 65));
  worker = new Worker(
    `
    const {workerData}=require('node:worker_threads');
    const {openSync,writeSync,closeSync}=require('node:fs');
    const state=new Int32Array(workerData.state);
    const fd=openSync(workerData.source,'r+');
    const a=Buffer.alloc(workerData.length,65),b=Buffer.alloc(workerData.length,66);
    while(!Atomics.load(state,0)) {
      writeSync(fd,a,0,a.length,0);
      writeSync(fd,b,0,b.length,0);
      Atomics.add(state,1,1);
    }
    closeSync(fd);
  `,
    { eval: true, workerData: { source, length, state: state.buffer } },
  );
  const count = 256;
  for (let index = 0; index < count; index++) {
    const copied = run();
    assert.equal(copied.status, 0, copied.stderr);
    const bytes = readFileSync(clone);
    assert.equal(bytes.length, length);
    assert.ok(bytes.equals(Buffer.alloc(length, bytes[0])));
    assert.ok(bytes[0] === 65 || bytes[0] === 66);
    unlinkSync(clone);
  }
  Atomics.store(state, 0, 1);
  await worker.terminate();
  worker = undefined;
  assert.ok(Atomics.load(state, 1) > 0);
  result.checks.concurrentWholeFileWrites = {
    clones: count,
    bytesPerFile: length,
    completeWriterCycles: Atomics.load(state, 1),
    mixedClones: 0,
  };
} finally {
  if (worker) await worker.terminate();
  rmSync(directory, { recursive: true, force: true });
}
result.checks.temporaryDirectoryRemoved = true;
console.log(JSON.stringify(result, null, 2));
