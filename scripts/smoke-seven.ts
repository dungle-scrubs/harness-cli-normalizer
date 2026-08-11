/**
 * The seven-scenario real-harness compatibility smoke (M7.2, runner scope).
 * Runs each applicable scenario against every installed harness and prints
 * a matrix. On-demand, nondeterministic, never in the deterministic suite.
 * Evidence -> .smoke/seven.json.
 *
 * PLAN.md's "original seven" includes protocol-level scenarios (interactive
 * single-turn, path handoff, mid-flight exactly-once handoff) that need the
 * lucid-v2 substrate, which does not exist yet - those are marked n/a at
 * the runner level. The runner-testable seven:
 *   1 single-turn        2 streaming-fidelity   3 tool-use
 *   4 session-continuity 5 resume-continuity    6 kill-and-resume
 *   7 error-propagation
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import { openSession } from "../src/execution/open-session.js";
import { streamTurn, type TurnRunOptions } from "../src/execution/stream-turn.js";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";

delete process.env.HERDR_ENV;

const HARNESSES: HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];
const cwd = process.cwd();
// pi is pinned to the free local model; the others use their defaults.
const modelFor = (h: HarnessDescriptor): string | undefined =>
  h.name === "pi" ? "qwen3.6-27b" : h.name === "claude" ? "sonnet" : undefined;

type Status = "pass" | "fail" | "skip";
interface Cell {
  status: Status;
  detail: string;
}
const results: Record<string, Record<string, Cell>> = {};
const record = (harness: string, scenario: string, cell: Cell): void => {
  if (results[harness] === undefined) results[harness] = {};
  (results[harness] as Record<string, Cell>)[scenario] = cell;
};

const SCENARIO_TIMEOUT_MS = 240_000;

/** Fail a scenario rather than let a hung harness hang the whole matrix.
 * (The underlying turn finishes on its own; full cancellation is not wired
 * for an on-demand smoke.) */
const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`scenario exceeded ${SCENARIO_TIMEOUT_MS}ms`)),
        SCENARIO_TIMEOUT_MS,
      ),
    ),
  ]);

const collect = async (turn: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of turn) out.push(e);
  return out;
};
const textOf = (events: HarnessEvent[]): string =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
    .map((e) => e.text)
    .join(" ");
const idOf = (events: HarnessEvent[]): string | null => {
  const i = events.find((e) => e.kind === "identity");
  return i?.kind === "identity" ? i.sessionId : null;
};
const doneOf = (events: HarnessEvent[]): string | null => {
  const d = events.at(-1);
  return d?.kind === "done" ? d.cause : null;
};
const opts = (h: HarnessDescriptor, extra: Partial<TurnRunOptions> = {}): TurnRunOptions => ({
  prompt: extra.prompt ?? "Reply with only: alpha",
  cwd,
  ...(modelFor(h) !== undefined ? { model: modelFor(h) } : {}),
  ...(h.autonomy !== null ? { autonomy: true } : {}),
  ...extra,
});

// 1. single-turn: identity + a final message + clean done.
const single = async (h: HarnessDescriptor): Promise<Cell> => {
  const events = await collect(streamTurn(h, opts(h), nodeRunnerDeps()));
  const ok = idOf(events) !== null && textOf(events).length > 0 && doneOf(events) === "clean";
  return {
    status: ok ? "pass" : "fail",
    detail: `done=${doneOf(events)} text="${textOf(events).slice(0, 30)}"`,
  };
};

// 2. streaming-fidelity: token-granular harnesses stream deltas that
//    reconstruct the message.
const streaming = async (h: HarnessDescriptor): Promise<Cell> => {
  if (h.capabilities.streamingByMode["headless-turn"] !== "token") {
    return { status: "skip", detail: "not token-granular" };
  }
  const events = await collect(
    streamTurn(h, opts(h, { prompt: "Count: one two three" }), nodeRunnerDeps()),
  );
  const tokenText = events
    .filter((e): e is Extract<HarnessEvent, { kind: "token" }> => e.kind === "token")
    .map((e) => e.text)
    .join("");
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const message = textOf(events);
  // Fidelity: the streamed tokens must reconstruct the final message, not
  // merely be present - one should contain the other once whitespace is
  // normalized away.
  const recon = norm(tokenText);
  const msg = norm(message);
  const ok = recon.length > 0 && msg.length > 0 && (recon.includes(msg) || msg.includes(recon));
  return {
    status: ok ? "pass" : "fail",
    detail: `tokens="${tokenText.slice(0, 24)}" msg="${message.slice(0, 24)}"`,
  };
};

// 3. tool-use: a shell tool invocation is decoded.
const toolUse = async (h: HarnessDescriptor): Promise<Cell> => {
  const events = await collect(
    streamTurn(
      h,
      opts(h, { prompt: "Run the shell command: echo seventest. Report output." }),
      nodeRunnerDeps(),
    ),
  );
  const tools = events.filter((e) => e.kind === "tool");
  return { status: tools.length > 0 ? "pass" : "fail", detail: `${tools.length} tool events` };
};

// 4. session-continuity: one process, two turns, the second recalls the first.
const sessionContinuity = async (h: HarnessDescriptor): Promise<Cell> => {
  if (h.sessionMode === null) return { status: "skip", detail: "no session mode" };
  const session = openSession(
    h,
    { sessionId: randomUUID(), ...(modelFor(h) ? { model: modelFor(h) } : {}) },
    nodeRunnerDeps(),
  );
  const turns = session.turns[Symbol.asyncIterator]();
  session.send("Remember the codeword: kestrel. Reply with only: OK");
  await collect((await turns.next()).value as AsyncIterable<HarnessEvent>);
  session.send("Reply with only the codeword.");
  const t2 = await collect((await turns.next()).value as AsyncIterable<HarnessEvent>);
  await session.close();
  const ok = textOf(t2).toLowerCase().includes("kestrel");
  return { status: ok ? "pass" : "fail", detail: `recall="${textOf(t2).slice(0, 30)}"` };
};

// 5. resume-continuity: turn 1 sets a codeword, a separate resumed turn
//    recalls it (caller-assigned id, or the minted id for codex).
const resumeContinuity = async (h: HarnessDescriptor): Promise<Cell> => {
  const first = await collect(
    streamTurn(
      h,
      opts(h, { prompt: "Remember the codeword: marlin. Reply with only: OK", resume: undefined }),
      nodeRunnerDeps(),
    ),
  );
  const sid = idOf(first);
  if (sid === null) return { status: "fail", detail: "no session id from turn 1" };
  // A genuine end-to-end resume test: turn 1 launches fresh (no id passed),
  // the harness self-assigns and announces its id and persists the session
  // under it; turn 2 resumes THAT announced id. The model cannot guess the
  // codeword, so recall proves the session context was actually carried.
  const second = await collect(
    streamTurn(
      h,
      opts(h, { prompt: "Reply with only the codeword.", resume: sid }),
      nodeRunnerDeps(),
    ),
  );
  const ok = textOf(second).toLowerCase().includes("marlin");
  return {
    status: ok ? "pass" : "fail",
    detail: `resumed ${sid.slice(0, 8)} recall="${textOf(second).slice(0, 24)}"`,
  };
};

// 6. kill-and-resume: abandon a turn mid-stream, resume, session survives.
const killResume = async (h: HarnessDescriptor): Promise<Cell> => {
  // Needs resumability, NOT a persistent session mode - every harness here
  // resumes, so every harness can be killed mid-turn and resumed.
  const first = await collect(
    streamTurn(h, opts(h, { prompt: "Remember: otter. Reply OK" }), nodeRunnerDeps()),
  );
  const sid = idOf(first);
  if (sid === null) return { status: "fail", detail: "no id" };
  // Abandon an in-progress turn: break after the turn has started but
  // before it reaches `done`. Streaming harnesses break mid-token-stream;
  // codex (no token deltas) breaks after turn.started, mid-thinking.
  let abandonedAt = 0;
  let reachedDone = false;
  for await (const e of streamTurn(
    h,
    opts(h, { prompt: "Count slowly from 1 to 40, one per line.", resume: sid }),
    nodeRunnerDeps(),
  )) {
    if (e.kind === "done") {
      reachedDone = true;
      break;
    }
    if (++abandonedAt >= 2) break; // in-progress: kill it here
  }
  const resumed = await collect(
    streamTurn(
      h,
      opts(h, { prompt: "Reply with only the word from before.", resume: sid }),
      nodeRunnerDeps(),
    ),
  );
  const recalled = textOf(resumed).toLowerCase().includes("otter");
  const abandoned = !reachedDone && abandonedAt >= 2;
  return {
    status: recalled && abandoned ? "pass" : "fail",
    detail: `${abandoned ? `killed@${abandonedAt}ev` : "not abandoned"} recall="${textOf(resumed).slice(0, 20)}"`,
  };
};

// 7. error-propagation: an unspawnable binary yields error + crash 127.
const errorProp = async (h: HarnessDescriptor): Promise<Cell> => {
  const broken = { ...h, bin: "definitely-not-real-xyz" };
  const events = await collect(streamTurn(broken, opts(h), nodeRunnerDeps()));
  const done = events.at(-1);
  const ok =
    done?.kind === "done" &&
    done.cause === "crash" &&
    done.exitCode === 127 &&
    events.some((e) => e.kind === "error");
  return {
    status: ok ? "pass" : "fail",
    detail: `done=${doneOf(events)} err=${events.some((e) => e.kind === "error")}`,
  };
};

const SCENARIOS: Array<[string, (h: HarnessDescriptor) => Promise<Cell>]> = [
  ["single-turn", single],
  ["streaming", streaming],
  ["tool-use", toolUse],
  // "1proc" = one persistent process, many turns (openSession). Distinct
  // from resume-continuity below (continuity across separate processes),
  // which every harness supports. The n/a here means no persistent-session
  // mode, NOT no continuity.
  ["session-cont(1proc)", sessionContinuity],
  ["resume-continuity", resumeContinuity],
  ["kill-and-resume", killResume],
  ["error-prop", errorProp],
];

for (const h of HARNESSES) {
  for (const [name, fn] of SCENARIOS) {
    try {
      record(h.name, name, await withTimeout(fn(h)));
    } catch (cause) {
      record(h.name, name, { status: "fail", detail: String(cause).slice(0, 60) });
    }
  }
}

// Render matrix.
const scenarioNames = SCENARIOS.map(([n]) => n);
const mark = (c: Cell): string => (c.status === "pass" ? "✓" : c.status === "skip" ? "–" : "✗");
console.log(`\n${"scenario".padEnd(22)}${HARNESSES.map((h) => h.name.padEnd(7)).join("")}`);
for (const s of scenarioNames) {
  console.log(
    `${s.padEnd(22)}${HARNESSES.map((h) => `${mark(results[h.name]?.[s] ?? { status: "fail", detail: "" })}      `).join("")}`,
  );
}

mkdirSync(".smoke", { recursive: true });
writeFileSync(
  ".smoke/seven.json",
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2),
);

const cells = HARNESSES.flatMap((h) => scenarioNames.map((s) => results[h.name]?.[s]));
const failed = cells.filter((c) => c?.status === "fail").length;
const passed = cells.filter((c) => c?.status === "pass").length;
const skipped = cells.filter((c) => c?.status === "skip").length;
console.log(`\n${passed} pass, ${skipped} n/a, ${failed} fail`);
if (failed > 0) process.exit(1);
