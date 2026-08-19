/**
 * E2E scenarios for issue #41 (question escalation), appended to the
 * phase runner by scripts/e2e.ts. Kept in a separate module so the
 * scenario table stays readable; the shapes match ScenarioResult from
 * the main runner exactly.
 *
 *  1. question-ask       - genuine decision -> question event fields ->
 *                          exit 0, done awaiting-input
 *  2. question-off       - false mode -> assumption stated, no block, no
 *                          question event, clean
 *  3. question-precedence- project false vs user true vs arg override
 *  4. question-roundtrip - ask -> resume with the answer -> completion
 *                          referencing it; id continuity per harness
 */
import type { HarnessEvent } from "../src/execution/events.js";

export interface ScenarioResultLite {
  durationMs: number;
  exitCode: number | null;
  eventCounts: Record<string, number>;
  failures: string[];
}

/** The runner's CLI seam: spawn `hcn run`, collect NDJSON events + exit. */
export type RunCli = (
  args: string[],
  env: Record<string, string>,
  cwd?: string,
) => Promise<{
  exitCode: number | null;
  events: HarnessEvent[];
  stderr: string;
  timedOut: boolean;
}>;

const genuineDecisionTask = `you must write a file named deploy-target.txt into the current directory containing the environment this project deploys to. Two requirements are mutually exclusive and nothing in this directory says which applies: (a) the file must name the staging environment, or (b) it must name the production environment. The choice changes the file's contents and is not recoverable later without redoing the work. Decide whether to ask.`;

const messagesOf = (events: HarnessEvent[]): string =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
    .map((e) => e.text)
    .join("");

const doneOf = (events: HarnessEvent[]) =>
  events.find((e): e is Extract<HarnessEvent, { kind: "done" }> => e.kind === "done");

const questionOf = (events: HarnessEvent[]) =>
  events.find((e): e is Extract<HarnessEvent, { kind: "question" }> => e.kind === "question");

/** (1) true mode (default): the genuine-decision prompt makes the worker
 * ask. Asserts the question event's FIELDS (structured-first), exit 0,
 * and done cause awaiting-input - asking is a successful turn. */
export const questionAskScenario = {
  name: "question-ask",
  run: async (runCli: RunCli, harness: string): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const r = await runCli([harness, "--json", "--prompt", genuineDecisionTask], {});
    const done = doneOf(r.events);
    const question = questionOf(r.events);

    if (r.timedOut) failures.push("timed out");
    if (!question) {
      failures.push(
        `no question event (done=${done?.cause ?? "none"}): ${messagesOf(r.events).slice(0, 200)}`,
      );
    } else {
      if (question.question.trim().length < 10) failures.push("question field too thin");
      if (question.options.length < 2) failures.push(`options: ${question.options.join(",")}`);
      if (question.recommended === undefined) failures.push("recommended missing");
      else if (!question.options.includes(question.recommended)) {
        failures.push(`recommended "${question.recommended}" not in options`);
      }
    }
    if (!done) failures.push("no done event");
    else {
      if (done.cause !== "awaiting-input") failures.push(`done.cause=${done.cause}`);
      if (done.exitCode !== 0) failures.push(`done.exitCode=${done.exitCode}, expected 0`);
    }
    if (r.exitCode !== 0) failures.push(`process exit ${r.exitCode}, expected 0 (asking succeeds)`);
    return {
      durationMs: Date.now() - t0,
      exitCode: r.exitCode,
      eventCounts: {},
      failures,
    };
  },
};

/** (2) false mode: the same genuine-decision task, but the worker is
 * instructed never to ask - it states the assumption and continues. No
 * block, no question event, clean done. The file landing in the cwd is
 * the "continued" evidence. */
export const questionOffScenario = {
  name: "question-off",
  run: async (
    runCli: RunCli,
    harness: string,
    mkdtemp: (p: string) => string,
  ): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const cwd = mkdtemp("/tmp/hcn-q-off-");
    const r = await runCli(
      [harness, "--json", "--no-escalate-questions", "--cwd", cwd, "--prompt", genuineDecisionTask],
      {},
      cwd,
    );
    const done = doneOf(r.events);
    if (questionOf(r.events)) failures.push("question event fired in no-escalate mode");
    if (messagesOf(r.events).includes("hcn-question")) failures.push("block present in output");
    if (!done || done.cause !== "clean") failures.push(`done.cause=${done?.cause}, expected clean`);
    // The instruction says "state the assumption" - models word it
    // differently (assumption, defensible reading, safer default,
    // decision). Any decision-stating marker satisfies the contract;
    // the behavioral guarantees above are the hard assertions.
    if (
      !/assum|defensib|safer|decision|default|chose|choosing|picking|proceed/i.test(
        messagesOf(r.events),
      )
    ) {
      failures.push(`no stated decision/assumption: ${messagesOf(r.events).slice(0, 150)}`);
    }
    if (!/provenance: escalateQuestions = false \(arg\)/.test(r.stderr)) {
      failures.push(`arg provenance missing: ${r.stderr.slice(0, 200)}`);
    }
    return {
      durationMs: Date.now() - t0,
      exitCode: r.exitCode,
      eventCounts: {},
      failures,
    };
  },
};

/** (3) tier precedence: project false beats user true; the arg wins over
 * both; bare resolves the default. Asserted on the provenance line - the
 * mode itself is asserted behaviorally in the other two scenarios. */
export const questionPrecedenceScenario = {
  name: "question-precedence",
  run: async (
    runCli: RunCli,
    harness: string,
    mkdtemp: (p: string) => string,
    fs: {
      writeFileSync: (p: string, d: string) => void;
      mkdirSync: (p: string, o: { recursive: boolean }) => void;
    },
    gitInit: (cwd: string) => void,
  ): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const userDir = mkdtemp("/tmp/hcn-q-user-");
    fs.writeFileSync(`${userDir}/config.json`, '{"version":1,"escalateQuestions":true}');
    const repo = mkdtemp("/tmp/hcn-q-repo-");
    gitInit(repo);
    fs.mkdirSync(`${repo}/.hcn`, { recursive: true });
    fs.writeFileSync(`${repo}/.hcn/config.json`, '{"version":1,"escalateQuestions":false}');

    const env = { HCN_CONFIG_DIR: userDir };
    // project false beats user true
    const proj = await runCli([harness, "--json", "--prompt", "Reply OK only."], env, repo);
    if (!/provenance: escalateQuestions = false \(project-config\)/.test(proj.stderr)) {
      failures.push(`project tier not winning: ${proj.stderr.slice(0, 250)}`);
    }
    // arg wins over both
    const arg = await runCli(
      [harness, "--json", "--escalate-questions", "--prompt", "Reply OK only."],
      env,
      repo,
    );
    if (!/provenance: escalateQuestions = true \(arg\)/.test(arg.stderr)) {
      failures.push(`arg tier not winning: ${arg.stderr.slice(0, 250)}`);
    }
    // user tier when no project statement
    const noProj = mkdtemp("/tmp/hcn-q-noproj-");
    gitInit(noProj);
    const user = await runCli([harness, "--json", "--prompt", "Reply OK only."], env, noProj);
    if (!/provenance: escalateQuestions = true \(user-config\)/.test(user.stderr)) {
      failures.push(`user tier not applied: ${user.stderr.slice(0, 250)}`);
    }
    // default when nothing states it
    const emptyUser = mkdtemp("/tmp/hcn-q-empty-");
    const dflt = await runCli(
      [harness, "--json", "--prompt", "Reply OK only."],
      { HCN_CONFIG_DIR: emptyUser },
      noProj,
    );
    if (!/provenance: escalateQuestions = true \(default\)/.test(dflt.stderr)) {
      failures.push(`default not applied: ${dflt.stderr.slice(0, 250)}`);
    }
    return {
      durationMs: Date.now() - t0,
      exitCode: proj.exitCode,
      eventCounts: {},
      failures,
    };
  },
};

/** (4) the full round trip: ask -> question event -> resume with the
 * chosen answer -> the worker completes referencing the answer. Id
 * continuity per harness: the identity event carries the id the caller
 * resumes with (claude stable, pi/muse caller-assigned, codex minted). */
export const questionRoundtripScenario = {
  name: "question-roundtrip",
  run: async (
    runCli: RunCli,
    harness: string,
    mkdtemp: (p: string) => string,
  ): Promise<ScenarioResultLite> => {
    const failures: string[] = [];
    const t0 = Date.now();
    const cwd = mkdtemp("/tmp/hcn-q-rt-");

    // Turn 1: the ask.
    const ask = await runCli(
      [harness, "--json", "--cwd", cwd, "--prompt", genuineDecisionTask],
      {},
      cwd,
    );
    const question = questionOf(ask.events);
    if (!question) {
      return {
        durationMs: Date.now() - t0,
        exitCode: ask.exitCode,
        eventCounts: {},
        failures: [`turn 1 asked no question: ${messagesOf(ask.events).slice(0, 200)}`],
      };
    }
    const done1 = doneOf(ask.events);
    if (done1?.cause !== "awaiting-input" || ask.exitCode !== 0) {
      failures.push(`turn 1 not awaiting-input/0: ${done1?.cause}/${ask.exitCode}`);
    }
    const identity = ask.events.find(
      (e): e is Extract<HarnessEvent, { kind: "identity" }> => e.kind === "identity",
    );
    if (!identity) failures.push("turn 1 announced no identity (resume id unknown)");
    const sessionId = identity?.sessionId;

    // The answer: whichever option the worker did NOT recommend (proves
    // the content flowed, not a lucky default).
    const answer = question.recommended === "staging" ? "production" : "staging";

    // Turn 2: resume with the answer.
    if (sessionId === undefined) {
      failures.push("cannot resume without a session id");
      return { durationMs: Date.now() - t0, exitCode: ask.exitCode, eventCounts: {}, failures };
    }
    const resume = await runCli(
      [
        harness,
        "--json",
        "--resume",
        sessionId,
        "--cwd",
        cwd,
        "--prompt",
        `The user answered: ${answer}. Complete the task accordingly.`,
      ],
      {},
      cwd,
    );
    const done2 = doneOf(resume.events);
    if (!done2 || done2.cause !== "clean")
      failures.push(`turn 2 cause=${done2?.cause}, expected clean`);
    if (questionOf(resume.events)) failures.push("turn 2 asked again (should complete, not ask)");
    const finalText = messagesOf(resume.events);
    if (!finalText.toLowerCase().includes(answer)) {
      failures.push(`turn 2 does not reference the answer "${answer}": ${finalText.slice(0, 200)}`);
    }
    // Id continuity: the resumed turn re-announces the SAME id on the
    // id-stable harnesses (claude/pi/muse). Codex thread continuity is
    // the resume mechanism itself; its resumed turn may re-announce the
    // thread id (same id) - accept both announcement and none, since the
    // behavioral reference above already proves the thread continued.
    if (harness !== "codex") {
      const identity2 = resume.events.find(
        (e): e is Extract<HarnessEvent, { kind: "identity" }> => e.kind === "identity",
      );
      if (identity2 && identity2.sessionId !== sessionId) {
        failures.push(`resumed id rotated: ${identity2.sessionId} != ${sessionId}`);
      }
    }
    return {
      durationMs: Date.now() - t0,
      exitCode: resume.exitCode,
      eventCounts: {},
      failures,
    };
  },
};
