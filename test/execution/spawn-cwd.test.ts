import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";

// opencode 1.19.5 resolves its project directory from `process.env.PWD`
// before `process.cwd()`, so a child spawned with a cwd but an inherited PWD
// works in the parent's directory. The adapter keeps PWD in step with cwd,
// as a shell does.
const printPwd =
  "process.stdout.write(JSON.stringify({ pwd: process.env.PWD ?? null, cwd: process.cwd() }))";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function readChild(env?: Readonly<Record<string, string>>): Promise<{
  readonly dir: string;
  readonly report: { readonly pwd: string | null; readonly cwd: string };
}> {
  const dir = mkdtempSync(join(tmpdir(), "hcn-spawn-cwd-"));
  dirs.push(dir);
  const child = nodeRunnerDeps().spawn([process.execPath, "-e", printPwd], {
    stdin: "close",
    cwd: dir,
    ...(env !== undefined ? { env } : {}),
  });
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk as Uint8Array));
  await child.exited;
  return { dir, report: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

test("real adapter sets PWD to the spawn cwd instead of inheriting the parent's", async () => {
  const { dir, report } = await readChild();
  expect(report.pwd).toBe(resolve(dir));
});

test("an explicit PWD override still wins over the spawn cwd", async () => {
  const { report } = await readChild({ PWD: "/caller/chosen" });
  expect(report.pwd).toBe("/caller/chosen");
});
