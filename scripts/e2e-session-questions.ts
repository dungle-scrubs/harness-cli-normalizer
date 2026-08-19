/**
 * Issue #44 e2e scenarios: session-mode live question channel. A worker
 * asks mid-session, the answer flows back as the next send on the SAME
 * process, and the turn completes referencing it. Runs claude + pi only
 * (codex/muse have no sessionMode); driven through the `hcn session`
 * CLI with piped stdin - the interactive loop reads lines from stdin, so
 * a scripted pipe exercises the whole path including the answer menu.
 *
 * Steps are stdout-synchronized: `expect` is a pattern the accumulated
 * stdout must match BEFORE `line` is written, so the answer is never
 * raced ahead of the menu.
 */
import type { HarnessEvent } from "../src/execution/events.js";

export interface ScenarioResultLite {
  durationMs: number;
  exitCode: number | null;
  eventCounts: Record<string, number>;
  failures: string[];
}

export interface SessionStep {
  /** Write `line` only after accumulated stdout matches this. */
  readonly expect?: RegExp;
  readonly line?: string;
  /** Conditional step: first branch whose expect matches (from the step's
   * start position) supplies the line. Mutually exclusive with plain
   * expect/line. */
  readonly branch?: ReadonlyArray<{ readonly expect: RegExp; readonly line: string }>;
}

export type SpawnSession = (
  harness: string,
  argv: string[],
  steps: readonly SessionStep[],
  timeoutMs: number,
) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

const genuineDecisionTask = `you must write a file named deploy-target.txt into the current directory containing the environment this project deploys to. Two requirements are mutually exclusive and nothing in this directory says which applies: (a) the file must name the staging environment, or (b) it must name the production environment. The choice changes the file's contents and is not recoverable later without redoing the work. Decide whether to ask.`;

/** (1) ask -> pick option 2 via the menu -> completes referencing it.
 * Tolerates one malformed-ask turn (worker emitted a block that fails
 * JSON shape validation - surfaced as an error event per protocol) by
 * re-asking once; a valid ask then follows the normal path. */
export const sessionAskScenario = {
  name: "session-live-ask",
  run: async (
    spawnSession: SpawnSession,
    harness: string,
    mkdtemp: (p: string) => string,
  ): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const cwd = mkdtemp("/tmp/hcn-sess-ask-");
    const steps: SessionStep[] = [
      { line: genuineDecisionTask },
      // Turn 1 ends awaiting-input (valid ask; menu renders) -> answer 2.
      // Or it ends clean (malformed block - protocol surfaced an error -
      // or the model decided) -> re-ask once, insisting on a VALID block.
      {
        branch: [
          { expect: /answer › pick a number/, line: "2" },
          {
            expect: /○ clean/,
            line: "Your hcn-question block was rejected as malformed (it must be one JSON object with question, options, recommended). Ask again now with a valid block.",
          },
        ],
      },
      // Turn 2: menu -> answer 2; clean completion -> exit.
      {
        branch: [
          { expect: /answer › pick a number/, line: "2" },
          { expect: /○ clean/, line: "exit" },
        ],
      },
      // The final exit is unguarded: its positional window can start
      // AFTER the completion turn's `○ clean` has already scrolled past
      // (the previous branch matched at the menu, the whole completion
      // turn then rendered before this step began polling).
      { line: "exit" },
    ];
    const r = await spawnSession(harness, ["--cwd", cwd], steps, 240_000);
    if (r.exitCode !== 0) failures.push(`session exited ${r.exitCode}: ${r.stderr.slice(0, 300)}`);
    if (!/answer › pick a number/.test(r.stdout)) {
      failures.push(`no answer menu rendered: ${r.stdout.slice(-400)}`);
    }
    if (!/awaiting input/.test(r.stdout)) failures.push("no awaiting-input turn end rendered");
    // The final turn must reference the ANSWERED option (production -
    // option 2), proving the answer flowed back into the live session.
    const afterMenu = r.stdout.slice(r.stdout.indexOf("answer › pick a number") + 1);
    if (!/production/i.test(afterMenu)) {
      failures.push(`final turn does not reference the answered option: ${afterMenu.slice(-300)}`);
    }
    return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
  },
};

/** (2) false mode: no menu, assumption stated, no question flow. */
export const sessionOffScenario = {
  name: "session-live-off",
  run: async (
    spawnSession: SpawnSession,
    harness: string,
    mkdtemp: (p: string) => string,
  ): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const cwd = mkdtemp("/tmp/hcn-sess-off-");
    const r = await spawnSession(
      harness,
      ["--no-escalate-questions", "--cwd", cwd],
      [{ line: genuineDecisionTask }, { expect: /○ clean/, line: "exit" }],
      240_000,
    );
    if (r.exitCode !== 0) failures.push(`session exited ${r.exitCode}: ${r.stderr.slice(0, 300)}`);
    if (/answer › pick a number/.test(r.stdout)) failures.push("menu rendered in off mode");
    if (/awaiting input/.test(r.stdout)) failures.push("awaiting-input turn in off mode");
    if (!/assum|defensib|safer|decision|default|chose|picking|proceed/i.test(r.stdout)) {
      failures.push(`no stated decision/assumption: ${r.stdout.slice(0, 400)}`);
    }
    if (!/provenance: escalateQuestions = false \(arg\)/.test(r.stderr)) {
      failures.push(`arg provenance missing: ${r.stderr.slice(0, 200)}`);
    }
    return { durationMs: Date.now() - t0, exitCode: r.exitCode, eventCounts: {}, failures };
  },
};

/** Unused but kept for type stability with the main runner's imports. */
export type _HarnessEventRef = HarnessEvent;
