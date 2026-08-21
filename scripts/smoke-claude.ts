/**
 * M3.3 real-claude smoke: compatibility, not proof. Runs the execution
 * layer against the INSTALLED claude CLI - headless single-turn with token
 * deltas, session multi-turn, error propagation, kill (abandonment) +
 * resume. On-demand only (`bun run smoke:claude`), never part of the
 * deterministic suite. Evidence lands in .smoke/last-run.json.
 *
 * A real limit wall cannot be forced on demand; limit propagation is
 * covered by the deterministic wall-routing tests, and this script records
 * that explicitly rather than pretending.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import { openSession } from "../src/execution/open-session.js";
import { streamTurn } from "../src/execution/stream-turn.js";
import { claudeCode } from "../src/knowledge/claude-code.js";

// D-025: the child session must not inherit Herdr's environment.
delete process.env.HERDR_ENV;

const SCENARIO_TIMEOUT_MS = 180_000;
const results: Array<{ scenario: string; pass: boolean; detail: string }> = [];
const boundaryLog: Record<string, unknown>[] = [];
const deps = () => nodeRunnerDeps({ log: (e) => boundaryLog.push(e) });

const withTimeout = async <T>(name: string, work: Promise<T>): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${name} exceeded ${SCENARIO_TIMEOUT_MS}ms`)),
      SCENARIO_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(handle);
  }
};

const collect = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};

const record = (scenario: string, pass: boolean, detail: string): void => {
  results.push({ scenario, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${scenario}: ${detail}`);
};

const textOf = (events: HarnessEvent[]): string =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
    .map((e) => e.text)
    .join(" ");

// Scenario 1: headless single-turn, token deltas observed.
try {
  const events = await withTimeout(
    "single-turn",
    collect(
      streamTurn(
        claudeCode,
        { prompt: "Reply with exactly the word: alpha", model: "sonnet" },
        deps(),
      ),
    ),
  );
  const tokens = events.filter((e) => e.kind === "token").length;
  const identities = events.filter((e) => e.kind === "identity").length;
  const done = events.at(-1);
  const pass = tokens > 0 && identities === 1 && done?.kind === "done" && done.cause === "clean";
  record(
    "headless single-turn",
    pass,
    `tokens=${tokens} identities=${identities} done=${JSON.stringify(done)}`,
  );
} catch (cause) {
  record("headless single-turn", false, String(cause));
}

// Scenario 2 + 4: session multi-turn, then kill (abandon) + resume.
const sessionId = crypto.randomUUID();
try {
  const session = openSession(claudeCode, { sessionId }, deps());
  const turnsIter = session.turns[Symbol.asyncIterator]();

  session.send("Remember the codeword: pomegranate. Reply with only: OK");
  const turn1 = (await withTimeout("session turn1 start", turnsIter.next()))
    .value as AsyncIterable<HarnessEvent>;
  const events1 = await withTimeout("session turn1", collect(turn1));

  session.send("Reply with only the codeword I gave you.");
  const turn2 = (await withTimeout("session turn2 start", turnsIter.next()))
    .value as AsyncIterable<HarnessEvent>;
  const events2 = await withTimeout("session turn2", collect(turn2));
  await withTimeout("session close", session.close());

  const identities = [...events1, ...events2].filter((e) => e.kind === "identity");
  const pass =
    events1.at(-1)?.kind === "done" &&
    events2.at(-1)?.kind === "done" &&
    identities.length === 1 &&
    textOf(events2).toLowerCase().includes("pomegranate");
  record(
    "session multi-turn",
    pass,
    `turn1=${events1.at(-1)?.kind} turn2 text="${textOf(events2).slice(0, 60)}" identities=${identities.length}`,
  );
} catch (cause) {
  record("session multi-turn", false, String(cause));
}

// Scenario 3: error propagation - a spawn that cannot start.
try {
  const broken = { ...claudeCode, bin: "definitely-not-a-real-binary-xyz" };
  const events = await withTimeout(
    "spawn-failure",
    collect(streamTurn(broken, { prompt: "hi" }, deps())),
  );
  const done = events.at(-1) as unknown as
    | {
        kind: string;
        exitCode: number | null;
        failure?: { class: string; nativeExitCode?: number };
      }
    | undefined;
  const pass =
    done?.kind === "done" &&
    done.exitCode === null &&
    done.failure?.class === "native" &&
    done.failure?.nativeExitCode === 127;
  record("error propagation (spawn failure)", pass, JSON.stringify(done));
} catch (cause) {
  record("error propagation (spawn failure)", false, String(cause));
}

// Scenario 4: kill mid-turn (consumer abandonment) then resume - continuity.
try {
  let sawTokens = 0;
  const killed = streamTurn(
    claudeCode,
    { resume: sessionId, prompt: "Count slowly from 1 to 40, one number per line." },
    deps(),
  );
  await withTimeout(
    "abandon mid-turn",
    (async () => {
      for await (const event of killed) {
        if (event.kind === "token" && ++sawTokens >= 3) break; // walk away mid-stream
      }
    })(),
  );
  const events = await withTimeout(
    "resume after kill",
    collect(
      streamTurn(
        claudeCode,
        { resume: sessionId, prompt: "Reply with only the codeword I gave you earlier." },
        deps(),
      ),
    ),
  );
  const done = events.at(-1);
  const pass =
    done?.kind === "done" &&
    done.cause === "clean" &&
    textOf(events).toLowerCase().includes("pomegranate");
  record(
    "kill + resume continuity",
    pass,
    `abandoned after ${sawTokens} tokens; resumed text="${textOf(events).slice(0, 60)}" done=${JSON.stringify(done)}`,
  );
} catch (cause) {
  record("kill + resume continuity", false, String(cause));
}

record(
  "limit propagation",
  true,
  "not forceable on demand; covered by deterministic wall-routing tests (limits.test.ts, stream-turn stderr suite)",
);

mkdirSync(".smoke", { recursive: true });
writeFileSync(
  ".smoke/last-run.json",
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      claudeVersion: process.env.SMOKE_CLAUDE_VERSION ?? "installed",
      sessionId,
      results,
      boundaryEvents: boundaryLog.length,
    },
    null,
    2,
  ),
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} scenarios green`);
if (failed.length > 0) process.exit(1);
