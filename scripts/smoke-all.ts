/**
 * Multi-harness compatibility smoke: drives claude, codex, pi, and muse
 * through the REAL runner (execution layer + node adapter) and asserts the
 * runner decodes each harness's identity announcement and reaches a
 * terminal `done`. Compatibility, not proof: on-demand, nondeterministic,
 * never in the deterministic suite. Evidence -> .smoke/all-harnesses.json.
 *
 * The core assertion per harness is identity: a harness whose real event
 * stream announces its session id the way the descriptor claims is
 * "compatible"; the model's actual answer is secondary. A usage/limit wall
 * is a valid terminal outcome (over quota), never a smoke failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HarnessEvent } from "../src/execution/events.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import { streamTurn, type TurnRunOptions } from "../src/execution/stream-turn.js";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";

// D-025: a child harness must not inherit Herdr's environment.
delete process.env.HERDR_ENV;

const TIMEOUT_MS = 180_000;
const boundaryLog: Record<string, unknown>[] = [];
const deps = () => nodeRunnerDeps({ log: (e) => boundaryLog.push(e) });

/** Drain the turn, but on deadline BREAK the iteration - which triggers the
 * runner's abandonment cleanup (SIGTERM->SIGKILL), so a hung harness is
 * killed, not merely abandoned. */
const collectWithDeadline = async (
  name: string,
  turn: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  const deadline = Date.now() + TIMEOUT_MS;
  for await (const e of turn) {
    out.push(e);
    if (Date.now() > deadline) {
      out.push({ kind: "error", message: `${name} exceeded ${TIMEOUT_MS}ms; aborted` });
      break; // the generator's finally kills the child
    }
  }
  return out;
};

const cliVersion = (bin: string): string => {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return (out.split("\n")[0] ?? "unknown").trim();
  } catch {
    return "unknown";
  }
};

interface Report {
  harness: string;
  pass: boolean;
  identityId: string | null;
  messageChars: number;
  tokenEvents: number;
  doneCause: string | null;
  detail: string;
}

const results: Report[] = [];

const smokeHeadlessTurn = async (h: HarnessDescriptor, opts: TurnRunOptions): Promise<void> => {
  try {
    const events = await collectWithDeadline(h.name, streamTurn(h, opts, deps()));
    const identity = events.find((e) => e.kind === "identity");
    const identityId = identity?.kind === "identity" ? identity.sessionId : null;
    const messageChars = events
      .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
      .reduce((n, e) => n + e.text.length, 0);
    const tokenEvents = events.filter((e) => e.kind === "token").length;
    const done = events.at(-1);
    const doneCause = done?.kind === "done" ? done.cause : null;
    const errored = events.some((e) => e.kind === "error");
    const limited = events.some((e) => e.kind === "limit");

    // Compatibility = the runner decoded a session identity, decoded a
    // final assistant MESSAGE, and reached a clean done. Requiring the
    // message (not just tokens) is what catches muse's exit-0-on-failure
    // scar: a failed run streams tokens then a run_terminal:"failed" error
    // with no completed message. A benign error item alongside a real
    // message (codex's skills-budget notice) is fine; a limit wall is an
    // acceptable terminal outcome (over quota).
    const cleanish = doneCause === "clean" || doneCause === "limit";
    const pass = identityId !== null && (limited || (cleanish && messageChars > 0));

    results.push({
      harness: h.name,
      pass,
      identityId,
      messageChars,
      tokenEvents,
      doneCause,
      detail: errored ? "error event present" : limited ? "limit wall (acceptable)" : "ok",
    });
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${h.name}: id=${identityId ? "yes" : "NONE"} msgChars=${messageChars} tokens=${tokenEvents} done=${doneCause} ${errored ? "[error]" : ""}`,
    );
  } catch (cause) {
    results.push({
      harness: h.name,
      pass: false,
      identityId: null,
      messageChars: 0,
      tokenEvents: 0,
      doneCause: null,
      detail: String(cause),
    });
    console.log(`FAIL  ${h.name}: ${String(cause)}`);
  }
};

const prompt = "Reply with only the single word: alpha";
const cwd = process.cwd(); // a git repo, so codex's trust check passes

await smokeHeadlessTurn(claudeCode, { prompt, model: "sonnet", cwd });
await smokeHeadlessTurn(codexCli, { prompt, cwd });
await smokeHeadlessTurn(piCli, { prompt, cwd });
await smokeHeadlessTurn(museCode, { prompt, autonomy: true, cwd });

mkdirSync(".smoke", { recursive: true });
writeFileSync(
  ".smoke/all-harnesses.json",
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      versions: {
        claude: cliVersion("claude"),
        codex: cliVersion("codex"),
        pi: cliVersion("pi"),
        muse: cliVersion("muse"),
      },
      results,
      boundaryEvents: boundaryLog.length,
    },
    null,
    2,
  ),
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} harnesses compatible`);
if (failed.length > 0) process.exit(1);
