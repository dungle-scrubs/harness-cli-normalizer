/**
 * A hands-on demo of the runner: drive any harness with your own prompt and
 * watch the normalized HarnessEvent stream render live. Not a test - a way
 * to SEE the library work.
 *
 *   bun run demo claude "explain a monad in one sentence"
 *   bun run demo codex  "what is 2+2"
 *   bun run demo pi     "name three primes"      # uses pi's default provider
 *   bun run demo muse   "say hi"
 *   bun run demo --chat claude                    # interactive session (claude)
 *
 * Flags: --model <id>, --chat (session mode, claude only).
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { HarnessEvent } from "../src/execution/events.js";
import { nodeRunnerDeps } from "../src/execution/node-deps.js";
import { openSession } from "../src/execution/open-session.js";
import { streamTurn } from "../src/execution/stream-turn.js";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";

// D-025: a child harness must not inherit Herdr's environment.
delete process.env.HERDR_ENV;

const DESCRIPTORS: Record<string, HarnessDescriptor> = {
  claude: claudeCode,
  codex: codexCli,
  pi: piCli,
  muse: museCode,
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Render one event live. Tokens stream inline; a message prints in full
 * only when no tokens preceded it (harnesses without token granularity). */
const render = (event: HarnessEvent, state: { streamed: boolean }): void => {
  switch (event.kind) {
    case "identity":
      process.stdout.write(dim(`  ● session ${event.sessionId} (${event.authority})\n`));
      break;
    case "token":
      process.stdout.write(event.text);
      state.streamed = true;
      break;
    case "message":
      if (!state.streamed) process.stdout.write(event.text);
      break;
    case "tool":
      process.stdout.write(cyan(`\n  ⚙ ${event.name}`));
      break;
    case "progress":
      // Droppable filler (claude emits many hook_* system lines); the
      // streaming tokens already show liveness, so keep the view clean.
      break;
    case "context":
      process.stdout.write(dim(`\n  ▪ context ${event.usedPct}%`));
      break;
    case "limit":
      process.stdout.write(yellow(`\n  ⚠ limit: ${event.code}`));
      break;
    case "error":
      process.stdout.write(red(`\n  ✗ ${event.message}`));
      break;
    case "done": {
      const mark = event.cause === "clean" ? green("○ clean") : red(`○ ${event.cause}`);
      process.stdout.write(`\n  ${mark} (exit ${event.exitCode ?? "none"})\n`);
      break;
    }
  }
};

const runOnce = async (
  h: HarnessDescriptor,
  prompt: string,
  model: string | undefined,
): Promise<void> => {
  process.stdout.write(`\n${cyan(`▶ ${h.name}`)} ${dim(prompt)}\n`);
  const state = { streamed: false };
  const opts = {
    prompt,
    cwd: process.cwd(),
    ...(model !== undefined ? { model } : {}),
    ...(h.autonomy !== null ? { autonomy: true } : {}),
  };
  for await (const event of streamTurn(h, opts, nodeRunnerDeps())) render(event, state);
};

const chat = async (h: HarnessDescriptor): Promise<void> => {
  if (h.sessionMode === null) {
    process.stdout.write(red(`${h.name} has no session mode; use single-shot instead.\n`));
    return;
  }
  const sessionId = randomUUID();
  const session = openSession(h, { sessionId }, nodeRunnerDeps());
  process.stdout.write(
    dim(`interactive ${h.name} session ${sessionId}\n(empty line or "exit" to quit)\n`),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const turns = session.turns[Symbol.asyncIterator]();
  try {
    while (true) {
      const line = (await rl.question(cyan("\nyou › "))).trim();
      if (line === "" || line === "exit") break;
      session.send({ id: `demo-${Date.now()}`, text: line });
      const turn = (await turns.next()).value as AsyncIterable<HarnessEvent> | undefined;
      if (turn === undefined) break;
      const state = { streamed: false };
      for await (const event of turn) render(event, state);
    }
  } finally {
    rl.close();
    await session.close();
  }
};

const argv = process.argv.slice(2);
const isChat = argv.includes("--chat");
const modelAt = argv.indexOf("--model");
const model = modelAt !== -1 ? argv[modelAt + 1] : undefined;
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--model");
const harnessName = positional[0];
const prompt = positional.slice(1).join(" ");

const h = harnessName !== undefined ? DESCRIPTORS[harnessName] : undefined;
if (h === undefined) {
  process.stdout.write(
    `usage: bun run demo [--chat] [--model <id>] <${Object.keys(DESCRIPTORS).join("|")}> "<prompt>"\n`,
  );
  process.exit(1);
}

if (isChat) {
  await chat(h);
} else if (prompt === "") {
  process.stdout.write(red('give a prompt, e.g. bun run demo claude "hello"\n'));
  process.exit(1);
} else {
  await runOnce(h, prompt, model);
}
