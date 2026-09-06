/**
 * A hands-on demo of the runner: drive any harness with your own prompt and
 * watch the normalized HarnessEvent stream render live. Not a test - a way
 * to SEE the library work. Rendering is the CLI's own (src/cli/render.ts);
 * this script only wires a prompt to a runner.
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
import { createRenderState, renderEvent } from "../src/cli/render.js";
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
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const runOnce = async (
  h: HarnessDescriptor,
  prompt: string,
  model: string | undefined,
): Promise<void> => {
  process.stdout.write(`\n${cyan(`▶ ${h.name}`)} ${dim(prompt)}\n`);
  const state = createRenderState();
  const opts = {
    prompt,
    cwd: process.cwd(),
    ...(model !== undefined ? { model } : {}),
    ...(h.autonomy !== null ? { autonomy: true } : {}),
  };
  for await (const event of streamTurn(h, opts, nodeRunnerDeps())) renderEvent(event, state);
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
      const state = createRenderState();
      for await (const event of turn) renderEvent(event, state);
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
