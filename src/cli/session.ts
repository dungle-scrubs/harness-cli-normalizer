import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { CLOSE_GRACE_MS, openSession } from "../execution/open-session.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import { createRenderState, renderEvent } from "./render.js";
import { resolveHarness } from "./resolve-harness.js";

export const session = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  // Only claude supported
  if (harnessName !== "claude") {
    const err = new ArgvRefusalError({
      issue: "no-session-mode",
      harness: harnessName as "claude",
      supported: ["claude"],
      detail: `session is claude-only; ${harnessName} declares no persistent headless session mode`,
    });
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`supported: claude\n`);
    process.exitCode = 2;
    return;
  }

  const h = resolveHarness(harnessName);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { SESSION_HELP } = await import("./help.js");
    process.stdout.write(SESSION_HELP);
    return;
  }

  const { parseCommonFlags } = await import("./args.js");
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unknown flag: ${message}\n`);
    process.exitCode = 2;
    return;
  }

  const values = parsed.values as Record<string, unknown>;
  const sessionId =
    (values["session-id"] as string | undefined) ??
    (values.resume as string | undefined) ??
    randomUUID();
  const model = values.model as string | undefined;
  const cwd = values.cwd as string | undefined;

  // Validate sessionId shape? let openSession handle via assertUsableSessionId
  delete (process.env as Record<string, string | undefined>).HERDR_ENV;

  const deps = nodeRunnerDeps();

  let handle: ReturnType<typeof openSession>;
  try {
    handle = openSession(h, { sessionId, model, cwd }, deps);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `could not open session: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `interactive ${h.name} session ${sessionId}\n(empty line or "exit" to quit)\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Handle SIGINT to close session cleanly
  let closing = false;
  const doClose = async () => {
    if (closing) return;
    closing = true;
    try {
      // race with CLOSE_GRACE_MS ? openSession's close does escalation internally, but we add outer guard
      const timeout = setTimeout(() => {
        process.stderr.write(`close timed out after ${CLOSE_GRACE_MS}ms\n`);
      }, CLOSE_GRACE_MS + 1000);
      await handle.close();
      clearTimeout(timeout);
    } catch (err) {
      process.stderr.write(`close failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.close();
  };
  process.on("SIGINT", doClose);
  process.on("SIGTERM", doClose);

  const turns = handle.turns[Symbol.asyncIterator]();
  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("you › ");
      } catch {
        // readline closed (Ctrl-D)
        break;
      }
      const trimmed = line.trim();
      if (trimmed === "" || trimmed === "exit") break;

      const result = handle.send(line);
      if (result.disposition === "queued") {
        process.stderr.write(`disposition: queued (turn in progress)\n`);
      }

      const turn = (await turns.next()).value as
        | AsyncIterable<import("../execution/events.js").HarnessEvent>
        | undefined;
      if (turn === undefined) break;
      const state = createRenderState();
      for await (const event of turn) {
        renderEvent(event, state);
      }
    }
  } catch (err) {
    process.stderr.write(`session error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", doClose);
    process.off("SIGTERM", doClose);
    try {
      await doClose();
    } catch {}
    rl.close();
  }
};
