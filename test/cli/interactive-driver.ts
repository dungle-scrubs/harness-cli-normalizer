/** Isolated Node caller for the public extra-fd protocol. Bun 1.3.14's
 * child_process adapter can close a reused extra fd when an earlier child is
 * collected. HCN still runs under the requested runtime; no protocol assertion
 * or terminal channel is bypassed by this caller. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";

interface DriverRequest {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>> | undefined;
  readonly executable: string;
}

async function readPipe(pipe: unknown): Promise<string> {
  if (!(pipe instanceof Readable)) throw new Error("Missing caller pipe");
  let text = "";
  for await (const chunk of pipe) text += String(chunk);
  return text;
}

const request = JSON.parse(process.argv[2] ?? "null") as DriverRequest;
const child = spawn(request.executable, request.args, {
  env: request.environment,
  killSignal: "SIGKILL",
  stdio: ["pipe", "pipe", "pipe", "pipe"],
  timeout: 4000,
});
const pipe = child.stdio[3];
if (!(pipe instanceof Readable)) throw new Error("Missing control pipe");
let observed = "";
let finished = false;
pipe.on("data", (chunk) => {
  observed += String(chunk);
  if (!finished && observed.includes('"kind":"started"')) {
    finished = true;
    child.stdin?.end("finish\n");
  }
});
const [exit, stdout, stderr, control] = await Promise.all([
  once(child, "close"),
  readPipe(child.stdout),
  readPipe(child.stderr),
  readPipe(pipe),
]);
process.stdout.write(JSON.stringify({ control, exitCode: exit[0], stderr, stdout }));
