/**
 * Issue #394: built-CLI denial-count proof paths for cursor and
 * antigravity - the two harnesses the #387 execution-boundary matrix
 * protects. The #387 matrix drives streamTurn directly; these controls
 * drive the built dist/cli.js end to end over synthetic native
 * executables on PATH (no real harness, no provider, no network):
 * the positive case proves done.denialCount reaches the NDJSON stream
 * and the human renderer's [denials: N] marker, the absent case proves
 * zero stays omitted on both surfaces, and the paired comparison proves
 * the count is advisory - the native task failure and its failure event
 * are identical with and without denials.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cliFixtureTmpdir } from "./fixture-tmpdir.js";
import { ensureDist } from "./stub-dist.js";

type Event = Record<string, unknown> & { kind: string };

/** One stub script: print the given NDJSON records, exit 0. The records
 * mirror the shapes the #387 matrix decodes
 * (test/execution/denial-counts.test.ts): an ordinary native tool error
 * that must NOT count, N repeated denial observations that must each
 * count (no dedup), and a terminal error that makes the native task fail
 * while denials stay advisory. The native exit is a success, so any
 * failure verdict comes from the decoded terminal error alone. */
const stubScript = (lines: readonly string[]): string =>
  [
    `#!${process.execPath}`,
    ...lines.map((line) => `console.log(${JSON.stringify(line)});`),
    "process.exit(0);",
    "",
  ].join("\n");

const cursorRecords = (denials: number) => [
  JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "ordinary-error",
    tool_call: {
      shellToolCall: { result: { error: { message: "command exited with status 3" } } },
    },
  }),
  ...Array.from({ length: denials }, () =>
    JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "same-call",
      tool_call: { shellToolCall: { result: { rejected: { reason: "needs approval" } } } },
    }),
  ),
  JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
];

const antigravityRecords = (denials: number) => [
  JSON.stringify({
    event: "init",
    conversation_id: "11111111-2222-4333-8444-555555555555",
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_type: "tool",
      step_id: "ordinary-error",
      state: "ERROR",
      tool_info: {
        name: "run_command",
        error: { type: "CommandError", message: "command exited with status 3" },
      },
    },
  }),
  ...Array.from({ length: denials }, () =>
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_type: "tool",
        step_id: "same-step",
        state: "ERROR",
        tool_info: {
          name: "run_command",
          error: { type: "PermissionDenied", message: "user denied permission to run command" },
        },
      },
    }),
  ),
  JSON.stringify({
    event: "result",
    result: { status: "ERROR", error: "invalid model selection" },
  }),
];

const cases = [
  { harness: "cursor", bin: "agent", records: cursorRecords },
  { harness: "antigravity", bin: "agy", records: antigravityRecords },
] as const;

/** One built-CLI run against a synthetic native executable on PATH. */
const runBuiltCli = (
  harness: string,
  bin: string,
  records: (denials: number) => string[],
  denials: number,
  mode: "json" | "human",
): { stdout: string; stderr: string; status: number | null } => {
  const cli = ensureDist();
  const dir = mkdtempSync(join(cliFixtureTmpdir(), "hcn-denial-counts-cli-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, bin), stubScript(records(denials)), { mode: 0o755 });
    const env: Record<string, string | undefined> = {
      ...process.env,
      // Keep the operator's own hcn configuration out of the run.
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      HCN_CONFIG_DIR: join(dir, "hcn-config"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete env.HCN_OBSERVER;
    delete env.HCN_INVOCATION_ID;
    const args = [cli, "run", harness, "probe prompt", "--questions", "none"];
    if (mode === "json") args.push("--json");
    const result = spawnSync(process.execPath, args, {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const eventsOf = (stdout: string): Event[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Event);

/** The done-line fragments as the renderer emits them: the cause mark is
 * color-wrapped, so the exact expected fragments carry the escape codes
 * (string escapes, which the renderer itself uses). */
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const doneLineWithoutCount = `○ failed${RESET} (exit 0)`;
const doneLineWithCount = `○ failed${RESET} (exit 0)${YELLOW} [denials: 2]${RESET} task:`;

for (const { harness, bin, records } of cases) {
  describe(`${harness}: built-CLI denial counts (synthetic native executable)`, () => {
    test("json: repeated denials count on done while the native task failure stays the verdict", () => {
      const absent = runBuiltCli(harness, bin, records, 0, "json");
      const positive = runBuiltCli(harness, bin, records, 2, "json");

      // Absent control: ordinary errors never count; zero stays omitted.
      const absentEvents = eventsOf(absent.stdout);
      expect(absentEvents.filter((e) => e.kind === "error" && e.denial !== undefined)).toEqual([]);
      const absentDone = absentEvents.at(-1);
      expect(absentDone).toMatchObject({
        kind: "done",
        exitCode: 0,
        cause: "failed",
        failure: { class: "task", retryable: false },
      });
      expect(absentDone).not.toHaveProperty("denialCount");
      expect(absent.status).toBe(1);

      // Positive control: each repeated denial observation counts - no
      // dedup - and the count rides the same done, changing nothing else.
      const positiveEvents = eventsOf(positive.stdout);
      expect(
        positiveEvents.filter((e) => e.kind === "error" && e.denial !== undefined),
      ).toHaveLength(2);
      const positiveDone = positiveEvents.at(-1);
      expect(positiveDone).toEqual({ ...absentDone, denialCount: 2 });
      expect(positive.status).toBe(1);

      // Advisory: the failure events are identical with and without denials.
      expect(positiveEvents.filter((e) => e.kind === "failure")).toEqual(
        absentEvents.filter((e) => e.kind === "failure"),
      );
    });

    test("human: [denials: N] renders only when denials were observed", () => {
      const absent = runBuiltCli(harness, bin, records, 0, "human");
      expect(absent.status).toBe(1);
      expect(absent.stdout).toContain(doneLineWithoutCount);
      expect(absent.stdout).not.toContain("[denials:");

      const positive = runBuiltCli(harness, bin, records, 2, "human");
      expect(positive.status).toBe(1);
      // The marker rides the done line after the exit and before the task
      // failure tail, exactly where the renderer puts it.
      expect(positive.stdout).toContain(doneLineWithCount);
    });
  });
}
