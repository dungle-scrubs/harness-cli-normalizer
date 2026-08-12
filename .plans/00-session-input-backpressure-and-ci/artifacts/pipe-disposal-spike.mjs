import { spawn } from "node:child_process";

const timeout = (label, ms) =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

const directChildSource = String.raw`
  const { spawn } = require("node:child_process");
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  descendant.unref();
  process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
  process.exit(7);
`;

const child = spawn(process.execPath, ["-e", directChildSource], {
  stdio: ["ignore", "pipe", "pipe"],
});

if (child.stdout === null || child.stderr === null) {
  throw new Error("spike child did not expose both output streams");
}

const exit = new Promise((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
});
const stdout = child.stdout[Symbol.asyncIterator]();
const stderr = child.stderr[Symbol.asyncIterator]();

const first = await Promise.race([stdout.next(), timeout("first stdout chunk", 1000)]);
if (first.done) throw new Error("direct child exited without reporting descendant PID");
const { descendantPid } = JSON.parse(Buffer.from(first.value).toString("utf8"));
const directExit = await Promise.race([exit, timeout("direct child exit", 1000)]);

const stdoutPending = stdout.next();
const stderrPending = stderr.next();
const before = await Promise.race([
  Promise.allSettled([stdoutPending, stderrPending]).then(() => "settled"),
  new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
]);

child.stdout.destroy();
child.stderr.destroy();
child.stdout.destroy();
child.stderr.destroy();

const after = await Promise.race([
  Promise.allSettled([stdoutPending, stderrPending]),
  timeout("output iterator settlement", 1000),
]);

try {
  process.kill(descendantPid, "SIGTERM");
} catch (error) {
  if (error?.code !== "ESRCH") throw error;
}

console.log(
  JSON.stringify({
    directExit,
    idempotentDestroy: child.stdout.destroyed && child.stderr.destroyed,
    iteratorStateBeforeDestroy: before,
    iteratorStatesAfterDestroy: after.map((result) => result.status),
    node: process.version,
    runtime: process.versions.bun === undefined ? "node" : "bun",
    runtimeVersion: process.versions.bun ?? process.versions.node,
  }),
);
