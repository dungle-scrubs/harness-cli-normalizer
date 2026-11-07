/**
 * Issue #457: `--setting-sources` through the built CLI - the run and
 * session spawns carry the selection, the default stays `project` on
 * sessions and absent on runs, other harnesses refuse with exit 2, and
 * the inspect previews agree with the spawns by construction.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { cli, runCliFixture, runtimes } from "./session-fixture.js";

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly argv: string[] | null;
  readonly spawned: boolean;
}

const runCli = (
  runtime: string,
  args: readonly string[],
  options: { readonly input?: string } = {},
): RunResult => runCliFixture(runtime, args, { input: options.input });

test.each(runtimes)("%s: a claude run carries the explicit selection", (runtime) => {
  const run = runCli(runtime, [
    "run",
    "claude",
    "--setting-sources",
    "user,project,local",
    "--prompt",
    "hi",
    "--json",
  ]);
  expect(run.status).toBe(0);
  expect(run.spawned).toBe(true);
  const at = run.argv?.indexOf("--setting-sources") ?? -1;
  expect(at).toBeGreaterThan(-1);
  expect(run.argv?.[at + 1]).toBe("user,project,local");
});

test.each(runtimes)("%s: a bare claude run stays unchanged", (runtime) => {
  const run = runCli(runtime, ["run", "claude", "--prompt", "hi", "--json"]);
  expect(run.status).toBe(0);
  expect(run.argv).not.toContain("--setting-sources");
});

test.each(runtimes)(
  "%s: a claude session defaults to project and replaces it on selection",
  (runtime) => {
    const bare = runCli(runtime, ["session", "claude", "--json"]);
    expect(bare.status).toBe(0);
    const at = bare.argv?.indexOf("--setting-sources") ?? -1;
    expect(at).toBeGreaterThan(-1);
    expect(bare.argv?.[at + 1]).toBe("project");
    const wide = runCli(runtime, [
      "session",
      "claude",
      "--json",
      "--setting-sources",
      "user,project,local",
    ]);
    expect(wide.status).toBe(0);
    const at2 = wide.argv?.indexOf("--setting-sources") ?? -1;
    expect(wide.argv?.[at2 + 1]).toBe("user,project,local");
    expect(wide.argv?.filter((token) => token === "--setting-sources")).toHaveLength(1);
  },
);

test.each(runtimes)("%s: other harnesses refuse the flag with exit 2", (runtime) => {
  const runRefusal = runCli(runtime, [
    "run",
    "pi",
    "--setting-sources",
    "user",
    "--prompt",
    "hi",
    "--json",
  ]);
  expect(runRefusal.status).toBe(2);
  expect(runRefusal.spawned).toBe(false);
  expect(runRefusal.stderr).toContain("no setting-sources flag");
  const sessionRefusal = runCli(runtime, ["session", "pi", "--json", "--setting-sources", "user"]);
  expect(sessionRefusal.status).toBe(2);
  expect(sessionRefusal.spawned).toBe(false);
});

test.each(runtimes)("%s: repeats and unknown values refuse with exit 2", (runtime) => {
  for (const value of ["user,user", "nope", ","]) {
    const run = runCli(runtime, ["session", "claude", "--json", "--setting-sources", value]);
    expect(run.status).toBe(2);
    expect(run.spawned).toBe(false);
    // The specific invalid-value diagnostic, so the refusal is proven to
    // come from this feature's validation: at base the flag is unknown
    // and refuses with a different message (review round 2, G9).
    expect(run.stderr).toContain('invalid value for option "settingSources" on claude');
  }
});

test.each(runtimes)("%s: the inspect previews match the spawns", (runtime) => {
  const preview = spawnSync(
    runtime,
    [
      cli,
      "inspect",
      "claude",
      "--argv",
      "--mode",
      "headless-session",
      "--setting-sources",
      "user,local",
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(preview.status).toBe(0);
  expect(JSON.parse(String(preview.stdout.trim())) as string[]).toEqual([
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources",
    "user,local",
    "--session-id",
    "00000000-0000-4000-8000-000000000000",
  ]);
});
